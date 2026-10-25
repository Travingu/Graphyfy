// src/git/lanes.ts
// Lays commits out for the timeline: one column per commit, oldest on the
// left, and a lane (row) per line of history. No DOM or vscode imports: the
// webview draws the result, and the tests check it directly.
//
// Commits are walked newest first. Each lane remembers the commit it's waiting
// for. A commit takes the lane waiting for it (the lowest one, if several
// children wait for it, and those lines join there), its first parent continues
// that lane, and every other parent gets a lane: one already waiting for it, or
// the lowest free one. A lane is reserved from the child to the
// parent, so lines never overlap. The checked-out line of history is reserved
// lane 0 from the start, so it runs along the top.

import type { Commit } from '../types';

export interface LanePoint {
    column: number;
    lane: number;
}

/** A line from a commit to one of its parents, running along lane `via`. */
export interface LaneEdge {
    from: string;
    to: string;
    via: number;
}

export interface LaneLayout {
    points: Map<string, LanePoint>;
    edges: LaneEdge[];
    /** Commits with a parent older than the history shown: their line runs off the left edge. */
    cut: Array<{ from: string; via: number }>;
    lanes: number;
}

/** `commits` newest first, in topological order. `head` gets the first lane. */
export function assignLanes(commits: Commit[], head?: string): LaneLayout {
    const known = new Set(commits.map((c) => c.sha));
    const points = new Map<string, LanePoint>();
    const edges: LaneEdge[] = [];
    const cut: LaneLayout['cut'] = [];
    /** The commit each lane is waiting for; null when free. */
    const lanes: Array<string | null> = head && known.has(head) ? [head] : [];
    let width = 0;

    const free = () => {
        const i = lanes.indexOf(null);
        return i < 0 ? lanes.push(null) - 1 : i;
    };

    commits.forEach((c, i) => {
        let lane = lanes.indexOf(c.sha);
        if (lane < 0) {
            lane = free();
        }
        // Every lane that waited for this commit ends here.
        for (let j = 0; j < lanes.length; j++) {
            if (lanes[j] === c.sha) {
                lanes[j] = null;
            }
        }
        points.set(c.sha, { column: commits.length - 1 - i, lane });

        c.parents.forEach((p, k) => {
            if (!known.has(p)) {
                // Leaves the history shown. Its lane is free again straight away.
                cut.push({ from: c.sha, via: k === 0 ? lane : free() });
                return;
            }
            // The first parent always continues this lane, even if another lane waits
            // for it too: the parent then takes the lower of the two, and the other joins it.
            let via = k === 0 ? lane : lanes.indexOf(p);
            if (via < 0) {
                via = free();
            }
            lanes[via] = p;
            edges.push({ from: c.sha, to: p, via });
        });
        width = Math.max(width, lanes.length);
    });

    return { points, edges, cut, lanes: Math.max(width, 1) };
}
