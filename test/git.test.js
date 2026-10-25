// Git history: timeline lanes, diff hunks, change markers, and the git
// commands against a real repository made in a temp folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { graphOf } = require('./helpers');
const { assignLanes } = require('../src/git/lanes.ts');
const { markChanges } = require('../src/git/changes.ts');
const { parseHunks, findRepo, readHistory, listTree, readBlobs, diffHunks, firstParent, switchBranch } = require('../src/git/git.ts');

/** Commits from `{ sha: [parents] }`, newest first as written. */
const commits = (spec) => Object.entries(spec).map(([sha, parents]) => ({ sha, parents, author: 'a', time: 0, subject: sha }));
/** `sha@lane` for each commit, oldest first (left to right on the timeline). */
const lanesOf = (layout) =>
    [...layout.points]
        .sort((a, b) => a[1].column - b[1].column)
        .map(([sha, p]) => `${sha}@${p.lane}`)
        .join(' ');

test('a straight history stays in one lane', () => {
    const layout = assignLanes(commits({ c: ['b'], b: ['a'], a: [] }));
    assert.equal(lanesOf(layout), 'a@0 b@0 c@0');
    assert.equal(layout.lanes, 1);
    assert.deepEqual(layout.edges.map((e) => `${e.from}->${e.to}@${e.via}`), ['c->b@0', 'b->a@0']);
});

test('a branch gets its own lane and its merge joins back', () => {
    // a - b ------ m
    //      \- f1 -/
    const layout = assignLanes(commits({ m: ['b', 'f1'], f1: ['b'], b: ['a'], a: [] }));
    assert.equal(lanesOf(layout), 'a@0 b@0 f1@1 m@0');
    assert.deepEqual(
        layout.edges.map((e) => `${e.from}->${e.to}@${e.via}`),
        ['m->b@0', 'm->f1@1', 'f1->b@1', 'b->a@0'],
    );
});

test('two branch tips from one root use two lanes, and a freed lane is reused', () => {
    const layout = assignLanes(commits({ x2: ['x1'], y1: ['r'], x1: ['r'], r: [] }));
    assert.equal(lanesOf(layout), 'r@0 x1@0 y1@1 x2@0');
    assert.equal(layout.lanes, 2);
    // The second tip's line ends at r; nothing still waits in lane 1 afterwards.
    assert.ok(layout.edges.some((e) => e.from === 'y1' && e.to === 'r' && e.via === 1));
});

test('the checked-out line runs along the top lane, even when another branch is newer', () => {
    // r - main1        (HEAD)
    //   \- exp1 - exp2  (newer)
    const layout = assignLanes(commits({ exp2: ['exp1'], exp1: ['r'], main1: ['r'], r: [] }), 'main1');
    assert.equal(lanesOf(layout), 'r@0 main1@0 exp1@1 exp2@1');
});

test('an octopus merge opens a lane per extra parent', () => {
    const layout = assignLanes(commits({ m: ['a', 'b', 'c'], c: ['r'], b: ['r'], a: ['r'], r: [] }));
    assert.equal(layout.points.get('m').lane, 0);
    assert.deepEqual(new Set(['a', 'b', 'c'].map((s) => layout.points.get(s).lane)), new Set([0, 1, 2]));
    assert.equal(layout.lanes, 3);
});

test('a parent older than the history shown is a cut line, not a lane kept forever', () => {
    const layout = assignLanes(commits({ b: ['a'], a: ['older'] }));
    assert.deepEqual(layout.cut, [{ from: 'a', via: 0 }]);
    assert.equal(layout.lanes, 1);
});

test('diff hunks give changed line ranges on the new side', () => {
    const hunks = parseHunks(
        [
            'diff --git a/src/a.ts b/src/a.ts',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -3,2 +3,4 @@ function x',
            '@@ -10 +12 @@',
            '@@ -20,3 +21,0 @@',
            'diff --git a/gone.ts b/gone.ts',
            '--- a/gone.ts',
            '+++ /dev/null',
            '@@ -1,5 +0,0 @@',
        ].join('\n'),
    );
    assert.deepEqual([...hunks], [['src/a.ts', [[3, 6], [12, 12], [21, 22]]]]);
});

test('changes: added, modified and removed nodes, with ghosts of a removed file', async () => {
    const before = await graphOf({
        'src/a.ts': 'export function keep() {}\nexport function edit() {\n  return 1;\n}\nexport function drop() {}',
        'src/old.ts': 'export class Old {\n  run() {}\n}',
    });
    const after = await graphOf({
        'src/a.ts': 'export function keep() {}\nexport function edit() {\n  return 2;\n}\nexport function added() {}',
        'src/b.ts': 'export function b() {}',
    });
    const g = markChanges(after, before, new Map([['src/a.ts', [[3, 3], [5, 5]]]]));
    const change = (id) => g.nodes.find((n) => n.id === id)?.change;
    assert.equal(change('function:src/a.ts:keep'), undefined);
    assert.equal(change('function:src/a.ts:edit'), 'modified');
    assert.equal(change('function:src/a.ts:added'), 'added');
    assert.equal(change('file:src/a.ts'), 'modified');
    assert.equal(change('file:src/b.ts'), 'added');
    assert.equal(change('function:src/a.ts:drop'), 'removed');
    assert.equal(change('file:src/old.ts'), 'removed');
    assert.equal(change('class:src/old.ts:Old'), 'removed');
    assert.equal(change('method:src/old.ts:Old.run'), 'removed');
    // Ghosts sit where they were: the class in its removed file, the file in a folder that still exists.
    assert.equal(g.nodes.find((n) => n.id === 'class:src/old.ts:Old').parent, 'file:src/old.ts');
    assert.ok(g.nodes.some((n) => n.id === g.nodes.find((x) => x.id === 'file:src/old.ts').parent));
    assert.deepEqual(g.stats.changes, { added: 3, modified: 2, removed: 4 });
});

function hasGit() {
    try {
        execFileSync('git', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

test('reads history, trees, blobs and diffs from a real repository', { skip: !hasGit() && 'git is not on PATH' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-git-'));
    const run = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: dir, encoding: 'utf8' });
    const write = (file, text) => {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), text);
    };
    try {
        run('init', '-q', '-b', 'main');
        write('app/src/a.ts', 'export function a() {}\n');
        run('add', '.');
        run('commit', '-q', '-m', 'First');
        write('app/src/a.ts', 'export function a() {\n  return 1;\n}\n');
        run('commit', '-q', '-am', 'Change a');
        run('switch', '-q', '-c', 'feature');
        write('app/src/b.ts', 'export function b() {}\n');
        run('add', '.');
        run('commit', '-q', '-m', 'Add b');
        run('switch', '-q', 'main');

        const repo = await findRepo(path.join(dir, 'app'));
        assert.equal(repo.prefix, 'app/');
        assert.equal(await findRepo(os.tmpdir()), undefined);

        const history = await readHistory(repo, 10);
        assert.deepEqual(history.commits.map((c) => c.subject), ['Add b', 'Change a', 'First']);
        assert.equal(history.headBranch, 'main');
        assert.equal(history.dirty, false);
        assert.deepEqual(history.branches.map((b) => b.name).sort(), ['feature', 'main']);
        assert.equal((await readHistory(repo, 2)).truncated, true);

        const tip = history.branches.find((b) => b.name === 'feature').sha;
        const tree = await listTree(repo, tip);
        assert.deepEqual(tree.map((e) => e.path), ['app/src/a.ts', 'app/src/b.ts']);
        const texts = await readBlobs(repo, tree.map((e) => e.blob));
        assert.equal(texts.get(tree[1].blob), 'export function b() {}\n');

        const second = history.commits[1].sha;
        assert.equal(await firstParent(repo, second), history.commits[2].sha);
        assert.equal(await firstParent(repo, history.commits[2].sha), undefined);
        const hunks = await diffHunks(repo, history.commits[2].sha, second);
        assert.deepEqual([...hunks.keys()], ['src/a.ts']);

        // Uncommitted changes, then switching: the working tree follows, nothing is lost.
        write('app/src/a.ts', 'export function a() {\n  return 2;\n}\n');
        assert.equal((await readHistory(repo, 10)).dirty, true);
        assert.deepEqual([...(await diffHunks(repo, 'HEAD')).keys()], ['src/a.ts']);
        run('checkout', '--', '.');
        await switchBranch(repo, history.branches.find((b) => b.name === 'feature'));
        assert.equal((await readHistory(repo, 10)).headBranch, 'feature');
        assert.ok(fs.existsSync(path.join(dir, 'app/src/b.ts')));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
