// The token estimate: a Claude Code transcript measured for what Overseer
// saved it, and what an answered Grep would have printed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
require('./helpers'); // lets require() load .ts
const { measureSession, grepOutputChars, CHARS_PER_TOKEN } = require('../src/agents/usage.ts');
const { answerSearch, LOOKUP_HINT } = require('../src/agents/lookup.ts');

const root = path.resolve('/repo');
const at = (f) => path.join(root, f);
const TABLE = 'src/a.ts:3-9  function load(id: string) (exported)  calls parse\nsrc/b.ts:1-4  function parse(s: string) (exported)\n';

/** A transcript: each step is an assistant request (with a tool call) and its result. */
function transcript(steps, extra = []) {
    const lines = [{ type: 'user', sessionId: 's1', cwd: root, timestamp: '2026-10-25T10:00:00Z', message: { role: 'user', content: 'go' } }, ...extra];
    steps.forEach(([name, input, result], i) => {
        const id = `toolu_${i}`;
        const message = { id: `msg_${i}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 } };
        // Claude Code writes one line per content block, repeating the usage.
        lines.push({ type: 'assistant', message }, { type: 'assistant', message });
        lines.push({ type: 'user', timestamp: `2026-10-25T10:0${i + 1}:00Z`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] } });
    });
    lines.push({ type: 'assistant', message: { id: 'msg_end', role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 5 } } });
    lines.push({ type: 'ai-title', aiTitle: 'Fix loading', sessionId: 's1' });
    return lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"type":"assist';
}

const ws = (grep = 900, lines = 400) => ({ grepChars: async () => grep, lineCount: async () => lines });

test('the tokens used are summed once per request, from the transcript', async () => {
    const u = await measureSession(transcript([['Bash', { command: 'ls' }, 'a.ts']]), root, ws());
    assert.equal(u.requests, 2);
    assert.equal(u.used, 1160 + 15);
    assert.equal(u.id, 's1');
    assert.equal(u.title, 'Fix loading');
    assert.equal(u.saved, 0);
    assert.equal(u.spent, 0, 'no hint, no table: Overseer cost nothing');
});

test('an answered search saves what the grep would have printed, on every later request', async () => {
    const answer = answerSearch('load', TABLE);
    const u = await measureSession(transcript([['Grep', { pattern: 'load' }, answer]]), root, ws(900));
    assert.equal(u.answered, 1);
    assert.equal(u.saved, Math.round(900 / CHARS_PER_TOKEN), 'one later request carried it');
    assert.equal(u.spent, Math.round(answer.length / CHARS_PER_TOKEN));
});

test('an answer the agent ran again saves nothing and costs its text', async () => {
    const answer = answerSearch('load', TABLE);
    const u = await measureSession(transcript([['Grep', { pattern: 'load' }, answer], ['Grep', { pattern: 'load' }, 'src/a.ts\nsrc/c.ts']]), root, ws(900));
    assert.equal(u.answered, 0);
    assert.equal(u.repeated, 1);
    assert.equal(u.saved, 0);
    assert.equal(u.spent, Math.round((answer.length * 2) / CHARS_PER_TOKEN), 'two later requests carried it');
});

test('a ranged read of lines the table pointed to saves the rest of the file; other reads save nothing', async () => {
    const range = Array.from({ length: 7 }, (_, i) => `${i + 3}\tline`).join('\n');
    const u = await measureSession(
        transcript([
            ['Grep', { pattern: 'load', path: '.overseer/lookup.md', output_mode: 'content' }, TABLE.split('\n')[0]],
            ['Read', { file_path: at('src/a.ts'), offset: 3, limit: 7 }, range],
            ['Read', { file_path: at('src/b.ts'), offset: 1, limit: 4 }, range],
            ['Read', { file_path: at('src/a.ts') }, range],
        ]),
        root,
        ws(900, 70),
    );
    assert.equal(u.tableLookups, 1);
    assert.equal(u.guidedReads, 1, 'src/b.ts was never pointed to, and a whole-file read is no saving');
    const whole = range.length * 10; // 70 lines, 7 shown
    assert.equal(u.saved, Math.round(((whole - range.length) * 3) / CHARS_PER_TOKEN), 'three later requests carried it');
});

test("the session hint counts against Overseer on every request, and compaction ends a result's run", async () => {
    const hint = { type: 'attachment', attachment: { type: 'hook_additional_context', content: [LOOKUP_HINT] } };
    const compact = { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' };
    const answer = answerSearch('load', TABLE);
    const lines = transcript([['Grep', { pattern: 'load' }, answer], ['Bash', { command: 'ls' }, 'x']], [hint]).split('\n');
    // Compact right after the answer (the prompt, the hint, two lines of the request, then its result): no later request carries it.
    lines.splice(5, 0, JSON.stringify(compact));
    const u = await measureSession(lines.join('\n'), root, ws(900));
    assert.equal(u.saved, 0);
    assert.equal(u.spent, Math.round((LOOKUP_HINT.length * u.requests) / CHARS_PER_TOKEN));
});

test("a grep's estimated output follows Claude Code's modes, path, glob, type and head_limit", () => {
    const files = [
        { path: at('src/a.ts'), text: 'export function load() {}\nload();\n' },
        { path: at('src/b.ts'), text: 'nothing here\n' },
        { path: at('docs/notes.md'), text: 'call load first\n' },
    ];
    const chars = (input) => grepOutputChars(files, input, root);
    assert.equal(chars({ pattern: 'load' }), 'Found 2 files\n'.length + 'src/a.ts\ndocs/notes.md'.length);
    assert.equal(chars({ pattern: 'load', type: 'ts' }), 'Found 1 files\n'.length + 'src/a.ts'.length);
    assert.equal(chars({ pattern: 'load', glob: '*.md' }), 'Found 1 files\n'.length + 'docs/notes.md'.length);
    assert.equal(chars({ pattern: 'load', path: 'src', output_mode: 'count' }), 'src/a.ts:2'.length);
    assert.equal(chars({ pattern: 'load', output_mode: 'content', type: 'ts' }), 'src/a.ts:1:export function load() {}\nsrc/a.ts:2:load();'.length);
    assert.equal(chars({ pattern: 'load', output_mode: 'content', head_limit: 1 }), 'src/a.ts:1:export function load() {}'.length);
    assert.equal(chars({ pattern: 'LOAD', '-i': true, output_mode: 'count' }), 'src/a.ts:2\ndocs/notes.md:1'.length);
    assert.equal(chars({ pattern: '(' }), undefined, 'not a regex JavaScript can run');
});
