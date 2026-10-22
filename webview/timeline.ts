// webview/timeline.ts
// The Git history strip under the graph: commits left to right, oldest first,
// one lane per line of history (src/git/lanes.ts), branch names above their
// tips and the working tree at the right end. Drawn as inline SVG in a
// horizontally scrolling box. Clicking a commit or branch asks to view it;
// the arrow keys move between commits.

import type { Branch, Commit, HistoryData } from '../src/types';
import { assignLanes, type LaneLayout } from '../src/git/lanes';
import { esc } from './util';

/** On the 4px scale, like style.css. */
const COL = 32;
const LANE = 32;
const PAD_X = 24;
/** Room for the dates along the top. */
const TOP = 24;
const DOT_R = 4;
const LABEL_H = 16;
const LABEL_MAX_CHARS = 24;
/** Lane colors cycle through this many (style.css: .lane-0 … .lane-5). */
const LANE_COLORS = 6;
/** Dates closer than this would overlap, so the later one is left out. */
const DATE_MIN_GAP = 72;

/** What the graph shows, as the timeline marks it: the working tree or a commit sha. */
export type TimelineTarget = 'worktree' | string;

export interface TimelineEvents {
    viewCommit(sha: string, branch?: string): void;
    viewWorktree(): void;
}

export class Timeline {
    private data: HistoryData | undefined;
    private layout: LaneLayout | undefined;
    private byColumn: string[] = [];
    private branchesAt = new Map<string, Branch[]>();
    private selected: TimelineTarget = 'worktree';
    private pending: TimelineTarget | undefined;
    private readonly tooltip: HTMLElement;

    constructor(
        private readonly scroller: HTMLElement,
        private readonly meta: HTMLElement,
        private readonly events: TimelineEvents,
    ) {
        this.tooltip = document.createElement('div');
        this.tooltip.className = 'timeline-tooltip';
        this.tooltip.setAttribute('role', 'tooltip');
        this.tooltip.hidden = true;
        scroller.parentElement!.append(this.tooltip);

        scroller.addEventListener('click', (ev) => {
            const target = (ev.target as Element).closest<SVGElement>('[data-target]');
            if (target) {
                this.activate(target);
            }
        });
        scroller.addEventListener('keydown', (ev) => this.onKey(ev));
        scroller.addEventListener('mouseover', (ev) => {
            const target = (ev.target as Element).closest<SVGElement>('[data-target]');
            if (target) {
                this.showTooltip(target);
            }
        });
        scroller.addEventListener('mouseout', (ev) => {
            if (!(ev.relatedTarget as Element | null)?.closest?.('[data-target]')) {
                this.tooltip.hidden = true;
            }
        });
        scroller.addEventListener('scroll', () => (this.tooltip.hidden = true), { passive: true });
    }

    get loaded(): boolean {
        return !!this.data;
    }

    showLoading(): void {
        this.data = undefined;
        this.meta.textContent = '';
        const bars = [3, 5, 2].map((n, i) => `<div class="timeline-skeleton-row" style="--n:${n};--i:${i}"></div>`).join('');
        this.scroller.innerHTML = `<div class="timeline-skeleton" aria-hidden="true">${bars}</div><p class="sr-only" role="status">Loading history…</p>`;
    }

    showError(message: string): void {
        this.data = undefined;
        this.meta.textContent = '';
        this.scroller.innerHTML = `<p class="timeline-message">${esc(message)}</p>`;
    }

    setHistory(data: HistoryData): void {
        const first = !this.data;
        const atEnd = this.scroller.scrollLeft + this.scroller.clientWidth >= this.scroller.scrollWidth - COL;
        this.data = data;
        this.layout = assignLanes(data.commits, data.head);
        this.byColumn = [...this.layout.points].sort((a, b) => a[1].column - b[1].column).map(([sha]) => sha);
        this.branchesAt = new Map();
        for (const b of data.branches) {
            const list = this.branchesAt.get(b.sha) ?? [];
            list.push(b);
            this.branchesAt.set(b.sha, list);
        }
        // The checked-out branch first, then local before remote.
        for (const list of this.branchesAt.values()) {
            list.sort((a, b) => rank(a, data) - rank(b, data) || a.name.localeCompare(b.name));
        }
        const local = data.branches.filter((b) => !b.remote).length;
        this.meta.textContent = [
            `${data.commits.length}${data.truncated ? '+' : ''} commit${data.commits.length === 1 ? '' : 's'}`,
            `${local} branch${local === 1 ? '' : 'es'}`,
            data.truncated ? `latest ${data.commits.length} shown` : '',
        ]
            .filter(Boolean)
            .join(' · ');
        this.render();
        // Start at the newest end, and stay there as commits arrive.
        if (first || atEnd) {
            this.scroller.scrollLeft = this.scroller.scrollWidth;
        }
    }

    /** Mark what the graph now shows. */
    setSelected(target: TimelineTarget): void {
        this.selected = target;
        this.pending = undefined;
        this.updateMarks();
    }

    /** A view was asked for and is on its way. */
    setPending(target: TimelineTarget | undefined): void {
        this.pending = target;
        this.updateMarks();
    }

    // ---- drawing ------------------------------------------------------------------

    private render(): void {
        const data = this.data!;
        const layout = this.layout!;
        if (!data.commits.length) {
            this.scroller.innerHTML = `<p class="timeline-message">This repository has no commits yet.</p>`;
            return;
        }
        const columns = data.commits.length + 1; // and the working tree
        let width = PAD_X * 2 + (columns - 1) * COL;
        const x = (column: number) => PAD_X + column * COL;
        // Above each lane's dots, room for a branch name.
        const y = (lane: number) => TOP + LABEL_H + 12 + lane * LANE;
        const height = y(layout.lanes - 1) + 20;
        const at = (sha: string) => layout.points.get(sha)!;

        const lines: string[] = [];
        for (const e of layout.edges) {
            const from = at(e.from);
            const to = at(e.to);
            lines.push(`<path class="timeline-line lane-${e.via % LANE_COLORS}" d="${edgePath(x(from.column), y(from.lane), x(to.column), y(to.lane), y(e.via))}"/>`);
        }
        for (const c of layout.cut) {
            const from = at(c.from);
            lines.push(`<path class="timeline-line timeline-cut lane-${c.via % LANE_COLORS}" d="${edgePath(x(from.column), y(from.lane), x(from.column) - COL, y(c.via), y(c.via))}"/>`);
        }

        // The working tree: after HEAD, in its lane.
        const head = data.head && layout.points.get(data.head);
        const wtLane = head ? head.lane : 0;
        const wtX = x(columns - 1);
        if (head) {
            lines.push(`<path class="timeline-line timeline-worktree-line" d="M${x(head.column)} ${y(head.lane)} H${wtX}"/>`);
        }

        const dots = this.byColumn.map((sha) => {
            const p = at(sha);
            const c = data.commits[data.commits.length - 1 - p.column];
            const isHead = sha === data.head;
            return `<g class="timeline-commit lane-${p.lane % LANE_COLORS}${isHead ? ' head' : ''}" data-target="${sha}" role="button" tabindex="-1"
                aria-label="${esc(`Commit ${sha.slice(0, 7)}: ${c.subject}, by ${c.author}, ${absoluteDate(c.time)}${isHead ? ' (checked out)' : ''}`)}">
                <circle class="timeline-hit" cx="${x(p.column)}" cy="${y(p.lane)}" r="${COL / 2 - 2}"/>
                <circle class="timeline-ring" cx="${x(p.column)}" cy="${y(p.lane)}" r="${DOT_R + 4}"/>
                <circle class="timeline-dot" cx="${x(p.column)}" cy="${y(p.lane)}" r="${isHead ? DOT_R + 1 : DOT_R}"/>
              </g>`;
        });
        dots.push(`<g class="timeline-commit timeline-worktree${data.dirty ? ' dirty' : ''}" data-target="worktree" role="button" tabindex="-1"
            aria-label="Working tree${data.dirty ? ', with uncommitted changes' : ''}">
            <circle class="timeline-hit" cx="${wtX}" cy="${y(wtLane)}" r="${COL / 2 - 2}"/>
            <circle class="timeline-ring" cx="${wtX}" cy="${y(wtLane)}" r="${DOT_R + 4}"/>
            <circle class="timeline-dot" cx="${wtX}" cy="${y(wtLane)}" r="${DOT_R}"/>
          </g>`);

        // Branch names sit above their tip, in the band between this lane and the one above.
        const labels: string[] = [];
        for (const [sha, branches] of this.branchesAt) {
            const p = layout.points.get(sha);
            if (!p) {
                continue; // older than the history shown
            }
            const b = branches[0];
            const more = branches.length > 1 ? ` +${branches.length - 1}` : '';
            const text = truncate(b.name, LABEL_MAX_CHARS) + more;
            const current = !b.remote && b.name === data.headBranch;
            const labelX = x(p.column) - DOT_R - 4;
            width = Math.max(width, labelX + textWidth(text) + PAD_X);
            labels.push(`<g class="timeline-branch lane-${p.lane % LANE_COLORS}${current ? ' current' : ''}" data-target="${sha}" data-branch="${esc(b.name)}" role="button" tabindex="-1"
                aria-label="${esc(`Branch ${branches.map((x) => x.name).join(', ')}${current ? ' (checked out)' : ''}`)}">
                <rect x="${labelX}" y="${y(p.lane) - DOT_R - 4 - LABEL_H}" width="${textWidth(text)}" height="${LABEL_H}" rx="4"/>
                <text x="${x(p.column) - DOT_R + 2}" y="${y(p.lane) - DOT_R - 4 - LABEL_H / 2}">${esc(text)}</text>
              </g>`);
        }
        labels.push(`<text class="timeline-worktree-label" x="${wtX}" y="${y(wtLane) - DOT_R - 4 - LABEL_H / 2}">${data.dirty ? 'Changes' : 'Now'}</text>`);

        // Dates where the day changes, skipping any that would crowd the one before.
        const dates: string[] = [];
        let lastDay = '';
        let lastX = -Infinity;
        for (const sha of this.byColumn) {
            const p = at(sha);
            const c = data.commits[data.commits.length - 1 - p.column];
            const day = shortDate(c.time);
            if (day !== lastDay && x(p.column) - lastX >= DATE_MIN_GAP) {
                dates.push(`<text class="timeline-date" x="${x(p.column)}" y="16">${esc(day)}</text><line class="timeline-tick" x1="${x(p.column)}" x2="${x(p.column)}" y1="22" y2="${height}"/>`);
                lastX = x(p.column);
            }
            lastDay = day;
        }

        this.scroller.innerHTML = `<svg class="timeline-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="group" aria-label="Commits, oldest first">
            <g aria-hidden="true">${dates.join('')}</g>
            <g aria-hidden="true">${lines.join('')}</g>
            ${dots.join('')}
            ${labels.join('')}
          </svg>`;
        this.updateMarks();
    }

    /** The selected and pending rings, and which commit the Tab key lands on. */
    private updateMarks(): void {
        let focusable: Element | undefined;
        this.scroller.querySelectorAll<SVGElement>('.timeline-commit').forEach((g) => {
            const t = g.dataset.target!;
            g.classList.toggle('selected', t === this.selected && this.pending === undefined);
            g.classList.toggle('pending', t === this.pending);
            g.setAttribute('aria-pressed', String(t === this.selected));
            if (t === (this.pending ?? this.selected)) {
                focusable = g;
            }
        });
        const all = this.scroller.querySelectorAll<SVGElement>('[data-target]');
        all.forEach((g) => g.setAttribute('tabindex', '-1'));
        (focusable ?? all[all.length - 1])?.setAttribute('tabindex', '0');
    }

    // ---- interaction --------------------------------------------------------------

    private activate(el: SVGElement): void {
        const target = el.dataset.target!;
        this.tooltip.hidden = true;
        if (target === 'worktree') {
            if (this.selected !== 'worktree' || this.pending) {
                this.setPending('worktree');
                this.events.viewWorktree();
            }
            return;
        }
        // A branch's tip opens as that branch, so it can be switched to.
        this.setPending(target);
        this.events.viewCommit(target, el.dataset.branch ?? this.branchesAt.get(target)?.[0]?.name);
    }

    private onKey(ev: KeyboardEvent): void {
        const el = (ev.target as Element).closest<SVGElement>('[data-target]');
        if (!el) {
            return;
        }
        if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            this.activate(el);
            return;
        }
        const order = [...this.byColumn, 'worktree'];
        const i = order.indexOf(el.dataset.target!);
        const next = ev.key === 'ArrowLeft' ? i - 1 : ev.key === 'ArrowRight' ? i + 1 : ev.key === 'Home' ? 0 : ev.key === 'End' ? order.length - 1 : undefined;
        if (next === undefined) {
            return;
        }
        ev.preventDefault();
        const target = this.scroller.querySelector<SVGElement>(`.timeline-commit[data-target="${order[Math.max(0, Math.min(order.length - 1, next))]}"]`);
        if (target) {
            el.setAttribute('tabindex', '-1');
            target.setAttribute('tabindex', '0');
            target.focus();
            this.showTooltip(target);
        }
    }

    private showTooltip(el: SVGElement): void {
        const data = this.data;
        if (!data) {
            return;
        }
        const target = el.dataset.target!;
        let html: string;
        if (target === 'worktree') {
            html = `<p class="timeline-tooltip-title">Working tree</p>
                <p class="timeline-tooltip-meta">${data.dirty ? 'Your files, with uncommitted changes' : 'Your files, the same as the last commit'}</p>`;
        } else {
            const c = data.commits.find((x) => x.sha === target);
            if (!c) {
                return;
            }
            const branches = (this.branchesAt.get(target) ?? []).map((b) => b.name);
            html = `<p class="timeline-tooltip-title">${esc(c.subject || '(no message)')}</p>
                <p class="timeline-tooltip-meta"><code>${c.sha.slice(0, 7)}</code> · ${esc(c.author)} · ${esc(relativeDate(c.time))}</p>
                ${branches.length ? `<p class="timeline-tooltip-meta">${branches.map(esc).join(', ')}</p>` : ''}
                ${mergeNote(c)}`;
        }
        this.tooltip.innerHTML = html;
        this.tooltip.hidden = false;
        // Above the commit, kept inside the strip.
        const box = el.querySelector('.timeline-dot')!.getBoundingClientRect();
        const host = this.tooltip.parentElement!.getBoundingClientRect();
        const tip = this.tooltip.getBoundingClientRect();
        const left = Math.min(Math.max(8, box.left + box.width / 2 - host.left - tip.width / 2), host.width - tip.width - 8);
        const below = box.top - host.top - tip.height - 8 < 0;
        this.tooltip.style.left = `${left}px`;
        this.tooltip.style.top = `${below ? box.bottom - host.top + 8 : box.top - host.top - tip.height - 8}px`;
    }
}

/** A child-to-parent line: leave the child, run along lane `yVia`, arrive at the parent. */
function edgePath(x1: number, y1: number, x2: number, y2: number, yVia: number): string {
    const curve = (xa: number, ya: number, xb: number, yb: number) => `C${(xa + xb) / 2} ${ya} ${(xa + xb) / 2} ${yb} ${xb} ${yb}`;
    if (yVia !== y1 && yVia !== y2 && x1 - x2 <= COL) {
        return `M${x1} ${y1}` + curve(x1, y1, x2, y2); // no room for both bends
    }
    let d = `M${x1} ${y1}`;
    let cx = x1;
    if (yVia !== y1) {
        cx = Math.max(x2, x1 - COL);
        d += curve(x1, y1, cx, yVia);
    }
    if (yVia !== y2) {
        if (cx > x2 + COL) {
            d += `H${x2 + COL}`;
            cx = x2 + COL;
        }
        d += curve(cx, yVia, x2, y2);
    } else if (cx > x2) {
        d += `H${x2}`;
    }
    return d;
}

function rank(b: Branch, data: HistoryData): number {
    return !b.remote && b.name === data.headBranch ? 0 : b.remote ? 2 : 1;
}

function mergeNote(c: Commit): string {
    return c.parents.length > 1 ? `<p class="timeline-tooltip-meta">Merge of ${c.parents.length} lines</p>` : '';
}

function truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

const measure = document.createElement('canvas').getContext('2d')!;
/** The pill around a branch name: 11px text plus 6px either side. */
function textWidth(text: string): number {
    measure.font = `600 11px ${getComputedStyle(document.body).fontFamily}`;
    return Math.ceil(measure.measureText(text).width) + 12;
}

const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function shortDate(time: number): string {
    return dayFormat.format(time * 1000);
}

export function absoluteDate(time: number): string {
    return fullFormat.format(time * 1000);
}

/** "3 hours ago", "yesterday", "2 weeks ago". */
export function relativeDate(time: number): string {
    const seconds = time - Date.now() / 1000;
    const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
        ['year', 31536000],
        ['month', 2592000],
        ['week', 604800],
        ['day', 86400],
        ['hour', 3600],
        ['minute', 60],
    ];
    for (const [unit, size] of units) {
        if (Math.abs(seconds) >= size) {
            return relative.format(Math.round(seconds / size), unit);
        }
    }
    return 'just now';
}
