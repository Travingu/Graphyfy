// src/agentHub.ts
// Connects Claude Code and Cursor to Overseer, and follows what they touch.
//
// Connecting copies the hook script (out/agent-hook.js, from agents/hook.ts) to
// .overseer/hook.js in the first workspace folder and registers it in the
// agent's project settings, kept out of git:
//   Claude Code: .claude/settings.local.json
//   Cursor:      .cursor/hooks.json (added to .git/info/exclude)
// The hook appends a line to .overseer/activity.jsonl for each file read or
// edited, and this class turns new lines into AgentEvents for the graph.
// While an agent is connected, each scan also rewrites .overseer/lookup.md
// (agents/lookup.ts), which the agent is pointed to at the start of a session:
// by the hook for Claude Code, by .cursor/rules/overseer.mdc for Cursor.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseActivity, type ActivityLine } from './agents/activity';
import { addClaudeHook, addCursorHook, hasClaudeHook, hasCursorHook, hookCommand, removeClaudeHook, removeCursorHook } from './agents/config';
import { cursorRule, LOOKUP_FILE, renderLookup } from './agents/lookup';
import { git } from './git/git';
import { parseJsonc } from './graph/aliases';
import type { AgentEvent, AgentName, AgentStatus, GraphData } from './types';

/** Events sent when the panel opens, so the feed isn't empty. */
const HISTORY_EVENTS = 30;
/** Cursor has no session-start hook, so an always-applied rule points it to the lookup table. */
const CURSOR_RULE = '.cursor/rules/overseer.mdc';

const AGENTS: Record<AgentName, { label: string; file: string; has(c: Record<string, unknown>): boolean; add(c: Record<string, unknown>, cmd: string): Record<string, unknown>; remove(c: Record<string, unknown>): Record<string, unknown> }> = {
    claude: { label: 'Claude Code', file: '.claude/settings.local.json', has: hasClaudeHook, add: addClaudeHook, remove: removeClaudeHook },
    cursor: { label: 'Cursor', file: '.cursor/hooks.json', has: hasCursorHook, add: addCursorHook, remove: removeCursorHook },
};

export class AgentHub implements vscode.Disposable {
    private watcher: vscode.FileSystemWatcher | undefined;
    private offset = 0;
    private lastT = 0;
    private reading = false;

    constructor(
        private readonly scriptSource: string,
        private readonly onEvents: (events: AgentEvent[]) => void,
    ) {}

    private root(): string | undefined {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    private logFile(root: string): string {
        return path.join(root, '.overseer', 'activity.jsonl');
    }

    status(): AgentStatus {
        const root = this.root();
        const connected = { claude: false, cursor: false };
        if (root) {
            for (const agent of Object.keys(AGENTS) as AgentName[]) {
                connected[agent] = AGENTS[agent].has(readJson(path.join(root, AGENTS[agent].file)) ?? {});
            }
        }
        return { available: !!root, connected };
    }

    /** An agent is connected, so the lookup table should be kept current. */
    lookupWanted(): boolean {
        const { connected } = this.status();
        return connected.claude || connected.cursor;
    }

    /** Start following the log, and bring the hook script and settings up to date if a newer Overseer is installed. */
    start(): void {
        const root = this.root();
        if (!root) {
            return;
        }
        const s = this.status();
        if (s.connected.claude || s.connected.cursor) {
            this.installScript(root);
        }
        for (const agent of Object.keys(AGENTS) as AgentName[]) {
            if (s.connected[agent]) {
                this.writeSettings(root, agent);
            }
        }
        this.watch(root);
    }

    /** Rewrite .overseer/lookup.md from a fresh scan of the working tree, while an agent is connected. */
    writeLookup(graph: GraphData): void {
        const root = this.root();
        if (!root || !this.lookupWanted()) {
            return;
        }
        const file = path.join(root, LOOKUP_FILE);
        const text = renderLookup(graph);
        if (readText(file) !== text) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, text);
        }
    }

    /** The newest events in the log, for a feed that just opened. */
    recent(): AgentEvent[] {
        const root = this.root();
        if (!root) {
            return [];
        }
        const text = readText(this.logFile(root)) ?? '';
        return parseActivity(text).slice(-HISTORY_EVENTS).map((l) => this.toEvent(l));
    }

    async connect(agent: AgentName): Promise<boolean> {
        const root = this.root();
        if (!root) {
            void vscode.window.showInformationMessage('Overseer: open a folder first.');
            return false;
        }
        const { label, file } = AGENTS[agent];
        if (!(await hasNode())) {
            void vscode.window.showErrorMessage(`Overseer: connecting ${label} needs Node.js on your PATH, to run the hook. Install Node.js and try again.`);
            return false;
        }
        const target = path.join(root, file);
        const current = fs.existsSync(target) ? readJson(target) : {};
        if (!current) {
            void vscode.window.showErrorMessage(`Overseer: ${file} isn't valid JSON, so it wasn't changed. Fix it and connect again.`);
            return false;
        }
        const choice = await vscode.window.showInformationMessage(
            `Connect ${label} to Overseer?`,
            {
                modal: true,
                detail: `Overseer adds a hook to ${file} that records each file ${label} reads or edits in .overseer/, so the graph can show it live. It never blocks or changes what ${label} does, unless you turn on overseer.answerSearches. Overseer also keeps a lookup table of your code in ${LOOKUP_FILE} and points ${label} to it, so it can find functions without reading whole files. Everything stays on this machine and out of git.`,
            },
            'Connect',
        );
        if (choice !== 'Connect') {
            return false;
        }
        this.installScript(root);
        this.writeSettings(root, agent, current);
        await keepOutOfGit(root, file);
        if (agent === 'cursor') {
            await keepOutOfGit(root, CURSOR_RULE);
        }
        this.watch(root);
        void vscode.window.showInformationMessage(`Overseer: ${label} is connected. Its reads and edits show on the graph from its next file access.`);
        return true;
    }

    async disconnect(agent: AgentName): Promise<void> {
        const root = this.root();
        if (!root) {
            return;
        }
        const target = path.join(root, AGENTS[agent].file);
        const current = readJson(target);
        if (current && AGENTS[agent].has(current)) {
            fs.writeFileSync(target, JSON.stringify(AGENTS[agent].remove(current), null, 2) + '\n');
        }
        if (agent === 'cursor') {
            fs.rmSync(path.join(root, CURSOR_RULE), { force: true });
        }
        if (!this.lookupWanted()) {
            fs.rmSync(path.join(root, LOOKUP_FILE), { force: true });
        }
    }

    dispose(): void {
        this.watcher?.dispose();
    }

    /** Copy the hook script into .overseer/, which ignores itself in git. */
    private installScript(root: string): void {
        const dir = path.join(root, '.overseer');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '.gitignore'), "# Overseer's local files: the agent hook, its activity log and the code lookup table.\n*\n");
        fs.copyFileSync(this.scriptSource, path.join(dir, 'hook.js'));
        this.writeHookConfig();
    }

    /** The settings the hook reads (it can't see VS Code's): .overseer/config.json. */
    writeHookConfig(): void {
        const root = this.root();
        if (!root || !fs.existsSync(path.join(root, '.overseer'))) {
            return;
        }
        const answerSearches = vscode.workspace.getConfiguration('overseer').get<boolean>('answerSearches') ?? false;
        fs.writeFileSync(path.join(root, '.overseer', 'config.json'), JSON.stringify({ answerSearches }) + '\n');
    }

    /** Add Overseer's hook to the agent's settings (a no-op when it's there already), and Cursor's rule pointing to the lookup table. */
    private writeSettings(root: string, agent: AgentName, current = readJson(path.join(root, AGENTS[agent].file))): void {
        const target = path.join(root, AGENTS[agent].file);
        // Compared as data, so a file that already has the hook keeps its own formatting.
        const next = current && AGENTS[agent].add(current, hookCommand(root, agent));
        if (next && (!fs.existsSync(target) || JSON.stringify(next) !== JSON.stringify(current))) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, JSON.stringify(next, null, 2) + '\n');
        }
        if (agent === 'cursor') {
            const rule = path.join(root, CURSOR_RULE);
            if (readText(rule) !== cursorRule()) {
                fs.mkdirSync(path.dirname(rule), { recursive: true });
                fs.writeFileSync(rule, cursorRule());
            }
        }
    }

    private watch(root: string): void {
        if (this.watcher) {
            return;
        }
        const log = this.logFile(root);
        this.offset = fileSize(log);
        this.lastT = Date.now();
        this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '.overseer/activity.jsonl'));
        const changed = () => void this.readNew(log);
        this.watcher.onDidChange(changed);
        this.watcher.onDidCreate(changed);
    }

    /** Lines added since the last read. The hook trims the log when it grows, which starts it over. */
    private async readNew(log: string): Promise<void> {
        if (this.reading) {
            return;
        }
        this.reading = true;
        try {
            const size = fileSize(log);
            if (size < this.offset) {
                this.offset = 0;
            }
            if (size === this.offset) {
                return;
            }
            const fd = await fs.promises.open(log, 'r');
            try {
                const buf = Buffer.alloc(size - this.offset);
                await fd.read(buf, 0, buf.length, this.offset);
                // Only up to the last newline: a line still being written waits for the next change.
                const end = buf.lastIndexOf(10) + 1;
                this.offset += end;
                const lines = parseActivity(buf.subarray(0, end).toString('utf8')).filter((l) => l.t > this.lastT);
                if (lines.length) {
                    this.lastT = lines[lines.length - 1].t;
                    this.onEvents(lines.map((l) => this.toEvent(l)));
                }
            } finally {
                await fd.close();
            }
        } catch {
            // the log was trimmed or removed mid-read; the next change reads it again
        } finally {
            this.reading = false;
        }
    }

    private toEvent(l: ActivityLine): AgentEvent {
        const abs = l.path.replace(/\\/g, '/');
        const multiRoot = (vscode.workspace.workspaceFolders ?? []).length > 1;
        const rel = vscode.workspace.asRelativePath(vscode.Uri.file(l.path), multiRoot).replace(/\\/g, '/');
        const inWorkspace = rel !== abs && !path.isAbsolute(rel);
        return { t: l.t, agent: l.agent, action: l.action, file: inWorkspace ? rel : abs, inWorkspace };
    }
}

function readText(file: string): string | undefined {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return undefined;
    }
}

/** The file's JSON object: `{}` when it doesn't exist, undefined when it isn't valid. */
function readJson(file: string): Record<string, unknown> | undefined {
    const text = readText(file);
    return text === undefined || !text.trim() ? {} : parseJsonc(text);
}

function fileSize(file: string): number {
    try {
        return fs.statSync(file).size;
    } catch {
        return 0;
    }
}

function hasNode(): Promise<boolean> {
    return new Promise((resolve) => execFile('node', ['--version'], { windowsHide: true }, (err) => resolve(!err)));
}

/** Add a file to the repo's local exclude list, unless git already ignores or tracks it. */
async function keepOutOfGit(root: string, file: string): Promise<void> {
    try {
        const ignored = await git(root, ['check-ignore', '-q', file]).then(
            () => true,
            () => false,
        );
        const tracked = (await git(root, ['ls-files', file]).catch(() => '')).trim() !== '';
        if (ignored || tracked) {
            return;
        }
        const exclude = path.resolve(root, (await git(root, ['rev-parse', '--git-path', 'info/exclude'])).trim());
        const text = readText(exclude) ?? '';
        if (!text.split(/\r?\n/).includes(file)) {
            fs.mkdirSync(path.dirname(exclude), { recursive: true });
            fs.appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}# Overseer's agent hook, local to this machine\n${file}\n`);
        }
    } catch {
        // not a git repository: nothing to keep it out of
    }
}
