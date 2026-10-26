// webview/main.ts
// The Overseer page: toolbar, canvas, legend, details panel and the Git
// history strip, and the messages to and from the extension (src/types.ts).
//
// Modules: model.ts (what's open and visible), view.ts (Cytoscape canvas),
// layout.ts (ELK), details.ts (side panel), search.ts, theme.ts,
// timeline.ts (history strip).

import './style.css';
import type { AgentEvent, FromWebview, GraphData, ToWebview, ViewInfo } from '../src/types';
import { AgentFeed, LIVE_WINDOW_MS } from './agents';
import { renderDetails } from './details';
import { Model } from './model';
import { Search } from './search';
import { watchTheme } from './theme';
import { Timeline, type TimelineTarget } from './timeline';
import { esc } from './util';
import { GraphView } from './view';

declare function acquireVsCodeApi(): { postMessage(m: FromWebview): void; getState(): SavedState | undefined; setState(s: SavedState): void };

interface SavedState {
    /** The workspace the open boxes belong to. */
    title?: string;
    open?: string[];
    selected?: string;
    details?: boolean;
    history?: boolean;
    historyHeight?: number;
    showChanges?: boolean;
    followAgent?: boolean;
}

/** Above this many nodes, "Expand all" would take ELK too long to be worth offering. */
const EXPAND_ALL_MAX = 1500;
/** Below this width the details panel moves under the graph (style.css) and the legend starts folded. */
const NARROW_WIDTH = 760;
/** Show the progress bar only for layouts that take long enough to notice. */
const PROGRESS_DELAY_MS = 150;
/** The history strip's height: default, smallest, and step for the keyboard. */
const HISTORY_HEIGHT = 168;
const HISTORY_MIN = 96;
const HISTORY_STEP = 16;

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
    <p id="agent-live" class="agent-live" role="status" hidden></p>
    <div class="toolbar-actions">
      <button id="fit" class="button" title="Fit the whole graph in view">Fit</button>
      <button id="expand" class="button" title="Open every file and class">Expand all</button>
      <button id="collapse" class="button" title="Close every file and class">Collapse all</button>
      <button id="refresh" class="button" title="Scan the workspace again">Rescan</button>
      <button id="toggle-history" class="button" aria-pressed="false" aria-controls="timeline" title="Show or hide the Git history">History</button>
      <button id="toggle-details" class="button" aria-pressed="true" title="Show or hide the details panel">Details</button>
    </div>
  </header>
  <div id="banner" class="banner" role="status" hidden></div>
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
          <div id="legend-changes" class="legend-list legend-kinds" hidden>
            <label class="legend-check"><input id="show-changes" type="checkbox" checked>Show changes</label>
            <ul class="legend-list" data-for="commit">
              <li><span class="swatch" data-change="added"></span>Added</li>
              <li><span class="swatch" data-change="modified"></span>Modified, or has changes inside</li>
              <li><span class="swatch" data-change="removed"></span>Deleted</li>
            </ul>
            <ul class="legend-list" data-for="worktree">
              <li><span class="swatch" data-change="modified"></span>Uncommitted change, or has some inside</li>
              <li><span class="swatch" data-change="removed"></span>Deleted, not yet committed</li>
            </ul>
          </div>
        </div>
      </aside>
    </div>
    <aside id="details" class="details" aria-label="Details"></aside>
  </main>
  <section id="timeline" class="timeline" aria-label="Git history" hidden>
    <div id="timeline-resize" class="timeline-resize" role="separator" aria-orientation="horizontal" aria-label="Resize the history" tabindex="0"></div>
    <header class="timeline-head">
      <h2 class="timeline-title">History</h2>
      <p id="timeline-meta" class="timeline-meta"></p>
      <p class="timeline-hint">Click a commit to see the code as it was. Arrow keys move along the timeline.</p>
    </header>
    <div class="timeline-body">
      <div id="timeline-scroll" class="timeline-scroll" tabindex="-1"></div>
    </div>
  </section>`;

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
const bannerEl = $('banner');
const showChangesBox = $<HTMLInputElement>('show-changes');

let model: Model | undefined;
let view: GraphView | undefined;
let selected: string | undefined = saved.selected;
/** The graph as the extension sent it, before "Show changes" filters out removed nodes. */
let graphData: GraphData | undefined;
let current: ViewInfo = { kind: 'worktree' };
let showChanges = saved.showChanges !== false;
/** The last view asked for: older answers are dropped, so fast clicks along the timeline settle on the last one. */
let requested = 0;
let pending: number | undefined;

const search = new Search($<HTMLInputElement>('search'), $('search-results'), (id) => focusNode(id));

const agentFeed = new AgentFeed(
    $('agent-live'),
    {
        connect: (agent) => send({ type: 'connectAgent', agent }),
        disconnect: (agent) => send({ type: 'disconnectAgent', agent }),
        show: (file) => {
            const id = targetFor(file);
            if (id) {
                void focusNode(id);
            }
        },
        follow: () => persist(),
    },
    saved.followAgent === true,
);

const timeline = new Timeline($('timeline-scroll'), $('timeline-meta'), {
    viewCommit: (sha, branch) => request({ type: 'viewCommit', sha, branch, seq: 0 }, sha),
    viewWorktree: () => request({ type: 'viewWorktree', seq: 0 }, 'worktree'),
});

function persist(): void {
    vscode.setState({
        title: model?.data.title ?? saved.title,
        open: model ? [...model.open] : saved.open,
        selected,
        details: !$('main').classList.contains('no-details'),
        history: !$('timeline').hidden,
        historyHeight: historyHeight(),
        showChanges,
        followAgent: agentFeed.following,
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
        progressEl.hidden = refreshBtn.disabled || pending !== undefined ? false : true;
    }
}

// ---- selection and navigation ----------------------------------------------------

const detailsActions = {
    select: (id: string) => focusNode(id),
    openSource,
    toggleBox: (id: string) => (model?.isOpenBox(id) ? closeBox(id) : openBox(id)),
    diff: (id: string) => {
        const n = model?.nodes.get(id);
        if (n && n.kind !== 'dir') {
            send({ type: 'diff', file: n.file, line: n.line ?? 1 });
        }
    },
};

function select(id: string | undefined): void {
    selected = id && model?.nodes.has(id) ? id : undefined;
    view?.highlight(selected);
    if (model) {
        renderDetails(detailsEl, model, selected, detailsActions, current);
        agentFeed.render();
    }
    persist();
}

// ---- AI agents ------------------------------------------------------------------------

/** The node that stands for a file an agent touched: the file, or the closed box or folder holding it. */
function targetFor(file: string): string | undefined {
    if (!model) {
        return undefined;
    }
    const id = `file:${file}`;
    if (model.nodes.has(id)) {
        return model.shownAs(id);
    }
    // Not a source file (README.md, package.json): the deepest folder holding it.
    let best: string | undefined;
    let bestLen = -1;
    for (const n of model.nodes.values()) {
        if (n.kind === 'dir' && file.startsWith(n.file + '/') && n.file.length > bestLen) {
            best = n.id;
            bestLen = n.file.length;
        }
    }
    return best ? model.shownAs(best) : undefined;
}

function onAgentActivity(events: AgentEvent[]): void {
    agentFeed.add(events);
    if (!selected) {
        agentFeed.render();
    }
    // The graph shows the working tree only: a past commit isn't what the agent is touching.
    if (!view || current.kind !== 'worktree') {
        return;
    }
    let follow: string | undefined;
    for (const e of events) {
        if (!e.inWorkspace || e.action === 'search' || Date.now() - e.t > LIVE_WINDOW_MS) {
            continue;
        }
        const id = targetFor(e.file);
        if (id) {
            view.pulse(id, e.agent, e.action);
            follow = id;
        }
    }
    if (follow && agentFeed.following) {
        view.center(follow);
    }
}

// Keep the feed's "2 minutes ago" current while the overview shows.
setInterval(() => {
    if (!selected) {
        agentFeed.render();
    }
}, 15000);

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
        // A removed node only exists in the version before.
        send({ type: 'open', file: n.file, line: n.line ?? 1, before: n.change === 'removed' });
    }
}

// ---- the graph ----------------------------------------------------------------------

function showGraph(data: GraphData, info: ViewInfo): void {
    setBusy(false);
    graphData = data;
    current = info;
    // style.css colors every change yellow in the working tree: it's all uncommitted.
    document.getElementById('app')!.dataset.view = info.kind;
    renderBanner();
    timeline.setSelected(info.kind === 'commit' ? info.sha : 'worktree');
    $('main').classList.toggle('empty', !data.nodes.length);
    if (!data.nodes.length) {
        model = undefined;
        view?.cy.elements().remove();
        $('summary').textContent = '';
        renderEmptyDetails();
        $('legend-changes').hidden = true;
        if (info.kind === 'commit') {
            showMessage('No TypeScript or JavaScript files in this commit', 'Pick a later commit on the timeline, or go back to the working tree.');
        } else {
            showMessage(
                'No TypeScript or JavaScript files here',
                'Overseer reads <code>.ts</code>, <code>.tsx</code>, <code>.js</code> and <code>.jsx</code> files. Check the <code>overseer.include</code> and <code>overseer.exclude</code> settings, or open a folder with code in it.',
                'Scan again',
            );
        }
        return;
    }
    stateEl.hidden = true;
    const changes = data.stats.changes;
    $('legend-changes').hidden = !changes || !(changes.added + changes.modified + changes.removed);
    applyModel();
    const s = data.stats;
    $('summary').textContent = [
        info.kind === 'commit' ? `at ${info.sha.slice(0, 7)}` : '',
        `${s.files} file${s.files === 1 ? '' : 's'}`,
        `${s.functions} function${s.functions === 1 ? '' : 's'}`,
        `${s.classes} class${s.classes === 1 ? '' : 'es'}`,
        s.truncated ? `first ${s.maxFiles} files only` : '',
    ]
        .filter(Boolean)
        .join(' · ');
}

/** Build the model from the graph (without removed nodes when changes are hidden) and lay it out. */
function applyModel(): void {
    if (!graphData) {
        return;
    }
    const data = showChanges ? graphData : { ...graphData, nodes: graphData.nodes.filter((n) => n.change !== 'removed') };
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
    view.showChanges = showChanges;
    view.uncommitted = current.kind === 'worktree';
    expandBtn.disabled = data.nodes.length > EXPAND_ALL_MAX;
    expandBtn.title = expandBtn.disabled ? `${data.nodes.length} nodes are too many to show at once. Open files one at a time.` : 'Open every file and class';
    void withProgress(view.update()).then(() => select(selected));
}

function renderEmptyDetails(): void {
    detailsEl.innerHTML = '';
}

/** "Viewing a commit" with the way back, and the switch for a branch that isn't checked out. */
function renderBanner(): void {
    if (current.kind !== 'commit') {
        bannerEl.hidden = true;
        bannerEl.innerHTML = '';
        return;
    }
    const c = current;
    bannerEl.innerHTML = `
      <p class="banner-text">Viewing <code>${c.sha.slice(0, 7)}</code>${c.branch ? ` on <b>${esc(c.branch)}</b>` : ''}<span class="banner-subject"> · ${esc(c.subject || '(no message)')}</span> · read-only</p>
      <div class="banner-actions">
        ${c.canSwitch && c.branch ? `<button id="banner-switch" class="button">Switch to ${esc(c.branch)}</button>` : ''}
        <button id="banner-back" class="button primary">Back to working tree</button>
      </div>`;
    bannerEl.hidden = false;
    document.getElementById('banner-back')!.addEventListener('click', () => request({ type: 'viewWorktree', seq: 0 }, 'worktree'));
    document.getElementById('banner-switch')?.addEventListener('click', () => send({ type: 'switchBranch', branch: c.branch! }));
}

/** Ask for a view of the graph. The progress bar runs until it arrives. */
function request(m: Extract<FromWebview, { seq: number }>, target: TimelineTarget): void {
    m.seq = pending = ++requested;
    timeline.setPending(target);
    progressEl.hidden = false;
    send(m);
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
            // While a view is on its way, only its answer counts.
            if (pending !== undefined && m.seq !== pending) {
                break;
            }
            pending = undefined;
            showGraph(m.data, m.view);
            break;
        case 'error':
            if (m.seq !== undefined && m.seq !== pending) {
                break;
            }
            pending = undefined;
            timeline.setPending(undefined);
            setBusy(false);
            if (!model) {
                showMessage("Couldn't build the graph", esc(m.message), 'Try again');
            }
            break;
        case 'focus':
            void focusNode(m.nodeId);
            break;
        case 'openHistory':
            setHistoryOpen(true);
            break;
        case 'history':
            timeline.setHistory(m.data);
            timeline.setSelected(current.kind === 'commit' ? current.sha : 'worktree');
            break;
        case 'historyError':
            timeline.showError(m.message);
            break;
        case 'agentStatus':
            agentFeed.setStatus(m.status);
            agentFeed.render();
            break;
        case 'agentActivity':
            onAgentActivity(m.events);
            break;
        case 'agentUsage':
            agentFeed.setUsage(m.sessions);
            agentFeed.render();
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

showChangesBox.checked = showChanges;
showChangesBox.addEventListener('change', () => {
    showChanges = showChangesBox.checked;
    persist();
    applyModel();
});

// ---- the history strip ------------------------------------------------------------------

const historyToggle = $('toggle-history');
const timelineEl = $('timeline');

function historyHeight(): number {
    return parseInt(getComputedStyle(document.documentElement).getPropertyValue('--timeline-height'), 10) || HISTORY_HEIGHT;
}

function setHistoryHeight(px: number): void {
    const max = Math.max(HISTORY_MIN, Math.round(window.innerHeight * 0.6));
    const h = Math.min(max, Math.max(HISTORY_MIN, Math.round(px / 4) * 4));
    document.documentElement.style.setProperty('--timeline-height', `${h}px`);
    $('timeline-resize').setAttribute('aria-valuenow', String(h));
}

function setHistoryOpen(open: boolean): void {
    timelineEl.hidden = !open;
    document.getElementById('app')!.classList.toggle('with-timeline', open);
    historyToggle.setAttribute('aria-pressed', String(open));
    if (open && !timeline.loaded) {
        timeline.showLoading();
        send({ type: 'loadHistory' });
    }
    persist();
}

historyToggle.addEventListener('click', () => setHistoryOpen(historyToggle.getAttribute('aria-pressed') !== 'true'));
setHistoryHeight(saved.historyHeight ?? HISTORY_HEIGHT);

// Drag the strip's top edge to resize it; Up and Down do the same from the keyboard.
const resizer = $('timeline-resize');
resizer.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    resizer.setPointerCapture(ev.pointerId);
    const startY = ev.clientY;
    const startH = historyHeight();
    const move = (e: PointerEvent) => setHistoryHeight(startH + (startY - e.clientY));
    const up = () => {
        resizer.removeEventListener('pointermove', move);
        resizer.removeEventListener('pointerup', up);
        persist();
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
});
resizer.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
        ev.preventDefault();
        setHistoryHeight(historyHeight() + (ev.key === 'ArrowUp' ? HISTORY_STEP : -HISTORY_STEP));
        persist();
    }
});

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
// The history strip is open unless it was closed last time.
setHistoryOpen(saved.history !== false);
