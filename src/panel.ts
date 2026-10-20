// src/panel.ts
// Hosts the webview (out/webview.js) and answers its messages (types.ts).

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { nodeAt } from './graph/builder';
import type { FromWebview, GraphData, ToWebview } from './types';
import type { WorkspaceIndex } from './workspaceIndex';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class GraphPanel {
    panel: vscode.WebviewPanel | undefined;
    /** Messages wait here until the webview says it's ready. */
    private queue: ToWebview[] = [];
    private ready = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly index: WorkspaceIndex,
    ) {}

    show(): void {
        if (this.panel) {
            this.panel.reveal(undefined, false);
            return;
        }
        const out = vscode.Uri.joinPath(this.context.extensionUri, 'out');
        const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        const panel = vscode.window.createWebviewPanel('graphyfy', 'Graphyfy', vscode.ViewColumn.Beside, {
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
        });
        panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m).catch((err) => this.error(err)));
        this.panel = panel;
        this.ready = false;
    }

    error(err: unknown): void {
        const message = errorText(err);
        this.post({ type: 'error', message });
        void vscode.window.showErrorMessage(`Graphyfy: ${message}`);
    }

    /** Rescan and send the graph. `silent` (auto-refresh) skips the loading state. */
    async refresh(silent = false): Promise<void> {
        if (!this.panel) {
            return;
        }
        if (!silent) {
            this.post({ type: 'loading', message: 'Scanning TypeScript and JavaScript files…' });
        }
        const graph = await this.index.scan();
        this.postGraph(graph);
        if (graph.stats.truncated && !silent) {
            void vscode.window.showWarningMessage(`Graphyfy: only the first ${graph.stats.maxFiles} files were analyzed. Raise graphyfy.maxFiles or narrow graphyfy.include to see the rest.`);
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
        const file = this.index.relPathOf(editor.document.uri);
        const node = nodeAt(this.index.graph, file, editor.selection.active.line + 1);
        if (node) {
            this.post({ type: 'focus', nodeId: node.id });
        } else {
            void vscode.window.showInformationMessage(`Graphyfy: ${file} isn't in the graph. Check graphyfy.include and graphyfy.exclude.`);
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

    private postGraph(graph: GraphData): void {
        this.post({ type: 'graph', data: graph });
    }

    private async onMessage(m: FromWebview): Promise<void> {
        switch (m.type) {
            case 'ready':
                this.ready = true;
                for (const queued of this.queue.splice(0)) {
                    void this.panel?.webview.postMessage(queued);
                }
                if (this.index.graph) {
                    this.postGraph(this.index.graph);
                } else {
                    await this.refresh();
                }
                break;
            case 'open':
                await this.openSource(m.file, m.line);
                break;
            case 'refresh':
                await this.refresh();
                break;
        }
    }

    /** Open a file at a 1-based line in the editor group next to the graph. */
    private async openSource(file: string, line: number): Promise<void> {
        const uri = this.index.uriFor(file);
        if (!uri) {
            return;
        }
        const doc = await vscode.workspace.openTextDocument(uri);
        const pos = new vscode.Position(Math.min(Math.max(0, (line || 1) - 1), doc.lineCount - 1), 0);
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
<title>Graphyfy</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
    }
}
