// src/panel.ts
// Hosts the webview (out/webview.js) and answers its messages (types.ts).
// The graph shows either the working tree (WorkspaceIndex) or the code at a
// commit, read-only (HistoryIndex).

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { AgentHub } from './agentHub';
import { switchBranch } from './git/git';
import { nodeAt } from './graph/builder';
import type { HistoryIndex } from './historyIndex';
import type { AgentEvent, AgentName, FromWebview, GraphData, HistoryData, ToWebview, ViewInfo } from './types';
import type { WorkspaceIndex } from './workspaceIndex';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const short = (sha: string) => sha.slice(0, 7);

export class GraphPanel {
    panel: vscode.WebviewPanel | undefined;
    /** Messages wait here until the webview says it's ready. */
    private queue: ToWebview[] = [];
    private ready = false;
    private view: ViewInfo = { kind: 'worktree' };
    /** The graph on screen, with its change markers. */
    private shown: GraphData | undefined;
    /** The latest history sent, for branch names and the dirty flag. */
    private history: HistoryData | undefined;
    /** The webview asked for the history, so it wants it kept current. */
    private historyWanted = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly index: WorkspaceIndex,
        private readonly historyIndex: HistoryIndex,
        private readonly agents: AgentHub,
    ) {}

    show(): void {
        if (this.panel) {
            this.panel.reveal(undefined, false);
            return;
        }
        const out = vscode.Uri.joinPath(this.context.extensionUri, 'out');
        const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        const panel = vscode.window.createWebviewPanel('overseer', 'Overseer', vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [out, media],
        });
        panel.iconPath = {
            light: vscode.Uri.joinPath(media, 'icon-light.svg'),
            dark: vscode.Uri.joinPath(media, 'icon-dark.svg'),
        };
        panel.webview.html = this.html(panel.webview, out);
        panel.onDidDispose(() => {
            this.panel = undefined;
            this.ready = false;
            this.queue = [];
            this.view = { kind: 'worktree' };
            this.historyWanted = false;
        });
        panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m).catch((err) => this.error(err)));
        this.panel = panel;
        this.ready = false;
    }

    /** Open the panel with the history strip showing. */
    showHistory(): void {
        this.show();
        this.post({ type: 'openHistory' });
    }

    error(err: unknown, seq?: number): void {
        const message = errorText(err);
        this.post({ type: 'error', message, seq });
        void vscode.window.showErrorMessage(`Overseer: ${message}`);
    }

    /**
     * Rebuild the graph on screen. `silent` (auto-refresh after a save) skips
     * the loading state, and leaves a commit alone: its code can't change.
     */
    async refresh(silent = false): Promise<void> {
        if (!this.panel || (silent && this.view.kind === 'commit')) {
            return;
        }
        if (this.view.kind === 'commit') {
            await this.viewCommit(this.view.sha, this.view.branch);
            return;
        }
        if (!silent) {
            this.post({ type: 'loading', message: 'Scanning TypeScript and JavaScript files…' });
        }
        const graph = await this.index.scan();
        await this.postWorktree();
        if (graph.stats.truncated && !silent) {
            void vscode.window.showWarningMessage(`Overseer: only the first ${graph.stats.maxFiles} files were analyzed. Raise overseer.maxFiles or narrow overseer.include to see the rest.`);
        }
    }

    /** Files an agent just read or edited, for the live map. */
    agentEvents(events: AgentEvent[]): void {
        if (this.panel && this.ready) {
            this.post({ type: 'agentActivity', events });
        }
    }

    /** Connect or disconnect an agent, chosen from a quick pick (the commands). */
    async pickAgent(action: 'connect' | 'disconnect'): Promise<void> {
        const status = this.agents.status();
        const items = (['claude', 'cursor'] as AgentName[])
            .filter((a) => status.connected[a] === (action === 'disconnect'))
            .map((a) => ({ label: a === 'claude' ? 'Claude Code' : 'Cursor', agent: a }));
        if (!items.length) {
            void vscode.window.showInformationMessage(`Overseer: ${action === 'connect' ? 'Claude Code and Cursor are both connected already.' : 'No agent is connected.'}`);
            return;
        }
        const pick = await vscode.window.showQuickPick(items, { placeHolder: action === 'connect' ? 'Show which agent on the graph?' : 'Stop following which agent?' });
        if (pick) {
            await this.setAgent(pick.agent, action === 'connect');
        }
    }

    private async setAgent(agent: AgentName, connect: boolean): Promise<void> {
        if (connect) {
            await this.agents.connect(agent);
        } else {
            await this.agents.disconnect(agent);
        }
        this.post({ type: 'agentStatus', status: this.agents.status() });
    }

    /** Branches moved or HEAD changed (a commit, switch or fetch): resend the history and the working tree's markers. */
    async gitChanged(): Promise<void> {
        if (!this.panel) {
            return;
        }
        if (this.historyWanted) {
            await this.sendHistory();
        }
        if (this.view.kind === 'worktree' && this.index.graph) {
            await this.postWorktree();
        }
    }

    /** Open the graph on the symbol under the editor's cursor. */
    async revealAtCursor(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        this.show();
        if (!this.index.graph) {
            await this.refresh();
        }
        if (!editor || !this.index.graph) {
            return;
        }
        if (this.view.kind === 'commit') {
            await this.postWorktree(); // the editor shows the working tree
        }
        const file = this.index.relPathOf(editor.document.uri);
        const node = nodeAt(this.index.graph, file, editor.selection.active.line + 1);
        if (node) {
            this.post({ type: 'focus', nodeId: node.id });
        } else {
            void vscode.window.showInformationMessage(`Overseer: ${file} isn't in the graph. Check overseer.include and overseer.exclude.`);
        }
    }

    private post(message: ToWebview): void {
        if (!this.panel) {
            return;
        }
        if (this.ready) {
            void this.panel.webview.postMessage(message);
        } else {
            this.queue.push(message);
        }
    }

    /** Show the working tree's graph, marked against HEAD. */
    private async postWorktree(seq?: number): Promise<void> {
        const graph = this.index.graph;
        if (!graph) {
            await this.refresh();
            return;
        }
        this.view = { kind: 'worktree' };
        this.shown = await this.historyIndex.worktreeView(graph).catch(() => graph);
        if (this.view.kind === 'worktree') {
            this.post({ type: 'graph', data: this.shown, view: this.view, seq });
        }
    }

    private async viewCommit(sha: string, branch?: string, seq?: number): Promise<void> {
        try {
            const { graph, parent } = await this.historyIndex.commitView(sha);
            const c = this.history?.commits.find((x) => x.sha === sha);
            const headBranch = this.history?.headBranch;
            const local = branch && this.history?.branches.find((b) => b.name === branch)?.remote ? branch.slice(branch.indexOf('/') + 1) : branch;
            this.view = {
                kind: 'commit',
                sha,
                subject: c?.subject ?? '',
                author: c?.author ?? '',
                time: c?.time ?? 0,
                parent,
                branch,
                canSwitch: !!branch && local !== headBranch,
            };
            this.shown = graph;
            this.post({ type: 'graph', data: graph, view: this.view, seq });
        } catch (err) {
            this.error(err, seq);
        }
    }

    private async sendHistory(): Promise<void> {
        try {
            const history = await this.historyIndex.history();
            if (!history) {
                this.history = undefined;
                this.post({ type: 'historyError', message: "This folder isn't in a Git repository, so there's no history to show." });
                return;
            }
            this.history = history;
            this.post({ type: 'history', data: history });
        } catch (err) {
            this.post({ type: 'historyError', message: errorText(err) });
        }
    }

    private async onMessage(m: FromWebview): Promise<void> {
        switch (m.type) {
            case 'ready':
                this.ready = true;
                for (const queued of this.queue.splice(0)) {
                    void this.panel?.webview.postMessage(queued);
                }
                this.post({ type: 'agentStatus', status: this.agents.status() });
                this.post({ type: 'agentActivity', events: this.agents.recent() });
                if (this.shown) {
                    this.post({ type: 'graph', data: this.shown, view: this.view });
                } else if (this.index.graph) {
                    await this.postWorktree();
                } else {
                    await this.refresh();
                }
                break;
            case 'open':
                await this.openSource(m.file, m.line, m.before);
                break;
            case 'refresh':
                await this.refresh();
                break;
            case 'loadHistory':
                this.historyWanted = true;
                await this.sendHistory();
                break;
            case 'viewCommit':
                await this.viewCommit(m.sha, m.branch, m.seq);
                break;
            case 'viewWorktree':
                await this.postWorktree(m.seq);
                break;
            case 'switchBranch':
                await this.switchTo(m.branch);
                break;
            case 'diff':
                await this.diff(m.file, m.line);
                break;
            case 'connectAgent':
                await this.setAgent(m.agent, true);
                break;
            case 'disconnectAgent':
                await this.setAgent(m.agent, false);
                break;
        }
    }

    /** Check out a branch, after asking. Git refuses if uncommitted changes would be overwritten. */
    private async switchTo(name: string): Promise<void> {
        const repo = await this.historyIndex.repo();
        const branch = this.history?.branches.find((b) => b.name === name);
        if (!repo || !branch) {
            return;
        }
        const detail = this.history?.dirty
            ? 'You have uncommitted changes. Git carries them over to the branch, or stops without changing anything if they would be overwritten.'
            : 'The files in your workspace change to match the branch.';
        const choice = await vscode.window.showWarningMessage(`Switch to ${name}?`, { modal: true, detail }, 'Switch');
        if (choice !== 'Switch') {
            return;
        }
        try {
            await switchBranch(repo, branch);
        } catch (err) {
            void vscode.window.showErrorMessage(`Overseer: couldn't switch to ${name}. ${errorText(err)}`);
            return;
        }
        this.view = { kind: 'worktree' };
        await this.index.scan();
        await this.postWorktree();
        await this.sendHistory();
    }

    /** Compare a file with the version before: the commit's parent, or HEAD for the working tree. */
    private async diff(file: string, line: number): Promise<void> {
        const name = file.slice(file.lastIndexOf('/') + 1);
        let left: vscode.Uri;
        let right: vscode.Uri;
        let title: string;
        if (this.view.kind === 'commit') {
            const parent = this.view.parent;
            left = parent ? this.historyIndex.uriFor(parent, file) : this.historyIndex.uriFor('', file);
            right = this.historyIndex.uriFor(this.view.sha, file);
            title = `${name} (${parent ? short(parent) : 'empty'} ↔ ${short(this.view.sha)})`;
        } else {
            const uri = this.index.uriFor(file);
            left = this.historyIndex.uriFor('HEAD', file);
            right = uri ?? this.historyIndex.uriFor('', file);
            title = `${name} (HEAD ↔ Working Tree)`;
        }
        const pos = new vscode.Position(Math.max(0, (line || 1) - 1), 0);
        await vscode.commands.executeCommand('vscode.diff', left, right, title, { selection: new vscode.Range(pos, pos) });
    }

    /**
     * Open a file at a 1-based line in the editor group next to the graph: from
     * disk, or read-only at the commit shown. `before` opens the version before
     * the change: the commit's parent, or HEAD for the working tree.
     */
    private async openSource(file: string, line: number, before = false): Promise<void> {
        let uri: vscode.Uri | undefined;
        if (this.view.kind === 'commit') {
            const sha = before ? this.view.parent : this.view.sha;
            uri = sha ? this.historyIndex.uriFor(sha, file) : undefined;
        } else {
            uri = before ? this.historyIndex.uriFor('HEAD', file) : this.index.uriFor(file);
        }
        if (!uri) {
            return;
        }
        const doc = await vscode.workspace.openTextDocument(uri);
        const pos = new vscode.Position(Math.min(Math.max(0, (line || 1) - 1), Math.max(0, doc.lineCount - 1)), 0);
        await vscode.window.showTextDocument(doc, {
            viewColumn: this.panel?.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Beside : vscode.ViewColumn.One,
            selection: new vscode.Range(pos, pos),
        });
    }

    private html(webview: vscode.Webview, out: vscode.Uri): string {
        const nonce = crypto.randomBytes(16).toString('base64');
        const js = webview.asWebviewUri(vscode.Uri.joinPath(out, 'webview.js'));
        const css = webview.asWebviewUri(vscode.Uri.joinPath(out, 'webview.css'));
        // Cytoscape positions its canvas with inline styles, hence 'unsafe-inline' for styles only.
        const csp = [
            "default-src 'none'",
            `img-src ${webview.cspSource} data:`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `font-src ${webview.cspSource}`,
            `script-src 'nonce-${nonce}'`,
        ].join('; ');
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Overseer</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
    }
}
