// src/git/changes.ts
// Marks what a commit (or the working tree) changed, by comparing its graph
// with the parent's: nodes only in the new graph were added, nodes whose lines
// a diff hunk touches were modified, and nodes only in the parent's graph come
// back as `removed` ghosts. Folders aren't marked; their files are.

import type { Change, GraphData, GraphNode } from '../types';
import type { Hunks } from './git';

/**
 * `current` with change markers. `parent` is undefined for a root commit, so
 * everything is added. Only nodes whose file passes `inScope` are marked
 * (the working tree view can hold folders from outside the repo).
 */
export function markChanges(current: GraphData, parent: GraphData | undefined, hunks: Hunks, inScope: (file: string) => boolean = () => true): GraphData {
    const before = new Map((parent?.nodes ?? []).map((n) => [n.id, n]));
    const nodes: GraphNode[] = [];
    const ids = new Set<string>();
    const counts: Record<Change, number> = { added: 0, modified: 0, removed: 0 };

    for (const n of current.nodes) {
        ids.add(n.id);
        const change = n.kind === 'dir' || !inScope(n.file) ? undefined : !before.has(n.id) ? 'added' : touched(n, hunks) ? 'modified' : undefined;
        if (change) {
            counts[change]++;
        }
        nodes.push(change ? { ...n, change } : n);
    }

    const dirs = current.nodes.filter((n) => n.kind === 'dir');
    for (const n of parent?.nodes ?? []) {
        if (n.kind === 'dir' || ids.has(n.id) || !inScope(n.file)) {
            continue;
        }
        // A removed file goes in the folder that holds it now; its symbols stay in it.
        const parentId = n.parent && (ids.has(n.parent) || isRemoved(before.get(n.parent), ids, inScope)) ? n.parent : folderFor(n.file, dirs);
        nodes.push({ ...n, parent: parentId, change: 'removed' });
        counts.removed++;
    }

    return { ...current, nodes, stats: { ...current.stats, changes: counts } };
}

function isRemoved(n: GraphNode | undefined, ids: Set<string>, inScope: (file: string) => boolean): boolean {
    return !!n && n.kind !== 'dir' && !ids.has(n.id) && inScope(n.file);
}

/** Does a hunk overlap the node's lines? A file counts if any hunk is in it. */
function touched(n: GraphNode, hunks: Hunks): boolean {
    const ranges = hunks.get(n.file);
    if (!ranges?.length) {
        return false;
    }
    if (n.kind === 'file' || n.line === undefined) {
        return true;
    }
    const end = n.endLine ?? n.line;
    return ranges.some(([a, b]) => a <= end && b >= n.line!);
}

/** The deepest folder node holding `file`, if any. */
function folderFor(file: string, dirs: GraphNode[]): string | undefined {
    let best: GraphNode | undefined;
    for (const d of dirs) {
        if (file.startsWith(d.file + '/') && (!best || d.file.length > best.file.length)) {
            best = d;
        }
    }
    return best?.id;
}
