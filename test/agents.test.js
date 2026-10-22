// AI agents: what the hook records, how Overseer's hook is added to and removed
// from each agent's settings, and the bundled hook script run as an agent would.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('./helpers'); // lets require() load .ts
const { activityOf, parseActivity } = require('../src/agents/activity.ts');
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
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
