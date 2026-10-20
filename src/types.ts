// src/types.ts
// The graph and the messages shared by the extension host (src/) and the
// webview (webview/). Plain data only: everything here crosses postMessage.

export type Grammar = 'typescript' | 'tsx' | 'javascript';

export type NodeKind = 'dir' | 'file' | 'class' | 'interface' | 'type' | 'enum' | 'function' | 'method';

/**
 * - import:     file -> file it imports (or re-exports, or requires)
 * - call:       function -> function it calls, or a class it constructs with `new`
 * - render:     component -> component it renders as JSX (`<Card />`)
 * - extends:    class -> base class, interface -> interface it extends
 * - implements: class -> interface
 */
export type EdgeKind = 'import' | 'call' | 'render' | 'extends' | 'implements';

/** Where a relationship appears in the source. Lines are 1-based. */
export interface Site {
    file: string;
    line: number;
}

/** Node ids look like `<kind>:<file>` or `<kind>:<file>:<qname>`. */
export interface GraphNode {
    id: string;
    kind: NodeKind;
    label: string;
    /** `Class.method` for methods, the plain name otherwise. */
    qname?: string;
    parent?: string;
    /** Workspace-relative path with `/` separators (the folder path for a dir). */
    file: string;
    line?: number;
    endLine?: number;
    signature?: string;
    exported?: boolean;
    isAsync?: boolean;
    isStatic?: boolean;
    grammar?: Grammar;
}

export interface GraphEdge {
    id: string;
    kind: EdgeKind;
    source: string;
    target: string;
    /** How many times the relationship occurs. */
    n: number;
    /** The first few places it occurs. */
    sites?: Site[];
    /** Matched by method name only: the receiver's type wasn't known. */
    uncertain?: boolean;
}

export interface GraphStats {
    files: number;
    functions: number;
    classes: number;
    edges: number;
    /** Files tree-sitter couldn't fully parse. Everything else in them is still in the graph. */
    parseErrors: string[];
    truncated?: boolean;
    maxFiles?: number;
    ms?: number;
}

export interface GraphData {
    title: string;
    nodes: GraphNode[];
    edges: GraphEdge[];
    stats: GraphStats;
}

export type ToWebview =
    | { type: 'loading'; message: string }
    | { type: 'graph'; data: GraphData }
    | { type: 'error'; message: string }
    | { type: 'focus'; nodeId: string };

export type FromWebview =
    | { type: 'ready' }
    | { type: 'open'; file: string; line: number }
    | { type: 'refresh' };
