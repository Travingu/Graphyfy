// src/extension.ts
// Registers the commands in package.json and keeps the graph current while
// editing. The panel (panel.ts) talks to the webview; the workspace index
// (workspaceIndex.ts) finds, parses and builds; the history index
// (historyIndex.ts) does the same for past commits; the agent hub
// (agentHub.ts) follows what AI agents read and edit.

import * as vscode from 'vscode';
import { CONFIG_FILE } from './graph/aliases';
import { AgentHub } from './agentHub';
import { GIT_SCHEME, HistoryIndex } from './historyIndex';
import { GraphPanel } from './panel';
import { SOURCE_FILE } from './parser';
import { CONFIG_GLOB, WorkspaceIndex } from './workspaceIndex';

/** Wait after a save, create or delete before rebuilding, so a burst of changes rebuilds once. */
const AUTO_REFRESH_DELAY_MS = 800;

export function activate(context: vscode.ExtensionContext): void {
    const agents = new AgentHub(context.asAbsolutePath('out/agent-hook.js'), (events) => panel.agentEvents(events));
    const index = new WorkspaceIndex(context.asAbsolutePath('out/parsers'), (graph) => agents.writeLookup(graph));
    const history = new HistoryIndex(context.asAbsolutePath('out/parsers'));
    const panel = new GraphPanel(context, index, history, agents);
    agents.start();
    // A connected agent's lookup table is kept current without the graph open.
    if (agents.lookupWanted()) {
        void index.scan().catch(() => {});
    }

    const run = (fn: () => Promise<unknown>) => () => fn().catch((err) => panel.error(err));

    context.subscriptions.push(
        vscode.commands.registerCommand('overseer.open', () => panel.show()),
        vscode.commands.registerCommand(
            'overseer.refresh',
            run(async () => {
                panel.show();
                await panel.refresh();
            }),
        ),
        vscode.commands.registerCommand('overseer.reveal', run(() => panel.revealAtCursor())),
        vscode.commands.registerCommand('overseer.history', () => panel.showHistory()),
        vscode.commands.registerCommand('overseer.connectAgent', run(() => panel.pickAgent('connect'))),
        vscode.commands.registerCommand('overseer.disconnectAgent', run(() => panel.pickAgent('disconnect'))),
        agents,
        // Files at a commit (overseer-git:/<path>?<sha>), opened read-only.
        vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, {
            provideTextDocumentContent: (uri) => history.show(uri.query, uri.path.slice(1)),
        }),
    );

    // Keep the graph current while editing.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
        if (!vscode.workspace.getConfiguration('overseer').get('autoRefresh') || !(panel.panel || agents.lookupWanted())) {
            return;
        }
        clearTimeout(timer);
        timer = setTimeout(() => {
            // Both share one scan. The panel skips it while showing a commit; the lookup table doesn't.
            if (panel.panel) {
                void panel.refresh(true).catch(() => {});
            }
            if (agents.lookupWanted()) {
                void index.scan().catch(() => {});
            }
        }, AUTO_REFRESH_DELAY_MS);
    };
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}', false, true, false);
    const configWatcher = vscode.workspace.createFileSystemWatcher(CONFIG_GLOB, false, true, false);
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            const file = doc.fileName.replace(/\\/g, '/');
            if (SOURCE_FILE.test(file) || CONFIG_FILE.test(file)) {
                schedule();
            }
        }),
        watcher,
        watcher.onDidCreate(schedule),
        watcher.onDidDelete(schedule),
        configWatcher,
        configWatcher.onDidCreate(schedule),
        configWatcher.onDidDelete(schedule),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('overseer.answerSearches')) {
                agents.writeHookConfig();
            }
        }),
        { dispose: () => clearTimeout(timer) },
    );

    // Keep the timeline current when commits, branch switches or fetches happen outside Overseer.
    let gitTimer: ReturnType<typeof setTimeout> | undefined;
    let gitWatchers: vscode.Disposable[] = [];
    const watchGit = async () => {
        gitWatchers.forEach((w) => w.dispose());
        gitWatchers = [];
        const repo = await history.repo().catch(() => undefined);
        if (!repo) {
            return;
        }
        const changed = () => {
            clearTimeout(gitTimer);
            gitTimer = setTimeout(() => panel.gitChanged().catch(() => {}), AUTO_REFRESH_DELAY_MS);
        };
        for (const [dir, glob] of [
            [repo.gitDir, 'HEAD'],
            [repo.commonDir, '{packed-refs,refs/heads/**,refs/remotes/**}'],
        ]) {
            const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), glob));
            gitWatchers.push(w, w.onDidCreate(changed), w.onDidChange(changed), w.onDidDelete(changed));
        }
    };
    void watchGit();
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            history.reset();
            void watchGit();
        }),
        { dispose: () => (clearTimeout(gitTimer), gitWatchers.forEach((w) => w.dispose())) },
    );
}

export function deactivate(): void {}
