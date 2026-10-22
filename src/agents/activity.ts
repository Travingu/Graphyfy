// src/agents/activity.ts
// The activity log's lines: what the hook writes for each tool call, and how
// the extension reads them back. No vscode imports, so the hook script and the
// tests use it directly.

import type { AgentEvent, AgentName } from '../types';

/** One line of `.overseer/activity.jsonl`. The path is absolute, as the agent gave it. */
export interface ActivityLine {
    t: number;
    agent: AgentName;
    action: AgentEvent['action'];
    path: string;
}

/** Claude Code's tools, by what they do to a file. */
const CLAUDE_ACTIONS: Record<string, AgentEvent['action']> = {
    Read: 'read',
    Edit: 'edit',
    MultiEdit: 'edit',
    Write: 'edit',
    NotebookEdit: 'edit',
    Glob: 'search',
    Grep: 'search',
};

/** Cursor's hook events, by what they do to a file. */
const CURSOR_ACTIONS: Record<string, AgentEvent['action']> = {
    beforeReadFile: 'read',
    afterFileEdit: 'edit',
};

/** Matchers and events the connected hooks listen to (agentConfig.ts). */
export const CLAUDE_TOOLS = Object.keys(CLAUDE_ACTIONS);
export const CURSOR_EVENTS = Object.keys(CURSOR_ACTIONS);

/** The log line for a hook's input, or undefined if it doesn't touch a file. */
export function activityOf(agent: string | undefined, input: unknown, t: number): ActivityLine | undefined {
    const i = input as { tool_name?: string; hook_event_name?: string; tool_input?: Record<string, unknown>; file_path?: string; cwd?: string };
    if (agent === 'claude') {
        const action = i.tool_name ? CLAUDE_ACTIONS[i.tool_name] : undefined;
        const p = i.tool_input?.file_path ?? i.tool_input?.notebook_path ?? i.tool_input?.path ?? (action === 'search' ? i.cwd : undefined);
        return action && typeof p === 'string' ? { t, agent, action, path: p } : undefined;
    }
    if (agent === 'cursor') {
        const action = i.hook_event_name ? CURSOR_ACTIONS[i.hook_event_name] : undefined;
        return action && typeof i.file_path === 'string' ? { t, agent, action, path: i.file_path } : undefined;
    }
    return undefined;
}

/** The well-formed lines of a log chunk. A torn last line (still being written) is skipped. */
export function parseActivity(text: string): ActivityLine[] {
    const out: ActivityLine[] = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            const v = JSON.parse(line) as ActivityLine;
            if (typeof v.t === 'number' && (v.agent === 'claude' || v.agent === 'cursor') && typeof v.path === 'string' && v.action) {
                out.push(v);
            }
        } catch {
            // a partial line
        }
    }
    return out;
}
