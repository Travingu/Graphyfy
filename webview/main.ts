// webview/main.ts
// The Graphyfy page: toolbar, canvas, legend and details panel, and the
// messages to and from the extension (src/types.ts).
//
// Modules: model.ts (what's open and visible), view.ts (Cytoscape canvas),
// layout.ts (ELK), details.ts (side panel), search.ts, theme.ts.

import './style.css';
import type { FromWebview, GraphData, ToWebview } from '../src/types';
import { renderDetails } from './details';
import { Model } from './model';
import { Search } from './search';
import { watchTheme } from './theme';
import { esc } from './util';
import { GraphView } from './view';

declare function acquireVsCodeApi(): { postMessage(m: FromWebview): void; getState(): SavedState | undefined; setState(s: SavedState): void };

interface SavedState {
    /** The workspace the open boxes belong to. */
    title?: string;
    open?: string[];
    selected?: string;
    details?: boolean;
}

/** Above this many nodes, "Expand all" would take ELK too long to be worth offering. */
const EXPAND_ALL_MAX = 1500;
/** Below this width the details panel moves under the graph (style.css) and the legend starts folded. */
const NARROW_WIDTH = 760;
/** Show the progress bar only for layouts that take long enough to notice. */
const PROGRESS_DELAY_MS = 150;

const vscode = acquireVsCodeApi();
const saved: SavedState = vscode.getState() ?? {};
const send = (m: FromWebview) => vscode.postMessage(m);

document.getElementById('app')!.innerHTML = `
  <header class="toolbar">
    <div class="search">
      <input id="search" class="input" type="text" placeholder="Search functions, classes and files" aria-label="Search the graph"
        role="combobox" aria-controls="search-results" aria-expanded="false" autocomplete="off" spellcheck="false">
      <kbd class="kbd" aria-hidden="true">/</kbd>
      <ul id="search-results" class="search-results" role="listbox" hidden></ul>
    </div>
    <p id="summary" class="summary"></p>
    <div class="toolbar-actions">
      <button id="fit" class="button" title="Fit the whole graph in view">Fit</button>
      <button id="expand" class="button" title="Open every file and class">Expand all</button>
      <button id="collapse" class="button" title="Close every file and class">Collapse all</button>
      <button id="refresh" class="button" title="Scan the workspace again">Rescan</button>
      <button id="toggle-details" class="button" aria-pressed="true" title="Show or hide the details panel">Details</button>
    </div>
  </header>
  <main id="main" class="main">
    <div class="canvas">
      <div id="progress" class="progress" hidden></div>
      <div id="graph" class="graph" aria-label="Code graph"></div>
      <div id="state" class="state"></div>
      <aside id="legend" class="legend">
        <button id="legend-toggle" class="legend-toggle" aria-expanded="true" aria-controls="legend-body">Legend</button>
        <div id="legend-body" class="legend-body">
          <ul class="legend-list">
            ${legendEdge('call', 'Calls')}
            ${legendEdge('render', 'Renders (JSX)')}
            ${legendEdge('import', 'Imports')}
            ${legendEdge('extends', 'Extends')}
            ${legendEdge('implements', 'Implements', '6 4')}
            ${legendEdge('call', 'Guessed by name', '2 4')}
          </ul>
          <ul class="legend-list legend-kinds">
            <li><span class="dot" data-kind="file"></span>File</li>
            <li><span class="dot" data-kind="class"></span>Class</li>
            <li><span class="dot" data-kind="interface"></span>Interface</li>
            <li><span class="dot" data-kind="function"></span>Function</li>
          </ul>
        </div>
      </aside>
    </div>
    <aside id="details" class="details" aria-label="Details"></aside>
  </main>`;

function legendEdge(kind: string, label: string, dash = ''): string {
    return `<li><svg class="legend-line" data-edge="${kind}" width="24" height="8" viewBox="0 0 24 8" aria-hidden="true">
      <line x1="0" y1="4" x2="18" y2="4" ${dash ? `stroke-dasharray="${dash}"` : ''}/><path d="M18 1 L24 4 L18 7 Z"/></svg>${label}</li>`;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const stateEl = $('state');
const detailsEl = $('details');
const progressEl = $('progress');
const refreshBtn = $<HTMLButtonElement>('refresh');
const expandBtn = $<HTMLButtonElement>('expand');

let model: Model | undefined;
let view: GraphView | undefined;
let selected: string | undefined = saved.selected;

const search = new Search($<HTMLInputElement>('search'), $('search-results'), (id) => focusNode(id));

function persist(): void {
    vscode.setState({
        title: model?.data.title ?? saved.title,
        open: model ? [...model.open] : saved.open,
        selected,
        details: !$('main').classList.contains('no-details'),
    });
}

// ---- states: skeleton, empty, error --------------------------------------------

function showSkeleton(message: string): void {
    const columns = [3, 4, 2]
        .map((n) => `<div class="skeleton-column">${'<div class="skeleton-box"></div>'.repeat(n)}</div>`)
        .join('');
    stateEl.innerHTML = `<div class="skeleton" aria-hidden="true">${columns}</div><p class="state-message" role="status">${esc(message)}</p>`;
    stateEl.hidden = false;
}

function showMessage(title: string, body: string, action?: string): void {
    stateEl.innerHTML = `<div class="state-card">
        <h2 class="state-title">${esc(title)}</h2>
        <p class="state-body">${body}</p>
        ${action ? `<button id="state-action" class="button primary">${esc(action)}</button>` : ''}
      </div>`;
    stateEl.hidden = false;
    document.getElementById('state-action')?.addEventListener('click', () => send({ type: 'refresh' }));
}

function setBusy(busy: boolean): void {
    progressEl.hidden = !busy;
    refreshBtn.disabled = busy;
    refreshBtn.textContent = busy ? 'Scanning…' : 'Rescan';
}

/** Run a layout change, with the progress bar if it takes a moment. */
async function withProgress(work: Promise<void>): Promise<void> {
    const timer = setTimeout(() => (progressEl.hidden = false), PROGRESS_DELAY_MS);
    try {
        await work;
    } finally {
        clearTimeout(timer);
        progressEl.hidden = refreshBtn.disabled ? false : true;
    }
}

// ---- selection and navigation ----------------------------------------------------

const detailsActions = {
    select: (id: string) => focusNode(id),
    openSource,
    toggleBox: (id: string) => (model?.isOpenBox(id) ? closeBox(id) : openBox(id)),
};

function select(id: string | undefined): void {
    selected = id && model?.nodes.has(id) ? id : undefined;
    view?.highlight(selected);
    if (model) {
        renderDetails(detailsEl, model, selected, detailsActions);
    }
    persist();
}

function openBox(id: string): void {
    if (!model || !view) {
        return;
    }
    model.openBox(id);
    select(id);
    void withProgress(view.update(id));
    persist();
}

function closeBox(id: string): void {
    if (!model || !view) {
        return;
    }
    model.closeBox(id);
    select(id);
    void withProgress(view.update(id));
    persist();
}

/** Open the boxes around a node, select it and pan to it. */
async function focusNode(id: string): Promise<void> {
    if (!model || !view || !model.nodes.has(id)) {
        return;
    }
    const hidden = !model.isVisible(id);
    model.reveal(id);
    if (hidden) {
        await withProgress(view.update());
    }
    select(id);
    view.center(id);
}

function openSource(id: string): void {
    const n = model?.nodes.get(id);
    if (n && n.kind !== 'dir') {
        send({ type: 'open', file: n.file, line: n.line ?? 1 });
    }
}

// ---- the graph ----------------------------------------------------------------------

function showGraph(data: GraphData): void {
    setBusy(false);
    $('main').classList.toggle('empty', !data.nodes.length);
    if (!data.nodes.length) {
        model = undefined;
        view?.cy.elements().remove();
        $('summary').textContent = '';
        renderEmptyDetails();
        showMessage(
            'No TypeScript or JavaScript files here',
            'Graphyfy reads <code>.ts</code>, <code>.tsx</code>, <code>.js</code> and <code>.jsx</code> files. Check the <code>graphyfy.include</code> and <code>graphyfy.exclude</code> settings, or open a folder with code in it.',
            'Scan again',
        );
        return;
    }
    stateEl.hidden = true;
    model = new Model(data, model ? model.open : saved.title === data.title ? saved.open : undefined);
    search.setModel(model);
    if (view) {
        view.setModel(model);
    } else {
        view = new GraphView($('graph'), model, {
            select,
            toggle: openBox,
            close: closeBox,
            openSource,
        });
        new ResizeObserver(() => view?.cy.resize()).observe($('graph'));
    }
    const s = data.stats;
    $('summary').textContent = [
        `${s.files} file${s.files === 1 ? '' : 's'}`,
        `${s.functions} function${s.functions === 1 ? '' : 's'}`,
        `${s.classes} class${s.classes === 1 ? '' : 'es'}`,
        s.truncated ? `first ${s.maxFiles} files only` : '',
    ]
        .filter(Boolean)
        .join(' · ');
    expandBtn.disabled = data.nodes.length > EXPAND_ALL_MAX;
    expandBtn.title = expandBtn.disabled ? `${data.nodes.length} nodes are too many to show at once. Open files one at a time.` : 'Open every file and class';
    void withProgress(view.update()).then(() => select(selected));
}

function renderEmptyDetails(): void {
    detailsEl.innerHTML = '';
}

window.addEventListener('message', (ev: MessageEvent<ToWebview>) => {
    const m = ev.data;
    switch (m.type) {
        case 'loading':
            if (model) {
                setBusy(true);
            } else {
                showSkeleton(m.message);
            }
            break;
        case 'graph':
            showGraph(m.data);
            break;
        case 'error':
            setBusy(false);
            if (!model) {
                showMessage("Couldn't build the graph", esc(m.message), 'Try again');
            }
            break;
        case 'focus':
            void focusNode(m.nodeId);
            break;
    }
});

// ---- toolbar and keyboard -------------------------------------------------------------

$('fit').addEventListener('click', () => view?.fit());
expandBtn.addEventListener('click', () => {
    if (model && view) {
        model.expandAll();
        void withProgress(view.update(undefined, true));
        persist();
    }
});
$('collapse').addEventListener('click', () => {
    if (model && view) {
        model.collapseAll();
        void withProgress(view.update(undefined, true));
        persist();
    }
});
refreshBtn.addEventListener('click', () => send({ type: 'refresh' }));

const detailsToggle = $('toggle-details');
function setDetailsVisible(visible: boolean): void {
    $('main').classList.toggle('no-details', !visible);
    detailsToggle.setAttribute('aria-pressed', String(visible));
    persist();
}
detailsToggle.addEventListener('click', () => setDetailsVisible($('main').classList.contains('no-details')));
setDetailsVisible(saved.details !== false);

const legendToggle = $('legend-toggle');
function setLegendOpen(open: boolean): void {
    legendToggle.setAttribute('aria-expanded', String(open));
    $('legend-body').hidden = !open;
}
legendToggle.addEventListener('click', () => setLegendOpen(legendToggle.getAttribute('aria-expanded') !== 'true'));
// In a narrow panel the legend would cover the graph, so it starts folded.
setLegendOpen(window.innerWidth >= NARROW_WIDTH);

document.addEventListener('keydown', (ev) => {
    const typing = ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement;
    if (ev.key === '/' && !typing) {
        ev.preventDefault();
        $('search').focus();
    } else if (ev.key === 'Escape' && !typing) {
        select(undefined);
    }
});

watchTheme(() => view?.restyle());

showSkeleton('Scanning TypeScript and JavaScript files…');
send({ type: 'ready' });
