// src/agents/lookup.ts
// The code lookup table Overseer keeps in .overseer/lookup.md for connected AI
// agents, so they find code by grepping one small file instead of searching
// and reading whole files. One line per file (what it imports) and per class,
// interface, type, enum, function and method (its lines, signature, and what
// it calls and renders). Every line starts with its file, so a grep match
// stands on its own, and grepping a name finds both its definition and the
// lines that call it.
// No vscode imports, so the hook script and the tests use it directly.

import type { EdgeKind, GraphData, GraphNode } from '../types';

export const LOOKUP_FILE = '.overseer/lookup.md';

/** What agents are told at the start of a session (the Claude Code hook, the Cursor rule). */
export const LOOKUP_HINT =
    `This project has a code lookup table at ${LOOKUP_FILE}, kept current by Overseer: one line per file (what it imports) and one per class, function and method (path:start-end, signature, what it calls). ` +
    `To find where anything in the code is defined or used, your first step is a grep with the name as the pattern and "${LOOKUP_FILE}" itself as the path (.overseer/ is gitignored, so a folder-wide search skips it). ` +
    `Then read only the line ranges it gives, not whole files. Search the codebase itself only for what the table doesn't cover: strings, comments, styles and config.`;

/** Signatures past this length are cut, so one long parameter list doesn't cost a paragraph. */
const MAX_SIGNATURE = 160;

const SYMBOLS = new Set<GraphNode['kind']>(['class', 'interface', 'type', 'enum', 'function', 'method']);

/** The edges listed on a line, and how. Inheritance is already in a class's signature. */
const LISTED: Partial<Record<EdgeKind, string>> = { import: 'imports', call: 'calls', render: 'renders' };

export function renderLookup(graph: GraphData): string {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const targets = new Map<string, Map<EdgeKind, string[]>>();
    for (const e of graph.edges) {
        const target = byId.get(e.target);
        if (!target || !LISTED[e.kind]) {
            continue;
        }
        const name = e.kind === 'import' ? target.file : (target.qname ?? target.label) + (e.uncertain ? '?' : '');
        const kinds = targets.get(e.source) ?? new Map<EdgeKind, string[]>();
        kinds.set(e.kind, [...(kinds.get(e.kind) ?? []), name]);
        targets.set(e.source, kinds);
    }
    const related = (id: string) => {
        const kinds = targets.get(id);
        if (!kinds) {
            return '';
        }
        return [...kinds]
            .map(([kind, names]) => `  ${LISTED[kind]} ${[...new Set(names)].sort().join(', ')}`)
            .join('');
    };

    const rows = graph.nodes
        .filter((n) => n.kind === 'file' || SYMBOLS.has(n.kind))
        .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.kind === 'file' ? 0 : (a.line ?? 0)) - (b.kind === 'file' ? 0 : (b.line ?? 0))));
    const lines = rows.map((n) => {
        if (n.kind === 'file') {
            return n.file + related(n.id);
        }
        const span = n.endLine && n.endLine !== n.line ? `${n.line}-${n.endLine}` : `${n.line}`;
        return `${n.file}:${span}  ${head(n)}${n.exported ? ' (exported)' : ''}${related(n.id)}`;
    });

    const { files, truncated, maxFiles } = graph.stats;
    return [
        '# Code lookup table',
        '',
        `Written by Overseer from ${files} files${truncated ? ` (only the first ${maxFiles}; raise overseer.maxFiles for the rest)` : ''}, and rewritten when files change.`,
        'Each line starts with its file. Symbols give `path:start-end`, their signature and what they call and render (`?` marks a guess by method name). Grep a name to find where it is defined and what calls it, then read only those lines.',
        '',
        ...lines,
        '',
    ].join('\n');
}

/** `function load(id: string): Promise<User>`, `async Store.save(): void`, `class Store extends Base`. */
function head(n: GraphNode): string {
    let sig = n.signature?.trim() || n.label;
    if (n.kind === 'function') {
        sig = sig.replace(/^(async\s+)?/, '$1function ');
    } else if (n.kind === 'method' && n.qname && n.qname !== n.label) {
        const at = sig.search(new RegExp(`(^|\\s)${escapeRegExp(n.label)}\\s*[(<]`));
        sig = at < 0 ? `${n.qname} ${sig}` : sig.slice(0, at) + sig.slice(at).replace(n.label, n.qname);
    }
    sig = sig.replace(/\s+/g, ' ');
    return sig.length > MAX_SIGNATURE ? sig.slice(0, MAX_SIGNATURE - 1) + '…' : sig;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- answering searches (overseer.answerSearches) --------------------------------

/** Grep patterns the table can answer: a name or `Class.method`, optionally between `\b`s. */
const NAME_PATTERN = /^(?:\\b)?([A-Za-z_$][\w$]*(?:\\?\.[A-Za-z_$][\w$]*)?)(?:\\b)?$/;
/** ripgrep's `type` values for the files the table covers. */
const CODE_TYPES = ['js', 'ts', 'javascript', 'typescript'];
/** Lines of the table put in an answer, so a common name doesn't flood it. */
const MAX_ANSWER_LINES = 40;
/** How an answer starts, so the usage estimate (usage.ts) finds answers in a transcript. */
export const ANSWER_HEAD = `Overseer answered this search from its lookup table`;

/** Claude Code's Grep tool input, as far as answering it goes. */
export interface GrepInput {
    pattern?: unknown;
    path?: unknown;
    glob?: unknown;
    type?: unknown;
    '-i'?: unknown;
}

/**
 * The name a Grep looks for, when the table can answer it: a plain name (not
 * a regex or text), searched across folders (not one file), in code files.
 */
export function searchedName(input: GrepInput): string | undefined {
    const m = typeof input.pattern === 'string' ? NAME_PATTERN.exec(input.pattern) : null;
    if (!m) {
        return undefined;
    }
    if (typeof input.path === 'string' && /\.[A-Za-z0-9]+$/.test(input.path.replace(/[\\/]+$/, ''))) {
        return undefined; // one file: cheap already, and the agent chose it
    }
    if (typeof input.glob === 'string' && !/[jt]sx?|[cm][jt]s/.test(input.glob)) {
        return undefined;
    }
    if (typeof input.type === 'string' && !CODE_TYPES.includes(input.type)) {
        return undefined;
    }
    return m[1].replace('\\.', '.');
}

/**
 * What the agent gets instead of the Grep's output: the table's lines that
 * define the name, then those that use it. Undefined when the table doesn't
 * mention it, so the search goes ahead.
 */
export function answerSearch(name: string, table: string, ignoreCase = false): string | undefined {
    const word = new RegExp(`(^|[^\\w$])${escapeRegExp(name)}(?![\\w$])`, ignoreCase ? 'i' : '');
    // Entries are `path` or `path:lines`, then two spaces; the header's sentences have one.
    const hits = table.split('\n').filter((l) => !l.startsWith('#') && /^\S+(  |$)/.test(l) && word.test(l));
    if (!hits.length) {
        return undefined;
    }
    const defines = (l: string) => {
        const [where, head = ''] = l.split('  ');
        return where.includes(':') ? word.test(head) : word.test(where); // a file line's second part is its imports
    };
    const defs = hits.filter(defines);
    const uses = hits.filter((l) => !defines(l));
    const shown = [...defs, ...uses].slice(0, MAX_ANSWER_LINES);
    const more = hits.length - shown.length;
    return [
        `${ANSWER_HEAD} (${LOOKUP_FILE}), instead of grepping the code.`,
        ...(defs.length ? [`Defined:`, ...shown.filter((l) => defs.includes(l))] : []),
        ...(uses.length ? [`Used by (each line's "calls" or "imports" names it):`, ...shown.filter((l) => uses.includes(l))] : []),
        ...(more > 0 ? [`…and ${more} more lines: grep ${LOOKUP_FILE} for the rest.`] : []),
        '',
        'Read only the line ranges you need from these. To search the code anyway (strings, comments, other files), run the same Grep again and it will go through.',
    ].join('\n');
}

/** `.cursor/rules/overseer.mdc`: Cursor reads always-applied rules into every chat. */
export function cursorRule(): string {
    return `---\ndescription: Overseer's code lookup table\nalwaysApply: true\n---\n\n${LOOKUP_HINT}\n`;
}
