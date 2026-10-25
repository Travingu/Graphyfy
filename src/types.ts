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
    /** What the commit being viewed did to this node (git/changes.ts). A `removed` node is a ghost from the parent commit. */
    change?: Change;
}

export type Change = 'added' | 'modified' | 'removed';

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
    /** Files, classes and functions the commit being viewed added, modified and removed. */
    changes?: Record<Change, number>;
}

export interface GraphData {
    title: string;
    nodes: GraphNode[];
    edges: GraphEdge[];
    stats: GraphStats;
}

// ---- git history ---------------------------------------------------------------

export interface Commit {
    sha: string;
    /** First parent first. */
    parents: string[];
    author: string;
    /** Unix seconds. */
    time: number;
    subject: string;
}

export interface Branch {
    /** `main`, or `origin/main` for a remote branch. */
    name: string;
    sha: string;
    remote: boolean;
}

export interface HistoryData {
    /** Newest first, in topological order. */
    commits: Commit[];
    branches: Branch[];
    head: string;
    /** The checked-out branch, or undefined on a detached HEAD. */
    headBranch?: string;
    /** The working tree has uncommitted changes. */
    dirty: boolean;
    /** There are more commits than overseer.historyLimit. */
    truncated: boolean;
}

/** What the graph shows: the files on disk, or the code at a commit (read-only). */
export type ViewInfo =
    | { kind: 'worktree' }
    | { kind: 'commit'; sha: string; subject: string; author: string; time: number; parent?: string; branch?: string; canSwitch: boolean };

// ---- AI agents -------------------------------------------------------------------

export type AgentName = 'claude' | 'cursor';

/** One file an agent touched, from the hook's activity log (src/agents/). */
export interface AgentEvent {
    /** Milliseconds since the epoch. */
    t: number;
    agent: AgentName;
    action: 'read' | 'edit' | 'search';
    /** Workspace-relative path, as the graph uses it; absolute when outside the workspace. */
    file: string;
    inWorkspace: boolean;
}

export interface AgentStatus {
    /** A folder is open, so there's somewhere to connect. */
    available: boolean;
    connected: Record<AgentName, boolean>;
}

export type ToWebview =
    | { type: 'agentStatus'; status: AgentStatus }
    | { type: 'agentActivity'; events: AgentEvent[] }
    | { type: 'loading'; message: string }
    | { type: 'graph'; data: GraphData; view: ViewInfo; seq?: number }
    | { type: 'error'; message: string; seq?: number }
    | { type: 'focus'; nodeId: string }
    | { type: 'openHistory' }
    | { type: 'history'; data: HistoryData }
    | { type: 'historyError'; message: string };

export type FromWebview =
    | { type: 'connectAgent'; agent: AgentName }
    | { type: 'disconnectAgent'; agent: AgentName }
    | { type: 'ready' }
    /** `before`: open the version before the change (for a removed node). */
    | { type: 'open'; file: string; line: number; before?: boolean }
    | { type: 'refresh' }
    | { type: 'loadHistory' }
    | { type: 'viewCommit'; sha: string; branch?: string; seq: number }
    | { type: 'viewWorktree'; seq: number }
    | { type: 'switchBranch'; branch: string }
    | { type: 'diff'; file: string; line: number };
