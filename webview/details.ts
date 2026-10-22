// webview/details.ts
// The side panel: what the selected node is and everything it connects to,
// with exact relationships (not the bundled arrows on the canvas). Every row
// is a button that selects that node. When the graph shows a commit, the
// overview says which one and lists what it changed.

import type { Change, EdgeKind, GraphEdge, GraphNode, NodeKind, ViewInfo } from '../src/types';
import type { Model } from './model';
import { absoluteDate } from './timeline';
import { esc } from './util';

/** Rows shown per section before "and N more". */
const SECTION_MAX = 50;

const KIND_LABEL: Record<NodeKind, string> = {
    dir: 'Folder',
    file: 'File',
    class: 'Class',
    interface: 'Interface',
    type: 'Type',
    enum: 'Enum',
    function: 'Function',
    method: 'Method',
};

/** As VS Code's Source Control view marks files. */
const CHANGE_LABEL: Record<Change, { letter: string; word: string }> = {
    added: { letter: 'A', word: 'Added' },
    modified: { letter: 'M', word: 'Modified' },
    removed: { letter: 'D', word: 'Deleted' },
};

interface Section {
    title: string;
    rows: Array<{ id: string; uncertain?: boolean; n?: number }>;
}

export interface DetailsActions {
    select(id: string): void;
    openSource(id: string): void;
    toggleBox(id: string): void;
    diff(id: string): void;
}

export function renderDetails(el: HTMLElement, model: Model, id: string | undefined, actions: DetailsActions, view: ViewInfo): void {
    const node = id ? model.nodes.get(id) : undefined;
    el.innerHTML = node ? nodeHtml(model, node, view) : overviewHtml(model, view);
    el.scrollTop = 0;
    el.querySelectorAll<HTMLButtonElement>('[data-select]').forEach((b) => b.addEventListener('click', () => actions.select(b.dataset.select!)));
    el.querySelector<HTMLButtonElement>('[data-source]')?.addEventListener('click', () => actions.openSource(node!.id));
    el.querySelector<HTMLButtonElement>('[data-toggle]')?.addEventListener('click', () => actions.toggleBox(node!.id));
    el.querySelector<HTMLButtonElement>('[data-diff]')?.addEventListener('click', () => actions.diff(node!.id));
}

function changeTag(change: Change | undefined): string {
    return change ? `<span class="change-tag" data-change="${change}" title="${CHANGE_LABEL[change].word}">${CHANGE_LABEL[change].letter}</span>` : '';
}

/** The changed files and symbols, a section per kind of change. */
function changesHtml(model: Model, view: ViewInfo): string {
    const changes = model.data.stats.changes;
    if (!changes || !(changes.added + changes.modified + changes.removed)) {
        return view.kind === 'commit' ? '<p class="hint">This commit changed no TypeScript or JavaScript code.</p>' : '';
    }
    const byChange: Record<Change, string[]> = { added: [], modified: [], removed: [] };
    for (const n of model.data.nodes) {
        if (n.change) {
            byChange[n.change].push(n.id);
        }
    }
    const sections = (Object.keys(byChange) as Change[]).map((c) => sectionHtml(model, { title: CHANGE_LABEL[c].word, rows: byChange[c].map((id) => ({ id })) }));
    return `<section class="section">
        <h3 class="section-title">${view.kind === 'commit' ? 'Changed in this commit' : 'Uncommitted changes'}</h3>
        <p class="hint">${view.kind === 'commit' ? 'Compared with the commit before it.' : 'Saved files compared with the last commit.'}</p>
      </section>
      ${sections.join('')}`;
}

function overviewHtml(model: Model, view: ViewInfo): string {
    const s = model.data.stats;
    const errors = s.parseErrors.length
        ? `<section class="section">
             <h3 class="section-title">Partly parsed <span class="count">${s.parseErrors.length}</span></h3>
             <p class="hint">These files have syntax tree-sitter couldn't read. Everything else in them is in the graph.</p>
             <ul class="rows">${s.parseErrors.map((f) => `<li class="row static"><span class="row-name">${esc(f)}</span></li>`).join('')}</ul>
           </section>`
        : '';
    const head =
        view.kind === 'commit'
            ? `<header class="details-head">
                 <p class="eyebrow">Commit <code>${view.sha.slice(0, 7)}</code>${view.branch ? ` · ${esc(view.branch)}` : ''} · read-only</p>
                 <h2 class="title">${esc(view.subject || '(no message)')}</h2>
                 <p class="location">${esc(view.author)}${view.time ? ` · ${esc(absoluteDate(view.time))}` : ''}</p>
               </header>`
            : `<header class="details-head">
                 <p class="eyebrow">Workspace</p>
                 <h2 class="title">${esc(model.data.title)}</h2>
               </header>`;
    return `
      ${head}
      <dl class="stats">
        <div><dt>Files</dt><dd>${s.files}</dd></div>
        <div><dt>Functions</dt><dd>${s.functions}</dd></div>
        <div><dt>Classes</dt><dd>${s.classes}</dd></div>
        <div><dt>Relationships</dt><dd>${s.edges}</dd></div>
      </dl>
      ${changesHtml(model, view)}
      <section id="agents" class="section"></section>
      <section class="section">
        <h3 class="section-title">Getting around</h3>
        <ul class="tips">
          <li><b>Click</b> a file or class to open it.</li>
          <li><b>Click</b> a function to see what it calls and what calls it.</li>
          <li><b>Double-click</b> anything to go to its code.</li>
          <li><b>Ctrl+click</b> an open box to close it.</li>
          <li><b>/</b> to search, <b>Esc</b> to clear the selection.</li>
        </ul>
      </section>
      ${errors}`;
}

function nodeHtml(model: Model, n: GraphNode, view: ViewInfo): string {
    const location = n.kind === 'dir' ? esc(n.file) : `${esc(n.file)}${n.line && n.kind !== 'file' ? `:${n.line}` : ''}`;
    const flags = [n.exported && 'exported', n.isAsync && 'async', n.isStatic && 'static'].filter(Boolean) as string[];
    const box = model.isBox(n.id);
    const actions = [
        n.kind !== 'dir' ? `<button class="button primary" data-source>Go to code</button>` : '',
        box && n.kind !== 'dir' ? `<button class="button" data-toggle>${model.isOpenBox(n.id) ? 'Close' : 'Open'} in graph</button>` : '',
        n.change && n.change !== 'added' && n.kind !== 'dir'
            ? `<button class="button" data-diff>Compare with ${view.kind === 'commit' ? 'parent' : 'HEAD'}</button>`
            : '',
    ].join('');
    const change = n.change
        ? `<p class="change-note">${changeTag(n.change)}${
              n.change === 'removed'
                  ? view.kind === 'commit' ? 'Deleted by this commit. Shown as it was before.' : 'Deleted since the last commit, not yet committed. Shown as it was there.'
                  : `${CHANGE_LABEL[n.change].word} ${view.kind === 'commit' ? 'in this commit' : 'since the last commit, not yet committed'}`
          }</p>`
        : '';
    return `
      <header class="details-head">
        <p class="eyebrow"><span class="dot" data-kind="${n.kind}"></span>${KIND_LABEL[n.kind]}${flags.length ? ` · ${flags.join(' · ')}` : ''}</p>
        <h2 class="title">${esc(n.qname ?? n.label)}</h2>
        <p class="location">${location}</p>
      </header>
      ${change}
      ${n.signature && n.kind !== 'file' ? `<pre class="signature">${esc(n.signature)}</pre>` : ''}
      ${actions ? `<div class="actions">${actions}</div>` : ''}
      ${sectionsFor(model, n).map((s) => sectionHtml(model, s)).join('') || '<p class="hint">Nothing in the graph connects to this.</p>'}`;
}

function sectionsFor(model: Model, n: GraphNode): Section[] {
    const out = (kind: EdgeKind) => edgeRows(model.outgoing.get(n.id), kind, 'target');
    const inc = (kind: EdgeKind) => edgeRows(model.incoming.get(n.id), kind, 'source');
    const members = { title: n.kind === 'dir' ? 'Contents' : 'Members', rows: (model.children.get(n.id) ?? []).map((id) => ({ id })) };
    switch (n.kind) {
        case 'function':
        case 'method':
            return [
                { title: 'Calls', rows: out('call') },
                { title: 'Called by', rows: inc('call') },
                { title: 'Renders', rows: out('render') },
                { title: 'Rendered by', rows: inc('render') },
            ];
        case 'class':
            return [
                { title: 'Extends', rows: out('extends') },
                { title: 'Implements', rows: out('implements') },
                { title: 'Subclasses', rows: inc('extends') },
                { title: 'Constructed or rendered by', rows: [...constructedBy(model, n), ...inc('render')] },
                members,
            ];
        case 'interface':
            return [
                { title: 'Extends', rows: out('extends') },
                { title: 'Extended by', rows: inc('extends') },
                { title: 'Implemented by', rows: inc('implements') },
            ];
        case 'file':
            return [
                { title: 'Imports', rows: out('import') },
                { title: 'Imported by', rows: inc('import') },
                { title: 'Top-level code calls', rows: out('call') },
                members,
            ];
        case 'dir':
            return [members];
        default:
            return [];
    }
}

function edgeRows(edges: GraphEdge[] | undefined, kind: EdgeKind, end: 'source' | 'target'): Section['rows'] {
    return (edges ?? []).filter((e) => e.kind === kind).map((e) => ({ id: e[end], uncertain: e.uncertain, n: e.n }));
}

/** `new X()` calls reach X's constructor, or X itself when it has none. */
function constructedBy(model: Model, cls: GraphNode): Section['rows'] {
    const ctor = (model.children.get(cls.id) ?? []).find((id) => model.nodes.get(id)?.label === 'constructor');
    return [...edgeRows(model.incoming.get(cls.id), 'call', 'source'), ...(ctor ? edgeRows(model.incoming.get(ctor), 'call', 'source') : [])];
}

function sectionHtml(model: Model, s: Section): string {
    if (!s.rows.length) {
        return '';
    }
    const rows = s.rows.slice(0, SECTION_MAX).map((r) => {
        const n = model.nodes.get(r.id);
        if (!n) {
            return '';
        }
        const where = n.kind === 'dir' || n.kind === 'file' ? n.file : `${basename(n.file)}:${n.line ?? 1}`;
        const tags = [r.n && r.n > 1 ? `×${r.n}` : '', r.uncertain ? '<span class="guess" title="Matched by method name only: the receiver\'s type wasn\'t known">guess</span>' : ''].join(' ');
        return `<li><button class="row" data-select="${esc(n.id)}">
            <span class="dot" data-kind="${n.kind}"></span>
            <span class="row-name">${esc(n.qname ?? n.label)}</span>
            <span class="row-meta">${tags} ${esc(where)}</span>
            ${changeTag(n.change)}
          </button></li>`;
    });
    const more = s.rows.length > SECTION_MAX ? `<p class="hint">and ${s.rows.length - SECTION_MAX} more</p>` : '';
    return `<section class="section">
        <h3 class="section-title">${s.title} <span class="count">${s.rows.length}</span></h3>
        <ul class="rows">${rows.join('')}</ul>${more}
      </section>`;
}

function basename(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}
