// src/agents/usage.ts
// What Overseer saves a Claude Code session, measured from the session's
// transcript (~/.claude/projects/<project>/<session>.jsonl, which the hook
// records the path of in .overseer/sessions.jsonl).
//
// The tokens used are exact: the transcript keeps each API request's usage.
// The tokens the session would have used without Overseer can't be observed,
// so they're estimated from what Overseer changed in it:
//   - a Grep answered from the lookup table: what the Grep would have printed,
//     less the answer (nothing saved if the agent ran the Grep again anyway);
//   - a Read of a line range the table pointed to: the whole file, less the range;
//   - Overseer's own text (the session hint, table lookups and answers) counts
//     against it.
// Text kept out of the conversation is re-sent with every later request until
// the context is compacted, so each difference counts once per later request.
// No vscode imports, so the tests use it directly.

import * as path from 'path';
import picomatch from 'picomatch';
import type { SessionUsage } from '../types';
import { ANSWER_HEAD, LOOKUP_FILE, LOOKUP_HINT, searchedName, type GrepInput } from './lookup';

/** A rough average for code and English: the transcript has the API's counts, not the text's. */
export const CHARS_PER_TOKEN = 4;
/** Claude Code's Read stops here when no limit is given. */
const READ_MAX_LINES = 2000;
/** And its Grep here, when no head_limit is given. */
const GREP_HEAD_LIMIT = 250;
/** ripgrep's long lines are cut to this many characters in Claude Code's output. */
const GREP_MAX_COLUMNS = 500;
/** A ranged Read starting this many lines before a span the table gave (or one after) was pointed to it. */
const READ_LEAD = 5;

/** What the estimate needs from the workspace, at the time it's measured. */
export interface Workspace {
    /** The characters a Grep would have printed, or undefined when that can't be told. */
    grepChars(input: Record<string, unknown>, cwd: string): Promise<number | undefined>;
    /** A file's line count, or undefined when it's gone. */
    lineCount(file: string): Promise<number | undefined>;
}

interface Line {
    type?: string;
    subtype?: string;
    isSidechain?: boolean;
    timestamp?: string;
    sessionId?: string;
    cwd?: string;
    aiTitle?: string;
    message?: { id?: string; content?: unknown; usage?: Record<string, unknown> };
}

interface ToolUse {
    name: string;
    input: Record<string, unknown>;
}

/** A tool's result, and how many later requests carried it. */
interface Result {
    use: ToolUse;
    text: string;
    later: number;
}

export async function measureSession(transcript: string, root: string, ws: Workspace): Promise<SessionUsage | undefined> {
    const lines: Line[] = [];
    for (const raw of transcript.split('\n')) {
        try {
            if (raw.trim()) {
                lines.push(JSON.parse(raw) as Line);
            }
        } catch {
            // a torn last line
        }
    }

    // Requests in order, the context segments compaction splits them into, and each tool result's place.
    const usage = new Map<string, Record<string, unknown>>();
    const uses = new Map<string, ToolUse>();
    const pending: { use: ToolUse; text: string; at: number; segment: number }[] = [];
    const segmentEnds: number[] = [];
    let id = '';
    let title: string | undefined;
    let start = 0;
    let end = 0;
    let hinted = false;
    let cwd = root;
    for (const l of lines) {
        const t = l.timestamp ? Date.parse(l.timestamp) : NaN;
        if (!Number.isNaN(t)) {
            start ||= t;
            end = t;
        }
        id ||= l.sessionId ?? '';
        cwd = l.cwd ?? cwd;
        if (l.type === 'ai-title' && l.aiTitle) {
            title = l.aiTitle;
        }
        if (l.type === 'system' && l.subtype === 'compact_boundary') {
            segmentEnds.push(usage.size);
            continue;
        }
        if (l.isSidechain) {
            continue; // a subagent's turns aren't this conversation's context
        }
        const content = Array.isArray(l.message?.content) ? (l.message.content as Record<string, unknown>[]) : [];
        if (l.type === 'assistant' && l.message?.id && l.message.usage) {
            usage.set(l.message.id, l.message.usage); // a message's lines repeat its usage; the last is final
            for (const c of content) {
                if (c.type === 'tool_use' && typeof c.id === 'string' && typeof c.name === 'string') {
                    uses.set(c.id, { name: c.name, input: (c.input as Record<string, unknown>) ?? {} });
                }
            }
        } else if (l.type === 'user') {
            for (const c of content) {
                const use = c.type === 'tool_result' && typeof c.tool_use_id === 'string' ? uses.get(c.tool_use_id) : undefined;
                if (use) {
                    pending.push({ use, text: resultText(c.content), at: usage.size, segment: segmentEnds.length });
                }
            }
        }
        // The hook's context lands on a line of its own; a tool result quoting the hint (Overseer's own source, say) isn't it.
        if (!hinted && l.type !== 'assistant' && l.type !== 'user' && JSON.stringify(l).includes(LOOKUP_HINT.slice(0, 60))) {
            hinted = true;
        }
    }
    if (!usage.size) {
        return undefined;
    }
    segmentEnds.push(usage.size);
    const results: Result[] = pending.map((p) => ({ use: p.use, text: p.text, later: segmentEnds[p.segment] - p.at }));

    let used = 0;
    for (const u of usage.values()) {
        used += ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'].reduce((s, k) => s + num(u[k]), 0);
    }

    let savedChars = 0;
    let spentChars = hinted ? LOOKUP_HINT.length * usage.size : 0;
    let answered = 0;
    let repeated = 0;
    let guidedReads = 0;
    let tableLookups = 0;
    /** Line ranges the table has shown, by workspace-relative file. */
    const pointed = new Map<string, number[]>();
    const rel = (file: string) => path.relative(root, path.resolve(cwd, file)).replace(/\\/g, '/');

    for (const [i, r] of results.entries()) {
        const { name, input } = r.use;
        if (name === 'Grep' && r.text.includes(ANSWER_HEAD)) {
            spentChars += r.text.length * r.later;
            addPointed(pointed, r.text);
            const key = grepKey(input);
            if (results.slice(i + 1).some((o) => o.use.name === 'Grep' && grepKey(o.use.input) === key && !o.text.includes(ANSWER_HEAD))) {
                repeated++;
                continue;
            }
            const would = searchedName(input as GrepInput) ? await ws.grepChars(input, cwd) : undefined;
            if (would !== undefined) {
                answered++;
                savedChars += would * r.later;
            }
            continue;
        }
        const target = typeof input.path === 'string' ? input.path : typeof input.file_path === 'string' ? input.file_path : '';
        if ((name === 'Grep' || name === 'Read') && rel(target) === LOOKUP_FILE) {
            tableLookups++;
            spentChars += r.text.length * r.later;
            addPointed(pointed, r.text);
            continue;
        }
        if (name === 'Read' && typeof input.offset === 'number' && target) {
            const starts = pointed.get(rel(target));
            const offset = input.offset;
            if (!starts?.some((s) => offset >= s - READ_LEAD && offset <= s + 1)) {
                continue;
            }
            const total = await ws.lineCount(path.resolve(cwd, target));
            const shown = r.text.split('\n').length;
            if (total !== undefined && shown > 0) {
                guidedReads++;
                const whole = Math.round((r.text.length * Math.min(total, READ_MAX_LINES)) / shown);
                savedChars += Math.max(0, whole - r.text.length) * r.later;
            }
        }
    }

    const saved = Math.round(savedChars / CHARS_PER_TOKEN);
    const spent = Math.round(spentChars / CHARS_PER_TOKEN);
    return { id, title, start, end, requests: usage.size, used, saved, spent, answered, repeated, guidedReads, tableLookups };
}

/** The text of a tool result: a string, or a list of text blocks. */
function resultText(content: unknown): string {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
    }
    return '';
}

/** The same key the hook uses to let a repeated Grep through. */
function grepKey(input: Record<string, unknown>): string {
    return JSON.stringify([input.pattern, input.path, input.glob, input.type]);
}

/** Record the `path:start-end` spans in some of the table's lines. */
function addPointed(pointed: Map<string, number[]>, text: string): void {
    for (const m of text.matchAll(/(?:^|[\s:])([\w.@/-]+\.[cm]?[jt]sx?):(\d+)(?:-\d+)?(?=\s|$)/gm)) {
        const list = pointed.get(m[1]) ?? [];
        list.push(Number(m[2]));
        pointed.set(m[1], list);
    }
}

function num(v: unknown): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// ---- what a Grep would have printed ---------------------------------------------------

/** ripgrep's file types for the code the table covers. */
const TYPE_EXTENSIONS: Record<string, string[]> = {
    ts: ['.ts', '.tsx', '.mts', '.cts'],
    typescript: ['.ts', '.tsx', '.mts', '.cts'],
    js: ['.js', '.jsx', '.mjs', '.cjs'],
    javascript: ['.js', '.jsx', '.mjs', '.cjs'],
};

/**
 * The length of Claude Code's Grep output for `input`, run over `files`
 * (absolute paths and their text): the matching files, matching lines or
 * counts, after head_limit. Undefined when the pattern isn't a JS regex.
 */
export function grepOutputChars(files: { path: string; text: string }[], input: Record<string, unknown>, cwd: string): number | undefined {
    let re: RegExp;
    try {
        re = new RegExp(String(input.pattern ?? ''), input['-i'] === true ? 'i' : '');
    } catch {
        return undefined;
    }
    const dir = path.resolve(cwd, typeof input.path === 'string' ? input.path : '.');
    const glob = typeof input.glob === 'string' ? picomatch(input.glob, { dot: true, basename: !input.glob.includes('/') }) : undefined;
    const exts = typeof input.type === 'string' ? TYPE_EXTENSIONS[input.type] : undefined;
    const mode = typeof input.output_mode === 'string' ? input.output_mode : 'files_with_matches';
    const limit = typeof input.head_limit === 'number' ? input.head_limit || Infinity : GREP_HEAD_LIMIT;
    const before = num(input['-B']) || num(input['-C']) || num(input.context);
    const after = num(input['-A']) || num(input['-C']) || num(input.context);

    const out: string[] = [];
    for (const f of files) {
        const inDir = path.relative(dir, f.path).replace(/\\/g, '/');
        if (inDir.startsWith('..') || path.isAbsolute(inDir) || (glob && !glob(inDir)) || (exts && !exts.includes(path.extname(f.path)))) {
            continue;
        }
        const shown = path.relative(cwd, f.path).replace(/\\/g, '/');
        const lines = f.text.split('\n');
        const hits = lines.flatMap((l, i) => (re.test(l) ? [i] : []));
        if (!hits.length) {
            continue;
        }
        if (mode === 'count') {
            out.push(`${shown}:${hits.length}`);
        } else if (mode === 'content') {
            for (const i of hits) {
                for (let j = Math.max(0, i - before); j <= Math.min(lines.length - 1, i + after); j++) {
                    out.push(`${shown}${j === i ? ':' : '-'}${j + 1}${j === i ? ':' : '-'}${lines[j].slice(0, GREP_MAX_COLUMNS)}`);
                }
            }
        } else {
            out.push(shown);
        }
        if (out.length >= limit) {
            break;
        }
    }
    const kept = out.slice(0, limit);
    return (mode === 'files_with_matches' ? `Found ${kept.length} files\n` : '').length + kept.join('\n').length;
}
