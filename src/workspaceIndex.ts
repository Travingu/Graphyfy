// src/workspaceIndex.ts
// Finds the workspace's TypeScript and JavaScript files (graphyfy.include,
// exclude and maxFiles), parses them and keeps the latest graph. Files whose
// text hasn't changed keep their parse between scans.

import * as vscode from 'vscode';
import { buildGraph, type Source } from './graph/builder';
import { initParsers, type ParsedFile } from './parser';
import type { GraphData } from './types';

/** Files read at once while scanning. */
const READ_BATCH = 64;
const DEFAULT_INCLUDE = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}';

const decoder = new TextDecoder('utf-8');

export class WorkspaceIndex {
    graph: GraphData | undefined;
    private readonly parsedCache = new Map<string, ParsedFile>();
    private readonly uriByPath = new Map<string, vscode.Uri>();
    private scanning: Promise<GraphData> | undefined;

    constructor(private readonly wasmDir: string) {}

    /** Rescan the workspace. Concurrent calls share one scan. */
    scan(): Promise<GraphData> {
        this.scanning ??= this.doScan().finally(() => {
            this.scanning = undefined;
        });
        return this.scanning;
    }

    private async doScan(): Promise<GraphData> {
        await initParsers(this.wasmDir);
        const cfg = vscode.workspace.getConfiguration('graphyfy');
        const include = cfg.get<string>('include') || DEFAULT_INCLUDE;
        const exclude = cfg.get<string>('exclude') || null;
        const maxFiles = Math.max(1, cfg.get<number>('maxFiles') ?? 3000);
        const folders = vscode.workspace.workspaceFolders ?? [];
        const multiRoot = folders.length > 1;

        const uris = await vscode.workspace.findFiles(include, exclude, maxFiles + 1);
        const truncated = uris.length > maxFiles;
        if (truncated) {
            uris.length = maxFiles;
        }

        // Unsaved editor text wins over the file on disk.
        const openDocs = new Map(vscode.workspace.textDocuments.map((d) => [d.uri.toString(), d]));
        const sources: Source[] = [];
        this.uriByPath.clear();
        for (let i = 0; i < uris.length; i += READ_BATCH) {
            const chunk = uris.slice(i, i + READ_BATCH);
            const texts = await Promise.all(
                chunk.map(async (uri) => {
                    const doc = openDocs.get(uri.toString());
                    if (doc) {
                        return doc.getText();
                    }
                    try {
                        return decoder.decode(await vscode.workspace.fs.readFile(uri));
                    } catch {
                        return undefined; // deleted or unreadable since findFiles
                    }
                }),
            );
            chunk.forEach((uri, j) => {
                const text = texts[j];
                if (text === undefined) {
                    return;
                }
                const rel = vscode.workspace.asRelativePath(uri, multiRoot).replace(/\\/g, '/');
                this.uriByPath.set(rel, uri);
                sources.push({ path: rel, text });
            });
        }
        for (const key of this.parsedCache.keys()) {
            if (!this.uriByPath.has(key)) {
                this.parsedCache.delete(key);
            }
        }

        const title = folders.length ? folders.map((f) => f.name).join(', ') : 'Workspace';
        const graph = buildGraph(sources, this.parsedCache, title);
        graph.stats.truncated = truncated || undefined;
        graph.stats.maxFiles = maxFiles;
        this.graph = graph;
        return graph;
    }

    /**
     * The file behind a workspace-relative path from the graph. Only files the
     * last scan read are known, so a path from the webview can't reach
     * anything outside the workspace.
     */
    uriFor(relPath: string): vscode.Uri | undefined {
        return this.uriByPath.get(relPath);
    }

    /** The workspace-relative path the graph uses for a file. */
    relPathOf(uri: vscode.Uri): string {
        const multiRoot = (vscode.workspace.workspaceFolders ?? []).length > 1;
        return vscode.workspace.asRelativePath(uri, multiRoot).replace(/\\/g, '/');
    }
}
