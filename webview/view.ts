// webview/view.ts
// The graph canvas: Cytoscape elements kept in step with the model, the ELK
// layout animated from where nodes were, and the selection highlight.

import cytoscape, { type Core, type ElementDefinition, type NodeSingular, type StylesheetJson } from 'cytoscape';
import { BOX_PADDING, layout, type Size } from './layout';
import type { AgentName } from '../src/types';
import type { Model } from './model';
import { mix, readTheme, type Theme } from './theme';

const FONT_SIZE = 12;
const NODE_HEIGHT = 32;
const NODE_PAD_X = 12;
const DOT = 6;
const DOT_GAP = 8;
const ANIMATION_MS = 240;
/** How long a node glows after an AI agent reads or edits it. */
const AGENT_GLOW_MS = 4000;
/** The agent's name on a glowing node's top-right corner. */
const TAG_LABEL: Record<AgentName, string> = { claude: 'Claude', cursor: 'Cursor' };
/** Above this many visible nodes, layout changes apply without animation. */
const ANIMATE_MAX_NODES = 600;
/**
 * Zoomed out past where labels can be read, nodes draw as dots in their
 * kind's color, and open back into labels when zoomed in. The gap between
 * the two keeps a slow pinch from flickering between them.
 */
const COMPACT_BELOW = 0.55;
const EXPAND_ABOVE = 0.65;
/** Dot diameters, in graph units: a symbol, and a closed file or folder (it holds more). */
const COMPACT_DOT = 16;
const COMPACT_BOX_DOT = 24;

export interface ViewEvents {
    select(id: string | undefined): void;
    /** A click on a closed box. */
    toggle(id: string): void;
    /** Ctrl/Cmd+click on an open box. */
    close(id: string): void;
    openSource(id: string): void;
}

const measure = document.createElement('canvas').getContext('2d')!;

export class GraphView {
    readonly cy: Core;
    private theme: Theme = readTheme();
    private sizes = new Map<string, Size>();
    private selected: string | undefined;
    private laidOut = false;
    private running: Promise<void> = Promise.resolve();
    private glowTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /** Agent name tags over glowing nodes: HTML, so they stay readable at any zoom. */
    private readonly tagLayer: HTMLElement;
    private tags = new Map<string, HTMLElement>();
    /** Nodes are dots (zoomed out); the hovered one's name shows in `tip`. */
    private compact = false;
    private readonly tip: HTMLElement;
    private hovered: string | undefined;
    /** Draw git change markers (main.ts's "Show changes"). */
    showChanges = true;
    /** The graph is the working tree, so every change is uncommitted and drawn in one color. */
    uncommitted = false;

    constructor(
        container: HTMLElement,
        private model: Model,
        private readonly events: ViewEvents,
    ) {
        this.cy = cytoscape({
            container,
            style: this.style(),
            minZoom: 0.1,
            maxZoom: 2.5,
            // Cytoscape draws labels from bitmaps cached at power-of-two scales and
            // resamples them, which blurs text at 1x and fractional (125%, 150%)
            // display scaling. Rendering at 2x or more keeps labels sharp.
            pixelRatio: Math.max(2, window.devicePixelRatio || 1),
            boxSelectionEnabled: false,
            // Selection is the view's own `selected` class, so Cytoscape's is off.
            autounselectify: true,
        });
        this.tagLayer = document.createElement('div');
        this.tagLayer.className = 'agent-tags';
        this.tagLayer.setAttribute('aria-hidden', 'true');
        container.after(this.tagLayer);
        this.tip = document.createElement('span');
        this.tip.className = 'node-tip';
        this.tip.hidden = true;
        this.tagLayer.append(this.tip);
        // Every frame the canvas draws (pan, zoom, layout), the tags follow their nodes.
        this.cy.on('render', () => this.placeTags());
        this.cy.on('zoom', () => this.updateCompact());
        this.cy.on('mouseover', 'node', (ev) => {
            this.hovered = ev.target.id();
            this.placeTags();
        });
        this.cy.on('mouseout', 'node', () => {
            this.hovered = undefined;
            this.placeTags();
        });
        this.cy.on('tap', 'node', (ev) => {
            const id = ev.target.id();
            const box = this.model.isBox(id);
            const ctrl = (ev.originalEvent as MouseEvent | undefined)?.ctrlKey || (ev.originalEvent as MouseEvent | undefined)?.metaKey;
            if (box && this.model.isOpenBox(id) && ctrl) {
                this.events.close(id);
            } else if (box && !this.model.isOpenBox(id)) {
                this.events.toggle(id);
            } else {
                this.events.select(id);
            }
        });
        this.cy.on('dbltap', 'node', (ev) => this.events.openSource(ev.target.id()));
        this.cy.on('tap', (ev) => {
            if (ev.target === this.cy) {
                this.events.select(undefined);
            }
        });
    }

    setModel(model: Model): void {
        this.model = model;
    }

    /**
     * Light up a node for a moment in the agent's color, with its name on the
     * corner: a soft glow while it reads, a stronger one and an outline while
     * it edits.
     */
    pulse(id: string, agent: AgentName, action: 'read' | 'edit'): void {
        const n = this.cy.getElementById(id);
        if (n.empty()) {
            return;
        }
        // Editing outranks reading while both glows last.
        if (action === 'edit' || !n.hasClass('agent-edit') || n.data('agent') !== agent) {
            n.data('agent', agent);
            n.removeClass('agent-read agent-edit').addClass(`agent-${action}`);
        }
        let tag = this.tags.get(id);
        if (!tag) {
            tag = document.createElement('span');
            tag.className = 'agent-tag';
            this.tagLayer.append(tag);
            this.tags.set(id, tag);
        }
        tag.dataset.agent = agent;
        tag.textContent = TAG_LABEL[agent];
        this.placeTags();
        clearTimeout(this.glowTimers.get(id));
        this.glowTimers.set(
            id,
            setTimeout(() => {
                this.cy.getElementById(id).removeClass('agent-read agent-edit');
                this.tags.get(id)?.remove();
                this.tags.delete(id);
                this.glowTimers.delete(id);
            }, AGENT_GLOW_MS),
        );
    }

    /** Switch between dots and labels when the zoom crosses the threshold. */
    private updateCompact(): void {
        const zoom = this.cy.zoom();
        const compact = this.compact ? zoom < EXPAND_ABOVE : zoom < COMPACT_BELOW;
        if (compact !== this.compact) {
            this.compact = compact;
            this.applyCompact();
        }
    }

    /** Open boxes stay boxes: only what's drawn as a single node becomes a dot. */
    private applyCompact(): void {
        this.cy.batch(() => {
            this.cy.nodes().forEach((n) => {
                n.toggleClass('compact', this.compact && !n.hasClass('box'));
            });
        });
        this.placeTags();
    }

    /** Put each tag on its node's top-right corner, on screen, and the hovered dot's name under it. */
    private placeTags(): void {
        const hovered = this.hovered && this.cy.getElementById(this.hovered);
        if (hovered && hovered.nonempty() && hovered.hasClass('compact')) {
            const bb = hovered.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
            this.tip.textContent = String(hovered.data('label'));
            this.tip.style.left = `${(bb.x1 + bb.x2) / 2}px`;
            this.tip.style.top = `${bb.y2}px`;
            this.tip.hidden = false;
        } else {
            this.tip.hidden = true;
        }
        for (const [id, tag] of this.tags) {
            const n = this.cy.getElementById(id);
            if (n.empty()) {
                tag.hidden = true;
                continue;
            }
            const bb = n.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
            tag.hidden = false;
            tag.style.left = `${bb.x2}px`;
            tag.style.top = `${bb.y1}px`;
        }
    }

    /** Re-read the theme's colors (the user switched themes). */
    restyle(): void {
        this.theme = readTheme();
        this.sizes.clear();
        this.cy.style(this.style());
        this.cy.nodes().forEach((n) => {
            n.data(this.nodeData(n.id()));
        });
    }

    /**
     * Bring the canvas in line with the model, then lay it out. Nodes that
     * appear grow out of `anchor` (the box that was opened), and the view pans
     * so `anchor` stays where it was on screen. With `fit`, nodes move straight
     * to their places and the view zooms to show them all.
     */
    update(anchor?: string, fit = false): Promise<void> {
        // Layouts run one after another, so a fast double click can't interleave two.
        this.running = this.running.then(() => this.apply(anchor, fit)).catch((err) => console.error('[overseer] layout failed', err));
        return this.running;
    }

    private async apply(anchor: string | undefined, fit: boolean): Promise<void> {
        const visible = this.model.visibleNodes();
        const edges = this.model.visibleEdges();
        const wanted = new Set([...visible.map((n) => n.id), ...edges.map((e) => e.id)]);
        const anchorNode = anchor ? this.cy.getElementById(anchor) : undefined;
        const anchorBefore = anchorNode?.nonempty() ? { ...anchorNode.position() } : undefined;

        const positions = await layout(this.model, edges, (id) => this.sizeOf(id));

        this.cy.batch(() => {
            this.cy.elements().filter((el) => !wanted.has(el.id())).remove();
            const added: ElementDefinition[] = [];
            for (const n of visible) {
                const existing = this.cy.getElementById(n.id);
                if (existing.nonempty()) {
                    existing.data(this.nodeData(n.id));
                } else {
                    const start = anchorBefore ?? positions.get(n.id) ?? { x: 0, y: 0 };
                    added.push({ group: 'nodes', data: { id: n.id, parent: n.parent, ...this.nodeData(n.id) }, position: { ...start } });
                }
            }
            for (const e of edges) {
                const existing = this.cy.getElementById(e.id);
                const data = { id: e.id, source: e.source, target: e.target, kind: e.kind, n: e.n, width: Math.min(4, 1.25 + Math.log2(e.n) * 0.5), label: e.n > 1 ? String(e.n) : '' };
                if (existing.nonempty()) {
                    existing.data(data);
                } else {
                    added.push({ group: 'edges', data, classes: e.uncertain ? 'uncertain' : '' });
                }
            }
            // Parents before children: Cytoscape needs a node's parent to exist when it's added.
            this.cy.add(added);
            for (const n of visible) {
                this.cy.getElementById(n.id).toggleClass('box', this.model.isOpenBox(n.id));
            }
        });
        this.applyCompact();

        const leaves = this.cy.nodes().filter((n) => positions.has(n.id()));
        const animate = this.laidOut && !fit && visible.length <= ANIMATE_MAX_NODES;
        if (!animate) {
            leaves.forEach((n) => {
                n.position(positions.get(n.id())!);
            });
            if (!this.laidOut) {
                this.cy.fit(undefined, 48);
                this.updateCompact();
            } else if (fit) {
                this.fit();
            }
        } else {
            // Keep the anchor where it was on screen.
            const anchorAfter = anchor ? anchorPosition(anchor, positions, this.model) : undefined;
            if (anchorBefore && anchorAfter) {
                const zoom = this.cy.zoom();
                const pan = this.cy.pan();
                this.cy.animate({ pan: { x: pan.x - (anchorAfter.x - anchorBefore.x) * zoom, y: pan.y - (anchorAfter.y - anchorBefore.y) * zoom } }, { duration: ANIMATION_MS, easing: 'ease-out-cubic' });
            }
            leaves.forEach((n) => {
                n.animate({ position: positions.get(n.id())! }, { duration: ANIMATION_MS, easing: 'ease-out-cubic' });
            });
        }
        this.laidOut = true;
        this.highlight(this.selected);
    }

    fit(): void {
        this.cy.animate({ fit: { eles: this.cy.elements(), padding: 48 } }, { duration: ANIMATION_MS, easing: 'ease-out-cubic' });
    }

    /** Pan to a node, zooming in if it would be too small to read. */
    center(id: string): void {
        const n = this.cy.getElementById(id);
        if (n.empty()) {
            return;
        }
        this.cy.animate({ center: { eles: n }, zoom: Math.max(this.cy.zoom(), 0.9) }, { duration: ANIMATION_MS, easing: 'ease-out-cubic' });
    }

    /** Emphasize a node, its arrows and what they connect to; fade the rest. */
    highlight(id: string | undefined): void {
        this.selected = id;
        const cy = this.cy;
        cy.batch(() => {
            cy.elements().removeClass('selected faded near');
            const node = id ? cy.getElementById(id) : undefined;
            if (!node || node.empty()) {
                return;
            }
            node.addClass('selected');
            const own = node.union(node.descendants());
            const edges = own.connectedEdges();
            const near = edges.connectedNodes().union(own);
            const keep = near.union(near.ancestors()).union(edges);
            edges.addClass('near');
            cy.elements()
                .difference(keep)
                .filter((el) => el.isEdge() || !el.isParent())
                .addClass('faded');
        });
    }

    /** Node size, from its label: measured once per distinct label and weight. */
    private sizeOf(id: string): Size {
        const label = this.labelOf(id);
        const weight = this.model.nodes.get(id)?.kind === 'file' ? '600 ' : '';
        const key = weight + label;
        let size = this.sizes.get(key);
        if (!size) {
            measure.font = `${weight}${FONT_SIZE}px ${this.theme.font}`;
            size = { w: Math.ceil(measure.measureText(label).width) + NODE_PAD_X * 2 + DOT + DOT_GAP, h: NODE_HEIGHT };
            this.sizes.set(key, size);
        }
        return size;
    }

    /** A closed box shows how much it holds: `api.ts · 12`. */
    private labelOf(id: string): string {
        const n = this.model.nodes.get(id)!;
        return this.model.isBox(id) && !this.model.isOpenBox(id) ? `${n.label} · ${this.model.countInside(id)}` : n.label;
    }

    private nodeData(id: string) {
        const n = this.model.nodes.get(id)!;
        const { w, h } = this.sizeOf(id);
        const color = this.theme.kind[n.kind];
        const dotSize = this.model.isBox(id) ? COMPACT_BOX_DOT : COMPACT_DOT;
        return { label: this.labelOf(id), kind: n.kind, w, h, dot: dotImage(color), color, dotSize, mark: this.markOf(id) };
    }

    /**
     * The node's own change, or `inside` for a closed box holding changes.
     * In the working tree every mark is `uncommitted`, except that deleted
     * nodes stay recognizable as `uncommitted-removed`.
     */
    private markOf(id: string): string {
        if (!this.showChanges || !this.model.nodes.has(id)) {
            return '';
        }
        const change = this.model.nodes.get(id)!.change;
        const mark = change ?? (this.model.isBox(id) && !this.model.isOpenBox(id) && this.model.changesInside(id) ? 'inside' : '');
        if (!mark || !this.uncommitted) {
            return mark;
        }
        return mark === 'removed' ? 'uncommitted-removed' : 'uncommitted';
    }

    private style(): StylesheetJson {
        const t = this.theme;
        return [
            {
                selector: 'node',
                style: {
                    shape: 'round-rectangle',
                    'corner-radius': 4,
                    width: 'data(w)',
                    height: 'data(h)',
                    label: 'data(label)',
                    'font-family': t.font,
                    'font-size': FONT_SIZE,
                    color: t.foreground,
                    'text-valign': 'center',
                    'text-halign': 'center',
                    'text-margin-x': (DOT + DOT_GAP) / 2,
                    'background-color': t.surface,
                    'border-width': 1,
                    'border-color': t.border,
                    'background-image': 'data(dot)',
                    'background-width': DOT,
                    'background-height': DOT,
                    'background-position-x': NODE_PAD_X,
                    'background-position-y': '50%',
                    'background-clip': 'none',
                    'background-image-containment': 'over',
                    'transition-property': 'opacity, border-color, underlay-opacity, width, height',
                    'transition-duration': 150,
                    'underlay-opacity': 0,
                    'underlay-padding': 6,
                    'underlay-shape': 'round-rectangle',
                },
            },
            { selector: 'node[kind = "file"]', style: { 'font-weight': 600 } },
            {
                // Zoomed out: a dot in the kind's color, at the center of where its label goes.
                selector: 'node.compact',
                style: {
                    shape: 'ellipse',
                    width: 'data(dotSize)',
                    height: 'data(dotSize)',
                    label: '',
                    'background-image': 'none',
                    'background-color': 'data(color)',
                    'border-color': t.background,
                    'border-width': 2,
                    'underlay-shape': 'ellipse',
                },
            },
            {
                // An open box: its label sits above its contents.
                selector: 'node.box',
                style: {
                    'background-image': 'none',
                    'background-color': t.container,
                    'text-valign': 'top',
                    'text-halign': 'center',
                    'text-margin-x': 0,
                    'text-margin-y': -4,
                    padding: `${BOX_PADDING}px`,
                    'compound-sizing-wrt-labels': 'include',
                },
            },
            { selector: 'node.box[kind = "dir"]', style: { 'background-opacity': 0, 'border-color': mix(t.foreground, t.background, 0.16), color: t.muted } },
            { selector: 'node.box[kind = "class"]', style: { 'background-color': t.surface, 'border-color': mix(t.kind.class, t.background, 0.5) } },
            { selector: 'node[mark = "added"]', style: { 'border-color': t.change.added, 'border-width': 2 } },
            { selector: 'node[mark = "modified"], node[mark = "inside"]', style: { 'border-color': t.change.modified, 'border-width': 2 } },
            { selector: 'node[mark = "uncommitted"]', style: { 'border-color': t.change.uncommitted, 'border-width': 2 } },
            {
                // A ghost of what was deleted.
                selector: 'node[mark = "removed"], node[mark = "uncommitted-removed"]',
                style: { 'border-color': t.change.removed, 'border-width': 2, 'border-style': 'dashed', 'background-opacity': 0, color: t.muted, opacity: 0.7 },
            },
            { selector: 'node[mark = "uncommitted-removed"]', style: { 'border-color': t.change.uncommitted } },
            { selector: 'node.agent-read, node.agent-edit', style: { 'underlay-color': (el: cytoscape.NodeSingular) => t.agent[el.data('agent') as AgentName] } },
            { selector: 'node.agent-read', style: { 'underlay-opacity': 0.3 } },
            {
                selector: 'node.agent-edit',
                style: { 'underlay-opacity': 0.5, 'border-width': 2, 'border-color': (el: cytoscape.NodeSingular) => t.agent[el.data('agent') as AgentName] },
            },
            { selector: 'node.selected', style: { 'border-color': t.focus, 'border-width': 2 } },
            { selector: 'node.faded', style: { opacity: 0.25 } },
            {
                selector: 'edge',
                style: {
                    width: 'data(width)',
                    'curve-style': 'bezier',
                    'line-color': mix(t.edge.call, t.background, 0.4),
                    'target-arrow-color': mix(t.edge.call, t.background, 0.4),
                    'target-arrow-shape': 'triangle',
                    'arrow-scale': 0.8,
                    'font-family': t.font,
                    'font-size': 10,
                    color: t.muted,
                    'text-background-color': t.background,
                    'text-background-opacity': 1,
                    'text-background-padding': '2px',
                    'transition-property': 'opacity, line-color',
                    'transition-duration': 150,
                },
            },
            ...(['render', 'import', 'extends', 'implements'] as const).map((k) => ({
                selector: `edge[kind = "${k}"]`,
                style: { 'line-color': mix(t.edge[k], t.background, 0.7), 'target-arrow-color': mix(t.edge[k], t.background, 0.7) },
            })),
            { selector: 'edge[kind = "implements"]', style: { 'line-style': 'dashed', 'line-dash-pattern': [6, 4], 'target-arrow-fill': 'hollow' } },
            { selector: 'edge[kind = "extends"]', style: { 'target-arrow-fill': 'hollow' } },
            { selector: 'edge.uncertain', style: { 'line-style': 'dashed', 'line-dash-pattern': [2, 4] } },
            { selector: 'edge.near', style: { label: 'data(label)', 'z-index': 10, width: (el: cytoscape.EdgeSingular) => Number(el.data('width')) + 0.5 } },
            { selector: 'edge.near[kind = "call"]', style: { 'line-color': t.foreground, 'target-arrow-color': t.foreground } },
            ...(['render', 'import', 'extends', 'implements'] as const).map((k) => ({
                selector: `edge.near[kind = "${k}"]`,
                style: { 'line-color': t.edge[k], 'target-arrow-color': t.edge[k] },
            })),
            { selector: 'edge.faded', style: { opacity: 0.12 } },
        ] as StylesheetJson;
    }
}

/** Where the anchor ends up: its own new position, or (an open box) the middle of its contents. */
function anchorPosition(anchor: string, positions: Map<string, { x: number; y: number }>, model: Model) {
    const own = positions.get(anchor);
    if (own) {
        return own;
    }
    const inside = [...positions.entries()].filter(([id]) => model.ancestors(id).includes(anchor)).map(([, p]) => p);
    if (!inside.length) {
        return undefined;
    }
    const xs = inside.map((p) => p.x);
    const ys = inside.map((p) => p.y);
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

const dots = new Map<string, string>();
/** A small filled circle in the node kind's color, drawn at the left of the node. */
function dotImage(color: string): string {
    let uri = dots.get(color);
    if (!uri) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${DOT}" height="${DOT}" viewBox="0 0 6 6"><circle cx="3" cy="3" r="3" fill="${color}"/></svg>`;
        uri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
        dots.set(color, uri);
    }
    return uri;
}
