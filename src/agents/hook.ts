// src/agents/hook.ts -> out/agent-hook.js
// The hook Claude Code and Cursor run on every file they read or edit, once
// Overseer connects them (agentHub.ts copies this script to .overseer/hook.js).
// It appends one line per file to the activity log the extension watches.
//
//   node hook.js <claude|cursor> <activity log>     (the hook's JSON on stdin)
//
// It only observes: it never blocks, slows or changes what the agent does.
// Every failure exits 0, and Cursor's beforeReadFile always gets "allow"
// (Cursor treats a missing or invalid answer as a refusal).

import * as fs from 'fs';
import { activityOf } from './activity';

/** Past this size the log keeps only its newest lines. */
const LOG_MAX_BYTES = 512 * 1024;
const LOG_KEEP_LINES = 500;

const [, , agent, logFile] = process.argv;
const chunks: Buffer[] = [];
let answered = false;

function answer(input: unknown): void {
    if (answered) {
        return;
    }
    answered = true;
    // Unreadable input might be a read too, and an answer to any other event is ignored.
    const event = (input as { hook_event_name?: string } | undefined)?.hook_event_name;
    if (agent === 'cursor' && (input === undefined || event === 'beforeReadFile')) {
        process.stdout.write(JSON.stringify({ permission: 'allow' }));
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
