// src/agents/config.ts
// Adds Overseer's hook to, and removes it from, each agent's hook settings,
// leaving everything else in them as it was:
//   Claude Code: .claude/settings.local.json  { hooks: { PreToolUse: [{ matcher, hooks: [{ type, command }] }], SessionStart: [{ hooks: [...] }] } }
//   Cursor:      .cursor/hooks.json           { version: 1, hooks: { beforeReadFile: [{ command }], afterFileEdit: [...] } }
// Overseer's entries are the ones whose command runs `.overseer/hook.js`.
// No vscode imports, so the tests use it directly.

import { CLAUDE_TOOLS, CURSOR_EVENTS } from './activity';

type Json = Record<string, unknown>;
interface CommandHook {
    type?: string;
    command?: string;
}
interface MatcherGroup {
    matcher?: string;
    hooks?: CommandHook[];
}

export const HOOK_SCRIPT = '.overseer/hook.js';

/**
 * The command an agent runs. `node` comes from PATH (checked when connecting)
 * so the command reads the same in bash, cmd and PowerShell.
 */
export function hookCommand(root: string, agent: 'claude' | 'cursor'): string {
    const dir = root.replace(/\\/g, '/').replace(/\/$/, '');
    return `node "${dir}/${HOOK_SCRIPT}" ${agent} "${dir}/.overseer/activity.jsonl"`;
}

const isOurs = (command: unknown) => typeof command === 'string' && command.replace(/\\/g, '/').includes(HOOK_SCRIPT);

// ---- Claude Code ------------------------------------------------------------------

/** PreToolUse records each file; SessionStart points the agent to the lookup table (lookup.ts). */
const CLAUDE_EVENTS = ['PreToolUse', 'SessionStart'];

export function hasClaudeHook(settings: Json): boolean {
    return CLAUDE_EVENTS.some((e) => groups(settings, e).some((g) => g.hooks?.some((h) => isOurs(h.command))));
}

export function addClaudeHook(settings: Json, command: string): Json {
    const out = removeClaudeHook(settings);
    const hooks = { ...((out.hooks as Json | undefined) ?? {}) };
    hooks.PreToolUse = [...groups(out, 'PreToolUse'), { matcher: CLAUDE_TOOLS.join('|'), hooks: [{ type: 'command', command }] }];
    hooks.SessionStart = [...groups(out, 'SessionStart'), { hooks: [{ type: 'command', command }] }];
    return { ...out, hooks };
}

export function removeClaudeHook(settings: Json): Json {
    const hooks = settings.hooks as Json | undefined;
    if (!hooks || !CLAUDE_EVENTS.some((e) => Array.isArray(hooks[e]))) {
        return settings;
    }
    const rest: Json = { ...hooks };
    for (const e of CLAUDE_EVENTS) {
        if (!Array.isArray(hooks[e])) {
            continue;
        }
        const kept = (hooks[e] as MatcherGroup[])
            .map((g) => ({ ...g, hooks: g.hooks?.filter((h) => !isOurs(h.command)) }))
            .filter((g) => !g.hooks || g.hooks.length > 0);
        rest[e] = kept;
        if (!kept.length) {
            delete rest[e];
        }
    }
    const out: Json = { ...settings, hooks: rest };
    if (!Object.keys(rest).length) {
        delete out.hooks;
    }
    return out;
}

function groups(settings: Json, event: string): MatcherGroup[] {
    const list = (settings.hooks as Json | undefined)?.[event];
    return Array.isArray(list) ? (list as MatcherGroup[]) : [];
}

// ---- Cursor ---------------------------------------------------------------------------

export function hasCursorHook(config: Json): boolean {
    const hooks = (config.hooks as Record<string, CommandHook[]> | undefined) ?? {};
    return CURSOR_EVENTS.some((e) => Array.isArray(hooks[e]) && hooks[e].some((h) => isOurs(h.command)));
}

export function addCursorHook(config: Json, command: string): Json {
    const out = removeCursorHook(config);
    const hooks = { ...((out.hooks as Record<string, CommandHook[]> | undefined) ?? {}) };
    for (const e of CURSOR_EVENTS) {
        hooks[e] = [...(hooks[e] ?? []), { command }];
    }
    return { version: 1, ...out, hooks };
}

export function removeCursorHook(config: Json): Json {
    const hooks = config.hooks as Record<string, CommandHook[]> | undefined;
    if (!hooks) {
        return config;
    }
    const rest: Record<string, CommandHook[]> = {};
    for (const [event, list] of Object.entries(hooks)) {
        const kept = Array.isArray(list) ? list.filter((h) => !isOurs(h.command)) : list;
        if (!Array.isArray(kept) || kept.length) {
            rest[event] = kept;
        }
    }
    return { ...config, hooks: rest };
}
