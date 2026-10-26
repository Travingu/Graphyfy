// src/agents/hook.ts -> out/agent-hook.js
// The hook Claude Code and Cursor run on every file they read or edit, once
// Overseer connects them (agentHub.ts copies this script to .overseer/hook.js).
// It appends one line per file to the activity log the extension watches, and
// at the start of a Claude Code session points it to the lookup table. It
// also notes each Claude Code session's transcript in .overseer/sessions.jsonl,
// which the token estimate reads (usage.ts).
//
//   node hook.js <claude|cursor> <activity log>     (the hook's JSON on stdin)
//
// It never slows or changes what the agent does, with one opt-in exception:
// with overseer.answerSearches on (.overseer/config.json), a Claude Code Grep
// for a name the lookup table knows is answered from the table instead, and
// the same Grep run again goes through. Every failure exits 0, and Cursor's
// beforeReadFile always gets "allow" (Cursor treats a missing or invalid
// answer as a refusal).

import * as fs from 'fs';
import * as path from 'path';
import { activityOf } from './activity';
import { answerSearch, LOOKUP_FILE, LOOKUP_HINT, searchedName, type GrepInput } from './lookup';

/** Past this size the log keeps only its newest lines. */
const LOG_MAX_BYTES = 512 * 1024;
const LOG_KEEP_LINES = 500;
/** A Grep repeated within this long after being answered from the table goes through. */
const REPEAT_MS = 2 * 60 * 1000;
/** Each Claude Code session's id and transcript, one JSON line each, in .overseer/. */
const SESSIONS_FILE = 'sessions.jsonl';

const [, , agent, logFile] = process.argv;
const dir = logFile ? path.dirname(logFile) : undefined;
const chunks: Buffer[] = [];
let answered = false;

function answer(input: unknown): void {
    if (answered) {
        return;
    }
    answered = true;
    // Unreadable input might be a read too, and an answer to any other event is ignored.
    const i = input as { hook_event_name?: string; tool_name?: string; tool_input?: GrepInput } | undefined;
    const event = i?.hook_event_name;
    if (agent === 'cursor' && (input === undefined || event === 'beforeReadFile')) {
        process.stdout.write(JSON.stringify({ permission: 'allow' }));
    }
    if (agent !== 'claude' || !dir) {
        return;
    }
    // Claude Code adds the hint to the session's context, once Overseer has written the table. A session
    // already running when Overseer connected never fires SessionStart for it, so its first prompt gets it.
    const hinting = event === 'SessionStart' || event === 'UserPromptSubmit';
    const table = hinting && fs.existsSync(path.join(dir, path.basename(LOOKUP_FILE)));
    const hinted = recordSession(dir, input as SessionInput | undefined, table ? event : undefined);
    if (hinted) {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: LOOKUP_HINT } }));
    }
    if (event === 'PreToolUse' && i?.tool_name === 'Grep' && i.tool_input) {
        const reason = answerFromTable(dir, i.tool_input);
        if (reason) {
            // Claude Code shows the model the reason in place of the search results.
            process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
        }
    }
}

interface SessionInput {
    session_id?: unknown;
    transcript_path?: unknown;
}

/**
 * Note the session's transcript once, for the token estimate (usage.ts), and
 * whether it has been given the hint. Sessions started before connecting show
 * up on their next prompt or tool call. With `hintOn` (the event, when the
 * table exists): whether to give the hint now. SessionStart always does, so it
 * comes back after a compaction; a prompt only when the session never had it.
 */
function recordSession(dir: string, input: SessionInput | undefined, hintOn?: string): boolean {
    const id = input?.session_id;
    const transcript = input?.transcript_path;
    if (typeof id !== 'string' || typeof transcript !== 'string') {
        return hintOn === 'SessionStart';
    }
    let known = false;
    let hinted = false;
    const file = path.join(dir, SESSIONS_FILE);
    try {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            try {
                const s = JSON.parse(line) as { id?: unknown; hinted?: unknown };
                if (s.id === id) {
                    known = true;
                    hinted ||= s.hinted === true;
                }
            } catch {
                // a blank or torn line
            }
        }
    } catch {
        // none yet
    }
    const hint = hintOn === 'SessionStart' || (hintOn === 'UserPromptSubmit' && !hinted);
    try {
        if (!known || (hint && !hinted)) {
            fs.appendFileSync(file, JSON.stringify({ t: Date.now(), id, transcript, ...(hint ? { hinted: true } : {}) }) + '\n');
        }
    } catch {
        // the estimate misses this session, and a prompt may hint again; the agent carries on regardless
    }
    return hint;
}

/** The table's answer to a Grep, or undefined to let it run. */
function answerFromTable(dir: string, grep: GrepInput): string | undefined {
    try {
        const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as { answerSearches?: boolean };
        const name = config.answerSearches ? searchedName(grep) : undefined;
        if (!name) {
            return undefined;
        }
        // Searches answered recently, so the same one asked again goes through.
        const stateFile = path.join(dir, 'answered.json');
        const now = Date.now();
        let state: Record<string, number> = {};
        try {
            state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Record<string, number>;
        } catch {
            // none yet
        }
        for (const [k, t] of Object.entries(state)) {
            if (now - t > REPEAT_MS) {
                delete state[k];
            }
        }
        const key = JSON.stringify([grep.pattern, grep.path, grep.glob, grep.type]);
        let reason: string | undefined;
        if (state[key]) {
            delete state[key];
        } else {
            reason = answerSearch(name, fs.readFileSync(path.join(dir, path.basename(LOOKUP_FILE)), 'utf8'), grep['-i'] === true);
            if (reason) {
                state[key] = now;
            }
        }
        fs.writeFileSync(stateFile, JSON.stringify(state));
        return reason;
    } catch {
        return undefined; // no config or table: the search goes ahead
    }
}

process.stdin.on('data', (c: Buffer) => chunks.push(c));
process.stdin.on('end', () => {
    let input: unknown;
    try {
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        answer(undefined);
        return;
    }
    try {
        const line = activityOf(agent, input, Date.now());
        if (line && logFile) {
            append(logFile, JSON.stringify(line) + '\n');
        }
    } catch {
        // observing failed; the agent carries on regardless
    }
    answer(input);
});
process.stdin.on('error', () => answer(undefined));

function append(file: string, text: string): void {
    fs.appendFileSync(file, text);
    if (fs.statSync(file).size > LOG_MAX_BYTES) {
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        fs.writeFileSync(file, lines.slice(-LOG_KEEP_LINES).join('\n') + '\n');
    }
}
