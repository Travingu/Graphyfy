// webview/layout.ts
// Left-to-right layout with ELK's layered algorithm: callers and importers sit
// left of what they use. Open boxes are laid out with their contents
// (hierarchyHandling INCLUDE_CHILDREN), so arrows into a box pull its contents
// into the right column too.
//
// ELK is called directly instead of through cytoscape-elk so the view gets the
// positions before anything moves, and can animate from where nodes were.

import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { Model, VisibleEdge } from './model';

/** Space around a box's contents. Matches the box padding in view.ts. */
export const BOX_PADDING = 16;
/** Room for a box's label, above its contents. */
export const BOX_LABEL = 24;
/** Above this many visible nodes, ELK does a quicker crossing-minimization pass. */
const QUICK_NODES = 200;

const elk = new ELK();

export interface Size {
    w: number;
    h: number;
}

/** Center of every visible leaf (a node that isn't an open box), in model coordinates. */
export type Positions = Map<string, { x: number; y: number }>;

export async function layout(model: Model, edges: VisibleEdge[], sizeOf: (id: string) => Size): Promise<Positions> {
    const visible = model.visibleNodes();
    const elkNodes = new Map<string, ElkNode>();
    const root: ElkNode = {
        id: '__root',
        layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
            'elk.spacing.nodeNode': '24',
            'elk.layered.spacing.nodeNodeBetweenLayers': '56',
            'elk.spacing.componentComponent': '32',
            // Keep the order nodes come in (folder, then file order) where it doesn't cost crossings,
            // so opening one box doesn't reshuffle the rest.
            'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
            ...(visible.length > QUICK_NODES ? { 'elk.layered.thoroughness': '1' } : {}),
        },
        children: [],
        edges: [],
    };
    for (const n of visible) {
        const box = model.isOpenBox(n.id);
        const size = sizeOf(n.id);
        const node: ElkNode = box
            ? {
                  id: n.id,
                  children: [],
                  edges: [],
                  layoutOptions: { 'elk.padding': `[top=${BOX_PADDING + BOX_LABEL},left=${BOX_PADDING},bottom=${BOX_PADDING},right=${BOX_PADDING}]` },
              }
            : { id: n.id, width: size.w, height: size.h };
        elkNodes.set(n.id, node);
        const parent = (n.parent && elkNodes.get(n.parent)) || root;
        parent.children!.push(node);
    }

    // ELK wants each edge in the innermost box that holds both ends. Edges that
    // end on an open box are drawn but left out of the layout.
    for (const e of edges) {
        if (model.isOpenBox(e.source) || model.isOpenBox(e.target)) {
            continue;
        }
        const a = model.ancestors(e.source);
        const b = model.ancestors(e.target);
        let common: string | undefined;
        for (let i = 0; i < Math.min(a.length, b.length) && a[i] === b[i]; i++) {
            common = a[i];
        }
        const holder = (common && elkNodes.get(common)) || root;
        holder.edges!.push({ id: e.id, sources: [e.source], targets: [e.target] } satisfies ElkExtendedEdge);
    }

    const result = await elk.layout(root);
    const positions: Positions = new Map();
    const walk = (node: ElkNode, ox: number, oy: number) => {
        for (const c of node.children ?? []) {
            const x = ox + (c.x ?? 0);
            const y = oy + (c.y ?? 0);
            if (c.children?.length || model.isOpenBox(c.id)) {
                walk(c, x, y);
            } else {
                positions.set(c.id, { x: x + (c.width ?? 0) / 2, y: y + (c.height ?? 0) / 2 });
            }
        }
    };
    walk(result, 0, 0);
    return positions;
}
