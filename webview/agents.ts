// webview/agents.ts
// AI agents on the graph: which are connected, the tokens Overseer saved
// Claude Code, a feed of the files they read and edited, and the live line in
// the toolbar ("Claude editing api.ts").
// The glow on the graph itself is view.ts's pulse(); main.ts ties them up.

import type { AgentEvent, AgentName, AgentStatus, SessionUsage } from '../src/types';
import { relativeDate } from './timeline';
import { esc } from './util';

/** Feed rows kept. */
const FEED_MAX = 40;
/** How long the toolbar keeps saying what an agent is doing. */
const LIVE_MS = 6000;
/** Events older than this when they arrive (the log's history) don't light up the graph. */
export const LIVE_WINDOW_MS = 10000;

export const AGENT_LABEL: Record<AgentName, string> = { claude: 'Claude Code', cursor: 'Cursor' };
const AGENT_SHORT: Record<AgentName, string> = { claude: 'Claude', cursor: 'Cursor' };
const ACTION_VERB: Record<AgentEvent['action'], string> = { read: 'reading', edit: 'editing', search: 'searching' };
const ACTION_PAST: Record<AgentEvent['action'], string> = { read: 'read', edit: 'edited', search: 'searched' };

interface FeedRow extends AgentEvent {
    /** The same agent did the same thing to the same file this many times in a row. */
    n: number;
}

export interface AgentActions {
    connect(agent: AgentName): void;
    disconnect(agent: AgentName): void;
    /** A feed row was clicked: show its file. */
    show(file: string): void;
    follow(on: boolean): void;
}

export class AgentFeed {
    status: AgentStatus = { available: false, connected: { claude: false, cursor: false } };
    private rows: FeedRow[] = [];
    private sessions: SessionUsage[] = [];
    private liveTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly live: HTMLElement,
        private readonly actions: AgentActions,
        public following: boolean,
    ) {}

    setStatus(status: AgentStatus): void {
        this.status = status;
    }

    /** Claude Code's measured sessions, newest first. */
    setUsage(sessions: SessionUsage[]): void {
        this.sessions = sessions;
    }

    /** New events, oldest first. */
    add(events: AgentEvent[]): void {
        for (const e of events) {
            const top = this.rows[0];
            if (top && top.agent === e.agent && top.action === e.action && top.file === e.file) {
                top.n++;
                top.t = e.t;
            } else {
                this.rows.unshift({ ...e, n: 1 });
            }
        }
        this.rows.length = Math.min(this.rows.length, FEED_MAX);
        const last = events[events.length - 1];
        if (last && Date.now() - last.t < LIVE_WINDOW_MS) {
            this.showLive(last);
        }
    }

    /** Fill the "AI agents" section of the details overview, if it's showing. */
    render(): void {
        const el = document.getElementById('agents');
        if (!el) {
            return;
        }
        const agents = (Object.keys(AGENT_LABEL) as AgentName[]).map((a) => {
            const on = this.status.connected[a];
            return `<li class="agent-row">
                <span class="agent-state" data-agent="${a}" data-on="${on}"></span>
                <span class="row-name">${AGENT_LABEL[a]}</span>
                <span class="row-meta">${on ? 'Connected' : 'Not connected'}</span>
                <button class="button" data-agent="${a}" data-connect="${!on}">${on ? 'Disconnect' : 'Connect'}</button>
              </li>`;
        });
        const feed = this.rows.length
            ? `<ul class="rows">${this.rows.map((r) => rowHtml(r)).join('')}</ul>`
            : `<p class="hint">${
                  this.status.connected.claude || this.status.connected.cursor
                      ? 'Nothing yet. Files the agent reads or edits light up on the graph and are listed here.'
                      : 'Connect an agent to see the files it reads and edits, live on the graph.'
              }</p>`;
        el.innerHTML = `
            <h3 class="section-title">AI agents</h3>
            ${this.status.available ? `<ul class="agent-list">${agents.join('')}</ul>` : '<p class="hint">Open a folder to connect an agent.</p>'}
            <label class="legend-check"><input id="follow-agent" type="checkbox" ${this.following ? 'checked' : ''}>Follow the agent on the graph</label>
            ${usageHtml(this.sessions)}
            <h3 class="section-title">Recent activity <span class="count">${this.rows.length}</span></h3>
            ${feed}`;
        el.querySelectorAll<HTMLButtonElement>('[data-agent]').forEach((b) =>
            b.addEventListener('click', () => {
                b.disabled = true;
                const agent = b.dataset.agent as AgentName;
                if (b.dataset.connect === 'true') {
                    this.actions.connect(agent);
                } else {
                    this.actions.disconnect(agent);
                }
            }),
        );
        el.querySelectorAll<HTMLButtonElement>('[data-file]').forEach((b) => b.addEventListener('click', () => this.actions.show(b.dataset.file!)));
        el.querySelector<HTMLInputElement>('#follow-agent')!.addEventListener('change', (ev) => {
            this.following = (ev.target as HTMLInputElement).checked;
            this.actions.follow(this.following);
        });
    }

    private showLive(e: AgentEvent): void {
        this.live.innerHTML = `<span class="agent-badge" data-agent="${e.agent}">${AGENT_SHORT[e.agent]}</span>${ACTION_VERB[e.action]} <b>${esc(basename(e.file))}</b>`;
        this.live.title = `${AGENT_LABEL[e.agent]} ${ACTION_VERB[e.action]} ${e.file}`;
        this.live.hidden = false;
        clearTimeout(this.liveTimer);
        this.liveTimer = setTimeout(() => (this.live.hidden = true), LIVE_MS);
    }
}

/** The latest Claude Code session's tokens, against an estimate of them without Overseer. */
function usageHtml(sessions: SessionUsage[]): string {
    const s = sessions[0];
    if (!s) {
        return '';
    }
    const row = (name: string, meta: string, title = '') =>
        `<li class="row static"${title ? ` title="${esc(title)}"` : ''}><span class="row-name">${name}</span><span class="row-meta">${meta}</span></li>`;
    const all = sessions.reduce((t, x) => ({ used: t.used + x.used, net: t.net + x.saved - x.spent }), { used: 0, net: 0 });
    const rows = [
        row('Searches answered from the table', `${s.answered}${s.repeated ? ` · ${s.repeated} run again` : ''}`),
        row('Reads narrowed by the table', `${s.guidedReads}`),
        row('Kept out of the conversation', `≈${tokens(s.saved)}`),
        row("Overseer's own text", `≈${tokens(s.spent)}`, `The session hint, ${s.tableLookups} lookups in the table, and its answers`),
        sessions.length > 1 ? row(`All ${sessions.length} sessions`, change(all.used, all.net)) : '',
    ];
    return `
        <h3 class="section-title">Token use <span class="count" title="${esc(s.title ?? '')}">Claude Code, ${esc(relativeDate(s.end / 1000))}</span></h3>
        <dl class="stats usage-stats">
          <div><dt>Used</dt><dd>${tokens(s.used)}</dd></div>
          <div><dt>Without Overseer</dt><dd>≈${tokens(s.used + s.saved - s.spent)}</dd></div>
        </dl>
        <ul class="rows">${rows.join('')}</ul>
        <p class="hint">Used is Claude Code's own count over ${s.requests} requests. Without Overseer is an estimate: every request re-sends the conversation, so text kept out of it counts once per later request.</p>`;
}

/** 840, 12.4k, 1.24M. */
function tokens(n: number): string {
    const a = Math.abs(n);
    const s = a < 1e3 ? `${a}` : a < 1e6 ? `${(a / 1e3).toFixed(a < 1e4 ? 1 : 0)}k` : `${(a / 1e6).toFixed(a < 1e7 ? 2 : 1)}M`;
    return n < 0 ? `−${s}` : s;
}

/** "≈8% fewer tokens", against what would have been used without Overseer. */
function change(used: number, net: number): string {
    const without = used + net;
    const pct = without > 0 ? Math.round((Math.abs(net) / without) * 100) : 0;
    return pct === 0 ? 'about the same' : `≈${pct}% ${net > 0 ? 'fewer' : 'more'} tokens`;
}

function rowHtml(r: FeedRow): string {
    const name = basename(r.file) || r.file;
    const meta = `${AGENT_SHORT[r.agent]} ${ACTION_PAST[r.action]}${r.n > 1 ? ` ×${r.n}` : ''} · ${relativeDate(r.t / 1000)}`;
    const inner = `<span class="agent-dot" data-agent="${r.agent}" data-action="${r.action}"></span>
        <span class="row-name" title="${esc(r.file)}">${esc(name)}</span>
        <span class="row-meta">${esc(meta)}</span>`;
    return r.inWorkspace
        ? `<li><button class="row" data-file="${esc(r.file)}">${inner}</button></li>`
        : `<li class="row static" title="Outside the workspace">${inner}</li>`;
}

function basename(p: string): string {
    return p.slice(p.lastIndexOf('/') + 1);
}
