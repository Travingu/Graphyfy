// src/historyIndex.ts
// The graph at any commit, read from git objects without checking anything
// out, and the change markers against its parent (git/changes.ts). Uses the
// repository of the first workspace folder.
//
// Parses are cached by path and blob, so moving between nearby commits only
// reparses the files that differ. Files are filtered with the same
// overseer.include, exclude and maxFiles settings as the working tree.

import picomatch from 'picomatch';
import * as vscode from 'vscode';
import { markChanges } from './git/changes';
import { diffHunks, findRepo, firstParent, listTree, readBlobs, readHistory, resolveCommit, showFile, type Hunks, type Repo } from './git/git';
import { CONFIG_FILE, readAliases } from './graph/aliases';
import { buildFromParsed } from './graph/builder';
import { initParsers, parseSource, SOURCE_FILE, type ParsedFile } from './parser';
import type { GraphData, HistoryData } from './types';
import { OWN_FILES } from './workspaceIndex';

/** URIs of files at a commit: `overseer-git:/<graph path>?<sha>`. VS Code opens them read-only. */
export const GIT_SCHEME = 'overseer-git';
/** Commit graphs kept, so going back and forth between a few commits is instant. */
const GRAPH_CACHE = 8;
const DEFAULT_INCLUDE = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}';

export class HistoryIndex {
    private repoLookup: Promise<Repo | undefined> | undefined;
    private readonly parsed = new Map<string, ParsedFile>();
    private readonly graphs = new Map<string, Promise<GraphData>>();

    constructor(private readonly wasmDir: string) {}

    /** The repository, or undefined if the workspace isn't in one. Throws if git can't run. */
    repo(): Promise<Repo | undefined> {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            return Promise.resolve(undefined);
        }
        this.repoLookup ??= findRepo(folder.uri.fsPath).catch((err) => {
            this.repoLookup = undefined; // try again next time, git may have been installed
            throw err;
        });
        return this.repoLookup;
    }

    /** Forget the repository (the workspace folders changed). */
    reset(): void {
        this.repoLookup = undefined;
        this.graphs.clear();
        this.parsed.clear();
    }

    async history(): Promise<HistoryData | undefined> {
        const repo = await this.repo();
        if (!repo) {
            return undefined;
        }
        const limit = Math.max(1, vscode.workspace.getConfiguration('overseer').get<number>('historyLimit') ?? 500);
        return readHistory(repo, limit);
    }

    /** The graph at `sha`, marked against its first parent. */
    async commitView(rev: string): Promise<{ graph: GraphData; parent?: string }> {
        const repo = await this.need();
        const sha = await resolveCommit(repo, rev);
        if (!sha) {
            throw new Error(`${rev} isn't a commit in this repository.`);
        }
        const parent = await firstParent(repo, sha);
        const [current, before, hunks] = await Promise.all([
            this.graphAt(repo, sha),
            parent ? this.graphAt(repo, parent) : undefined,
            parent ? diffHunks(repo, parent, sha) : new Map(),
        ]);
        return { graph: markChanges(current, before, this.toGraphPaths(hunks)), parent };
    }

    /**
     * The working tree's graph, marked against HEAD (saved changes only: git
     * can't see unsaved editors). Unchanged if there's no repo or no commit yet.
     */
    async worktreeView(graph: GraphData): Promise<GraphData> {
        const repo = await this.repo().catch(() => undefined);
        if (!repo) {
            return graph;
        }
        const head = await resolveCommit(repo, 'HEAD');
        if (!head) {
            return graph; // no commits yet
        }
        const [before, hunks] = await Promise.all([this.graphAt(repo, head), diffHunks(repo, head)]);
        const folder = this.graphPath('');
        return markChanges(graph, before, this.toGraphPaths(hunks), (file) => file.startsWith(folder));
    }

    /** A file's text at a commit, for the read-only editor. Empty if it didn't exist there. */
    async show(sha: string, graphPath: string): Promise<string> {
        if (!sha) {
            return ''; // the empty side of a diff
        }
        const repo = await this.need();
        return (await showFile(repo, sha, repo.prefix + this.folderPath(graphPath))) ?? '';
    }

    uriFor(sha: string, graphPath: string): vscode.Uri {
        return vscode.Uri.from({ scheme: GIT_SCHEME, path: '/' + graphPath, query: sha });
    }

    private async need(): Promise<Repo> {
        const repo = await this.repo();
        if (!repo) {
            throw new Error("This workspace isn't in a Git repository.");
        }
        return repo;
    }

    /** The graph at a commit, by its full sha (so the cache can't go stale). */
    private graphAt(repo: Repo, sha: string): Promise<GraphData> {
        let graph = this.graphs.get(sha);
        if (!graph) {
            graph = this.build(repo, sha);
            graph.catch(() => this.graphs.delete(sha));
            this.graphs.set(sha, graph);
            if (this.graphs.size > GRAPH_CACHE) {
                this.graphs.delete(this.graphs.keys().next().value!);
            }
        }
        return graph;
    }

    private async build(repo: Repo, sha: string): Promise<GraphData> {
        await initParsers(this.wasmDir);
        const cfg = vscode.workspace.getConfiguration('overseer');
        const include = picomatch(cfg.get<string>('include') || DEFAULT_INCLUDE, { dot: true });
        const excludeGlob = cfg.get<string>('exclude');
        const exclude = excludeGlob ? picomatch(excludeGlob, { dot: true }) : () => false;
        const maxFiles = Math.max(1, cfg.get<number>('maxFiles') ?? 3000);

        const entries = (await listTree(repo, sha))
            .map((e) => ({ ...e, rel: e.path.slice(repo.prefix.length) }))
            .filter((e) => !exclude(e.rel) && !OWN_FILES.test(e.rel));
        const sources = entries.filter((e) => include(e.rel) && SOURCE_FILE.test(e.rel));
        const truncated = sources.length > maxFiles;
        sources.length = Math.min(sources.length, maxFiles);
        const configs = entries.filter((e) => CONFIG_FILE.test(e.rel));

        const key = (e: { rel: string; blob: string }) => `${e.blob}:${e.rel}`;
        const toRead = [...sources.filter((e) => !this.parsed.has(key(e))), ...configs];
        const texts = await readBlobs(repo, [...new Set(toRead.map((e) => e.blob))]);

        const files: ParsedFile[] = [];
        for (const e of sources) {
            let parsed = this.parsed.get(key(e));
            const text = texts.get(e.blob);
            if (!parsed && text !== undefined) {
                parsed = parseSource(this.graphPath(e.rel), text);
                this.parsed.set(key(e), parsed);
            }
            if (parsed) {
                files.push(parsed);
            }
        }
        const aliases = readAliases(configs.flatMap((e) => (texts.has(e.blob) ? [{ path: this.graphPath(e.rel), text: texts.get(e.blob)! }] : [])));
        const graph = buildFromParsed(files, this.title(), aliases);
        graph.stats.truncated = truncated || undefined;
        graph.stats.maxFiles = maxFiles;
        return graph;
    }

    /** Hunk paths (relative to the scanned folder) as graph paths. */
    private toGraphPaths(hunks: Hunks): Hunks {
        return new Map([...hunks].map(([p, r]) => [this.graphPath(p), r]));
    }

    /** With several workspace folders, graph paths start with the folder's name (as vscode.workspace.asRelativePath does). */
    private graphPath(rel: string): string {
        const folders = vscode.workspace.workspaceFolders ?? [];
        return folders.length > 1 ? `${folders[0].name}/${rel}` : rel;
    }

    private folderPath(graphPath: string): string {
        const lead = this.graphPath('');
        return graphPath.startsWith(lead) ? graphPath.slice(lead.length) : graphPath;
    }

    /** The same title as the working tree's graph, so the boxes left open carry over. */
    private title(): string {
        const folders = vscode.workspace.workspaceFolders ?? [];
        return folders.length ? folders.map((f) => f.name).join(', ') : 'Workspace';
    }
}
