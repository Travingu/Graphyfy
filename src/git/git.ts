// src/git/git.ts
// The git commands Overseer runs, through the `git` on PATH. Nothing here
// changes a repository except switchBranch(). No vscode imports, so the tests
// run it directly.

import { execFile, spawn } from 'child_process';
import * as path from 'path';
import type { Branch, Commit, HistoryData } from '../types';

/** Large enough for `git log` of a few thousand commits and a big diff. */
const MAX_BUFFER = 64 * 1024 * 1024;
/** Paths in git's output as they are, not quoted and escaped. */
const BASE_ARGS = ['-c', 'core.quotePath=false'];

export class GitError extends Error {}

/** Run git in `cwd` and return its stdout. A failure carries git's own message. */
export function git(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', [...BASE_ARGS, ...args], { cwd, maxBuffer: MAX_BUFFER, windowsHide: true }, (err, stdout, stderr) => {
            if (!err) {
                resolve(stdout);
            } else if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                reject(new GitError("Git isn't installed, or isn't on PATH."));
            } else {
                reject(new GitError(stderr.trim() || err.message));
            }
        });
    });
}

export interface Repo {
    /** The repository's top folder. */
    root: string;
    /** Where the folder Overseer scans sits inside the repo: `''`, or `packages/app/`. */
    prefix: string;
    /** The .git folder (HEAD lives here) and the shared one (refs live there; they differ in a linked worktree). */
    gitDir: string;
    commonDir: string;
}

/** The repository `dir` is in, or undefined if it isn't in one. Throws if git can't run. */
export async function findRepo(dir: string): Promise<Repo | undefined> {
    let out: string;
    try {
        out = await git(dir, ['rev-parse', '--show-toplevel', '--show-prefix', '--absolute-git-dir', '--git-common-dir']);
    } catch (err) {
        if (err instanceof GitError && /not a git repository/i.test(err.message)) {
            return undefined;
        }
        throw err;
    }
    const [root, prefix, gitDir, commonDir] = out.split('\n');
    return { root: path.normalize(root), prefix, gitDir: path.normalize(gitDir), commonDir: path.resolve(dir, commonDir) };
}

/**
 * Commits on every local and remote branch, newest first in topological
 * order (a commit always before its parents), with the branch tips and HEAD.
 */
export async function readHistory(repo: Repo, limit: number): Promise<HistoryData> {
    const [log, refs, headBranch, head, status] = await Promise.all([
        git(repo.root, ['log', '--branches', '--remotes', 'HEAD', '--topo-order', `-n${limit + 1}`, '--format=%H%x1f%P%x1f%an%x1f%at%x1f%s%x1e']).catch(() => ''),
        git(repo.root, ['for-each-ref', 'refs/heads', 'refs/remotes', '--format=%(refname)%1f%(refname:short)%1f%(objectname)']),
        git(repo.root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => ''),
        git(repo.root, ['rev-parse', '-q', '--verify', 'HEAD']).catch(() => ''),
        git(repo.root, ['status', '--porcelain']),
    ]);
    const commits = parseLog(log);
    const truncated = commits.length > limit;
    commits.length = Math.min(commits.length, limit);
    const branches: Branch[] = [];
    for (const line of refs.split('\n')) {
        const [full, name, sha] = line.split('\x1f');
        // `origin/HEAD` points at another remote branch; it isn't one itself.
        if (sha && !full.endsWith('/HEAD')) {
            branches.push({ name, sha, remote: full.startsWith('refs/remotes/') });
        }
    }
    return { commits, branches, head: head.trim(), headBranch: headBranch.trim() || undefined, dirty: status.trim() !== '', truncated };
}

export function parseLog(out: string): Commit[] {
    const commits: Commit[] = [];
    for (const record of out.split('\x1e')) {
        const [sha, parents, author, time, subject] = record.replace(/^\n/, '').split('\x1f');
        if (sha) {
            commits.push({ sha, parents: parents ? parents.split(' ') : [], author, time: Number(time), subject: subject ?? '' });
        }
    }
    return commits;
}

/** The commit a revision (`HEAD`, a branch, a sha) names, or undefined if there isn't one. */
export async function resolveCommit(repo: Repo, rev: string): Promise<string | undefined> {
    const out = await git(repo.root, ['rev-parse', '-q', '--verify', `${rev}^{commit}`]).catch(() => '');
    return out.trim() || undefined;
}

/** The first parent of a commit, or undefined for a root commit. */
export function firstParent(repo: Repo, sha: string): Promise<string | undefined> {
    return resolveCommit(repo, `${sha}^1`);
}

export interface TreeEntry {
    /** Relative to the repo root, `/` separators. */
    path: string;
    blob: string;
}

/** The files in a commit under `prefix` (the whole repo for `''`). */
export async function listTree(repo: Repo, sha: string): Promise<TreeEntry[]> {
    const out = await git(repo.root, ['ls-tree', '-r', '-z', sha, '--', repo.prefix || '.']);
    const entries: TreeEntry[] = [];
    for (const line of out.split('\0')) {
        // <mode> SP <type> SP <object> TAB <path>
        const tab = line.indexOf('\t');
        const [, type, blob] = line.slice(0, tab).split(' ');
        if (type === 'blob') {
            entries.push({ path: line.slice(tab + 1), blob });
        }
    }
    return entries;
}

/** The text of each blob, read through one `git cat-file --batch`. Missing blobs are left out. */
export function readBlobs(repo: Repo, blobs: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!blobs.length) {
        return Promise.resolve(out);
    }
    return new Promise((resolve, reject) => {
        const proc = spawn('git', [...BASE_ARGS, 'cat-file', '--batch'], { cwd: repo.root, windowsHide: true });
        const chunks: Buffer[] = [];
        proc.stdout.on('data', (c: Buffer) => chunks.push(c));
        proc.on('error', (err) => reject(new GitError(err.message)));
        proc.on('close', (code) => {
            if (code !== 0) {
                reject(new GitError(`git cat-file exited with ${code}`));
                return;
            }
            const buf = Buffer.concat(chunks);
            const decoder = new TextDecoder('utf-8');
            let i = 0;
            while (i < buf.length) {
                const eol = buf.indexOf(10, i);
                if (eol < 0) {
                    break;
                }
                // `<sha> <type> <size>`, or `<name> missing`
                const [sha, type, size] = buf.toString('utf8', i, eol).split(' ');
                i = eol + 1;
                if (type === 'missing' || size === undefined) {
                    continue;
                }
                const n = Number(size);
                out.set(sha, decoder.decode(buf.subarray(i, i + n)));
                i += n + 1; // the content, then a newline
            }
            resolve(out);
        });
        proc.stdin.end(blobs.join('\n') + '\n');
    });
}

/** The text of a file at a commit, or undefined if it doesn't exist there. */
export async function showFile(repo: Repo, sha: string, repoPath: string): Promise<string | undefined> {
    return git(repo.root, ['cat-file', '-p', `${sha}:${repoPath}`]).catch(() => undefined);
}

/** Changed line ranges, 1-based and inclusive, on the newer side, by path. */
export type Hunks = Map<string, Array<[number, number]>>;

/**
 * What changed from `from` to `to` (a commit), or to the working tree when
 * `to` is undefined. Paths are relative to `repo.prefix`.
 */
export async function diffHunks(repo: Repo, from: string, to?: string): Promise<Hunks> {
    const args = ['diff', '-U0', '--no-color', '--no-renames', '--no-ext-diff'];
    if (repo.prefix) {
        args.push(`--relative=${repo.prefix}`);
    }
    args.push(from);
    if (to) {
        args.push(to);
    }
    return parseHunks(await git(repo.root, args));
}

export function parseHunks(diff: string): Hunks {
    const hunks: Hunks = new Map();
    let ranges: Array<[number, number]> | undefined;
    for (const line of diff.split('\n')) {
        if (line.startsWith('+++ ')) {
            const file = line.slice(4);
            ranges = undefined;
            if (file.startsWith('b/')) {
                ranges = [];
                hunks.set(file.slice(2), ranges);
            }
        } else if (line.startsWith('@@') && ranges) {
            const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
            if (m) {
                const start = Number(m[1]);
                const count = m[2] === undefined ? 1 : Number(m[2]);
                // Only deleted lines: they were between line `start` and the next one.
                ranges.push(count === 0 ? [start, start + 1] : [start, start + count - 1]);
            }
        }
    }
    return hunks;
}

/** Check out a branch. A remote branch (`origin/x`) checks out, or creates, the local `x` tracking it. */
export async function switchBranch(repo: Repo, branch: Branch): Promise<void> {
    const name = branch.remote ? branch.name.slice(branch.name.indexOf('/') + 1) : branch.name;
    await git(repo.root, ['switch', name]);
}
