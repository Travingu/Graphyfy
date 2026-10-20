// src/extension.ts
// Registers the commands in package.json and keeps the graph current while
// editing. The panel (panel.ts) talks to the webview; the workspace index
// (workspaceIndex.ts) finds, parses and builds.

import * as vscode from 'vscode';
import { GraphPanel } from './panel';
import { SOURCE_FILE } from './parser';
import { WorkspaceIndex } from './workspaceIndex';

/** Wait after a save, create or delete before rebuilding, so a burst of changes rebuilds once. */
const AUTO_REFRESH_DELAY_MS = 800;

export function activate(context: vscode.ExtensionContext): void {
    const index = new WorkspaceIndex(context.asAbsolutePath('out/parsers'));
    const panel = new GraphPanel(context, index);

    const run = (fn: () => Promise<unknown>) => () => fn().catch((err) => panel.error(err));

    context.subscriptions.push(
        vscode.commands.registerCommand('graphyfy.open', () => panel.show()),
        vscode.commands.registerCommand(
            'graphyfy.refresh',
            run(async () => {
                panel.show();
                await panel.refresh();
            }),
        ),
        vscode.commands.registerCommand('graphyfy.reveal', run(() => panel.revealAtCursor())),
    );

    // Keep the graph current while editing.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
        if (!panel.panel || !vscode.workspace.getConfiguration('graphyfy').get('autoRefresh')) {
            return;
        }
        clearTimeout(timer);
        timer = setTimeout(() => panel.refresh(true).catch(() => {}), AUTO_REFRESH_DELAY_MS);
    };
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}', false, true, false);
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (SOURCE_FILE.test(doc.fileName.replace(/\\/g, '/'))) {
                schedule();
            }
        }),
        watcher,
        watcher.onDidCreate(schedule),
        watcher.onDidDelete(schedule),
        { dispose: () => clearTimeout(timer) },
    );
}

export function deactivate(): void {}
