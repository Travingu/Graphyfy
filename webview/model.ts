// webview/model.ts
// The graph as the webview sees it: which boxes are open, which nodes that
// makes visible, and the arrows between visible nodes. An arrow whose end is
// inside a closed box is drawn to the box instead, and arrows that land on the
// same pair of boxes are bundled into one with a count.

import type { EdgeKind, GraphData, GraphEdge, GraphNode } from '../src/types';

/** Which kind a bundled arrow shows, first wins. */
const KIND_PRIORITY: EdgeKind[] = ['import', 'extends', 'implements', 'render', 'call'];

export interface VisibleEdge {
    id: string;
    kind: EdgeKind;
    source: string;
    target: string;
    /** Occurrences, summed over the bundled relationships. */
    n: number;
    /** Every bundled relationship was a guess by method name. */
    uncertain: boolean;
}

export class Model {
    readonly nodes = new Map<string, GraphNode>();
    readonly children = new Map<string, string[]>();
    readonly roots: string[] = [];
    readonly outgoing = new Map<string, GraphEdge[]>();
    readonly incoming = new Map<string, GraphEdge[]>();
    /** Boxes (folders, files, classes) that are open. */
    readonly open = new Set<string>();

    constructor(readonly data: GraphData, previouslyOpen?: Iterable<string>) {
        for (const n of data.nodes) {
            this.nodes.set(n.id, n);
        }
        for (const n of data.nodes) {
            if (n.parent && this.nodes.has(n.parent)) {
                push(this.children, n.parent, n.id);
            } else {
                this.roots.push(n.id);
            }
        }
        for (const e of data.edges) {
            push(this.outgoing, e.source, e);
            push(this.incoming, e.target, e);
        }
        for (const id of previouslyOpen ?? []) {
            if (this.children.has(id)) {
                this.open.add(id);
            }
        }
        if (!this.open.size) {
            this.collapseAll(); // nothing saved fits this graph: start from the folders
        }
    }

    isBox(id: string): boolean {
        return this.children.has(id);
    }

    isOpenBox(id: string): boolean {
        return this.open.has(id) && this.children.has(id);
    }

    /** Ancestors, outermost first. */
    ancestors(id: string): string[] {
        const out: string[] = [];
        for (let p = this.nodes.get(id)?.parent; p && this.nodes.has(p); p = this.nodes.get(p)?.parent) {
            out.unshift(p);
        }
        return out;
    }

    /** The node that shows `id`: itself, or the outermost closed box around it. */
    shownAs(id: string): string {
        return this.ancestors(id).find((a) => !this.open.has(a)) ?? id;
    }

    isVisible(id: string): boolean {
        return this.shownAs(id) === id;
    }

    /** Open a box. Opening a file also opens its classes, so their methods show in one click. */
    openBox(id: string): void {
        if (!this.children.has(id)) {
            return;
        }
        this.open.add(id);
        if (this.nodes.get(id)?.kind === 'file') {
            for (const c of this.children.get(id) ?? []) {
                if (this.nodes.get(c)?.kind === 'class') {
                    this.open.add(c);
                }
            }
        }
    }

    /** Close a box and everything inside it. */
    closeBox(id: string): void {
        this.open.delete(id);
        for (const c of this.children.get(id) ?? []) {
            if (this.open.has(c)) {
                this.closeBox(c);
            }
        }
    }

    /** Open every box around `id` so it's visible. */
    reveal(id: string): void {
        for (const a of this.ancestors(id)) {
            this.openBox(a);
        }
    }

    expandAll(): void {
        for (const id of this.children.keys()) {
            this.open.add(id);
        }
    }

    /** Close everything but the folders: the first view, the project's file structure. */
    collapseAll(): void {
        this.open.clear();
        for (const n of this.data.nodes) {
            if (n.kind === 'dir') {
                this.open.add(n.id);
            }
        }
    }

    /** Visible nodes, each after its parent. */
    visibleNodes(): GraphNode[] {
        const out: GraphNode[] = [];
        const walk = (id: string) => {
            out.push(this.nodes.get(id)!);
            if (this.open.has(id)) {
                for (const c of this.children.get(id) ?? []) {
                    walk(c);
                }
            }
        };
        this.roots.forEach(walk);
        return out;
    }

    /**
     * Arrows between visible nodes. One that would join a box to its own
     * contents is dropped. An arrow with a closed box at either end stands for
     * everything inside it, so all kinds between the same pair become one
     * arrow, shown as the kind that says most about the pair (an import
     * between files).
     */
    visibleEdges(): VisibleEdge[] {
        const bundled = new Map<string, VisibleEdge>();
        for (const e of this.data.edges) {
            const source = this.shownAs(e.source);
            const target = this.shownAs(e.target);
            if (source === target || this.ancestors(target).includes(source) || this.ancestors(source).includes(target)) {
                continue;
            }
            const closed = (id: string) => this.isBox(id) && !this.open.has(id);
            const id = closed(source) || closed(target) ? `bundle|${source}|${target}` : `${e.kind}|${source}|${target}`;
            const b = bundled.get(id);
            if (b) {
                b.n += e.n;
                b.uncertain &&= !!e.uncertain;
                if (KIND_PRIORITY.indexOf(e.kind) < KIND_PRIORITY.indexOf(b.kind)) {
                    b.kind = e.kind;
                }
            } else {
                bundled.set(id, { id, kind: e.kind, source, target, n: e.n, uncertain: !!e.uncertain });
            }
        }
        return [...bundled.values()];
    }

    /** Symbols inside a box, at any depth (files for a folder). */
    countInside(id: string): number {
        let n = 0;
        for (const c of this.children.get(id) ?? []) {
            n += 1 + (this.nodes.get(c)?.kind === 'class' ? (this.children.get(c)?.length ?? 0) : 0);
        }
        return n;
    }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
    const list = map.get(key);
    if (list) {
        list.push(value);
    } else {
        map.set(key, [value]);
    }
}
