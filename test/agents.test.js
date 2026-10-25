// AI agents: what the hook records, how Overseer's hook is added to and removed
// from each agent's settings, and the bundled hook script run as an agent would.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { graphOf } = require('./helpers'); // also lets require() load .ts
const { activityOf, parseActivity } = require('../src/agents/activity.ts');
const { renderLookup, answerSearch, searchedName, LOOKUP_HINT } = require('../src/agents/lookup.ts');
const { addClaudeHook, removeClaudeHook, hasClaudeHook, addCursorHook, removeCursorHook, hasCursorHook, hookCommand } = require('../src/agents/config.ts');

test('Claude Code tool calls become reads, edits and searches', () => {
    const at = (tool_name, tool_input) => activityOf('claude', { tool_name, tool_input, cwd: '/repo' }, 1);
    assert.deepEqual(at('Read', { file_path: '/repo/a.ts' }), { t: 1, agent: 'claude', action: 'read', path: '/repo/a.ts' });
    assert.equal(at('Edit', { file_path: '/repo/a.ts' }).action, 'edit');
    assert.equal(at('Write', { file_path: '/repo/b.ts' }).action, 'edit');
    assert.equal(at('NotebookEdit', { notebook_path: '/repo/n.ipynb' }).path, '/repo/n.ipynb');
    assert.deepEqual(at('Grep', { pattern: 'x', path: '/repo/src' }), { t: 1, agent: 'claude', action: 'search', path: '/repo/src' });
    assert.equal(at('Glob', { pattern: '**/*.ts' }).path, '/repo', 'a search without a path is the working directory');
    assert.equal(at('Bash', { command: 'ls' }), undefined);
    assert.equal(activityOf('claude', {}, 1), undefined);
});

test('Cursor hook events become reads and edits', () => {
    assert.deepEqual(activityOf('cursor', { hook_event_name: 'beforeReadFile', file_path: '/r/a.ts', content: '…' }, 2), { t: 2, agent: 'cursor', action: 'read', path: '/r/a.ts' });
    assert.equal(activityOf('cursor', { hook_event_name: 'afterFileEdit', file_path: '/r/a.ts', edits: [] }, 2).action, 'edit');
    assert.equal(activityOf('cursor', { hook_event_name: 'beforeShellExecution', command: 'ls' }, 2), undefined);
    assert.equal(activityOf('other', { tool_name: 'Read', tool_input: { file_path: '/x' } }, 2), undefined);
});

test('the log reader skips a torn last line and anything malformed', () => {
    const text = '{"t":1,"agent":"claude","action":"read","path":"/a"}\nnot json\n{"t":2,"agent":"robot","action":"read","path":"/b"}\n{"t":3,"agent":"cursor","act';
    assert.deepEqual(parseActivity(text).map((l) => l.path), ['/a']);
});

test("Claude Code settings: Overseer's hook is added once and removed cleanly, leaving other settings alone", () => {
    const mine = { permissions: { allow: ['Bash(npm test)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint.sh' }] }], Stop: [] } };
    const cmd = hookCommand('C:\\work\\app', 'claude');
    assert.equal(cmd, 'node "C:/work/app/.overseer/hook.js" claude "C:/work/app/.overseer/activity.jsonl"');
    const once = addClaudeHook(mine, cmd);
    const twice = addClaudeHook(once, cmd);
    assert.deepEqual(twice, once, 'connecting again changes nothing');
    assert.ok(hasClaudeHook(once));
    assert.equal(once.hooks.PreToolUse.length, 2);
    assert.match(once.hooks.PreToolUse[1].matcher, /^Read\|Edit\|.*Grep$/);
    assert.deepEqual(once.hooks.SessionStart, [{ hooks: [{ type: 'command', command: cmd }] }], 'and points the session to the lookup table');
    const back = removeClaudeHook(once);
    assert.deepEqual(back, mine);
    assert.ok(!hasClaudeHook(back));
    assert.deepEqual(removeClaudeHook(addClaudeHook({}, cmd)), {}, 'nothing left behind in an empty file');
});

test("Cursor hooks.json: Overseer's hook is added once and removed cleanly", () => {
    const mine = { version: 1, hooks: { beforeShellExecution: [{ command: './audit.sh' }], afterFileEdit: [{ command: './format.sh' }] } };
    const cmd = hookCommand('/work/app', 'cursor');
    const once = addCursorHook(mine, cmd);
    assert.deepEqual(addCursorHook(once, cmd), once);
    assert.ok(hasCursorHook(once));
    assert.deepEqual(once.hooks.afterFileEdit.map((h) => h.command), ['./format.sh', cmd]);
    assert.deepEqual(once.hooks.beforeReadFile, [{ command: cmd }]);
    assert.deepEqual(removeCursorHook(once), mine);
    assert.deepEqual(addCursorHook({}, cmd).version, 1);
});

test('the bundled hook logs each file and never gets in the way', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-hook-'));
    const hook = path.join(__dirname, '..', 'out', 'agent-hook.js');
    const log = path.join(dir, 'activity.jsonl');
    const run = (agent, input) => execFileSync(process.execPath, [hook, agent, log], { input, encoding: 'utf8' });
    try {
        assert.equal(run('claude', JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/repo/a.ts' } })), '');
        // Cursor treats a read hook without an answer as a refusal, so it always says allow.
        assert.deepEqual(JSON.parse(run('cursor', JSON.stringify({ hook_event_name: 'beforeReadFile', file_path: '/repo/b.ts', content: 'x' }))), { permission: 'allow' });
        assert.deepEqual(JSON.parse(run('cursor', 'not json')), { permission: 'allow' }, 'even input it cannot read');
        assert.equal(run('cursor', JSON.stringify({ hook_event_name: 'afterFileEdit', file_path: '/repo/c.ts', edits: [] })), '');
        assert.equal(run('claude', 'not json'), '', 'bad input exits quietly');
        const lines = parseActivity(fs.readFileSync(log, 'utf8'));
        assert.deepEqual(lines.map((l) => `${l.agent} ${l.action} ${l.path}`), ['claude edit /repo/a.ts', 'cursor read /repo/b.ts', 'cursor edit /repo/c.ts']);

        const start = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' });
        assert.equal(run('claude', start), '', 'no pointer before the lookup table exists');
        fs.writeFileSync(path.join(dir, 'lookup.md'), '# Code lookup table\n');
        assert.deepEqual(JSON.parse(run('claude', start)), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: LOOKUP_HINT } });

        // overseer.answerSearches: a Grep for a name in the table is answered from it, and goes through when repeated.
        fs.writeFileSync(path.join(dir, 'lookup.md'), '# Code lookup table\n\nsrc/a.ts:1-3  function load(id: string)\n');
        const grep = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'load', path: '/repo' } });
        assert.equal(run('claude', grep), '', 'off unless turned on');
        fs.writeFileSync(path.join(dir, 'config.json'), '{"answerSearches":true}');
        const denied = JSON.parse(run('claude', grep)).hookSpecificOutput;
        assert.equal(denied.permissionDecision, 'deny');
        assert.match(denied.permissionDecisionReason, /src\/a\.ts:1-3  function load/);
        assert.equal(run('claude', grep), '', 'the same search again goes through');
        assert.equal(run('claude', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'unknownName' } })), '', 'a name the table lacks goes through');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the lookup table lists each file and symbol on its own greppable line', async () => {
    const graph = await graphOf({
        'src/store.ts': ['export class Store {', '    async save(id: string): Promise<void> {', '        log(id);', '    }', '}', 'async function log(m: string) {}'].join('\n'),
        'src/app.tsx': ["import { Store } from './store';", 'export function App() {', '    new Store().save("a");', '    return <Card />;', '}', 'function Card() { return null; }'].join('\n'),
    });
    const table = renderLookup(graph);
    const rows = table.split('\n').filter((l) => l.startsWith('src/'));
    assert.deepEqual(rows, [
        'src/app.tsx  imports src/store.ts',
        'src/app.tsx:2-5  function App() (exported)  calls Store, Store.save?  renders Card', // `?`: matched by method name
        'src/app.tsx:6  function Card()',
        'src/store.ts',
        'src/store.ts:1-5  class Store (exported)',
        'src/store.ts:2-4  async Store.save(id: string): Promise<void>  calls log',
        'src/store.ts:6  async function log(m: string)',
    ]);
    assert.match(table, /^# Code lookup table\n\nWritten by Overseer from 2 files/);

    // Answering a Grep: definitions (a class with its methods) first, then the lines that use the name.
    const answer = answerSearch('Store', table).split('\n');
    assert.deepEqual(answer.slice(1, 6), [
        'Defined:',
        'src/store.ts:1-5  class Store (exported)',
        'src/store.ts:2-4  async Store.save(id: string): Promise<void>  calls log',
        'Used by (each line\'s "calls" or "imports" names it):',
        'src/app.tsx:2-5  function App() (exported)  calls Store, Store.save?  renders Card',
    ]);
    assert.ok(answerSearch('store', table).includes('Defined:\nsrc/store.ts\n'), 'a file name finds the file');
    assert.equal(answerSearch('Missing', table), undefined);
});

test('only plain names searched across folders are answered from the table', () => {
    assert.equal(searchedName({ pattern: 'writeLookup' }), 'writeLookup');
    assert.equal(searchedName({ pattern: '\\bStore\\.save\\b', path: 'src/' }), 'Store.save');
    assert.equal(searchedName({ pattern: 'load', type: 'ts' }), 'load');
    assert.equal(searchedName({ pattern: 'load\\(' }), undefined, 'a regex');
    assert.equal(searchedName({ pattern: 'not found' }), undefined, 'text');
    assert.equal(searchedName({ pattern: 'load', path: 'src/a.ts' }), undefined, 'one file');
    assert.equal(searchedName({ pattern: 'load', glob: '*.css' }), undefined);
    assert.equal(searchedName({ pattern: 'load', type: 'py' }), undefined);
});
