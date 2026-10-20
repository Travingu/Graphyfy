// Parser and graph builder: what becomes a node, and which names resolve to what.
const test = require('node:test');
const assert = require('node:assert/strict');
const { graphOf, edgeList } = require('./helpers');

test('imports resolve with and without extensions, through index files and .js -> .ts', async () => {
    const g = await graphOf({
        'src/main.ts': `import { a } from './a';\nimport b from './lib';\nimport { c } from './c.js';\nimport React from 'react';`,
        'src/a.ts': 'export const a = () => 1;',
        'src/lib/index.ts': 'export default function b() {}',
        'src/c.ts': 'export function c() {}',
    });
    assert.deepEqual(edgeList(g, 'import'), [
        'import src/main.ts -> src/a.ts',
        'import src/main.ts -> src/c.ts',
        'import src/main.ts -> src/lib/index.ts',
    ]);
});

test('calls follow named, default, aliased and namespace imports', async () => {
    const g = await graphOf({
        'main.ts': `
import { format as fmt } from './util';
import save from './save';
import * as math from './math';
export function main() { fmt(); save(); math.add(); }`,
        'util.ts': 'export function format() {}',
        'save.ts': 'export default async function save() {}',
        'math.ts': 'export const add = (a: number, b: number) => a + b;',
    });
    assert.deepEqual(edgeList(g, 'call'), [
        'call main.ts:main -> math.ts:add',
        'call main.ts:main -> save.ts:save',
        'call main.ts:main -> util.ts:format',
    ]);
});

test('re-exports are followed, including export * and barrels', async () => {
    const g = await graphOf({
        'app.ts': `import { parse, Lexer } from './lang';\nexport function run() { parse(); new Lexer(); }`,
        'lang/index.ts': `export { parse } from './parser';\nexport * from './lexer';`,
        'lang/parser.ts': 'export function parse() {}',
        'lang/lexer.ts': 'export class Lexer { constructor() {} }',
    });
    assert.deepEqual(edgeList(g, 'call'), ['call app.ts:run -> lang/lexer.ts:Lexer.constructor', 'call app.ts:run -> lang/parser.ts:parse']);
});

test('methods: this, super, typed parameters, fields and new', async () => {
    const g = await graphOf({
        'repo.ts': `
export class Repo { find(id: string) {} }
export class Base { save() {} }`,
        'service.ts': `
import { Repo, Base } from './repo';
export class Service extends Base {
    constructor(private repo: Repo) { super(); }
    load(id: string) { this.repo.find(id); this.check(); }
    check() {}
    save() { super.save(); }
}
export function useIt(r: Repo) { r.find('x'); const s = new Service(r); s.load('y'); }`,
    });
    assert.deepEqual(edgeList(g, 'call'), [
        'call service.ts:Service.load -> repo.ts:Repo.find',
        'call service.ts:Service.load -> service.ts:Service.check',
        'call service.ts:Service.save -> repo.ts:Base.save',
        'call service.ts:useIt -> repo.ts:Repo.find',
        'call service.ts:useIt -> service.ts:Service.constructor',
        'call service.ts:useIt -> service.ts:Service.load',
    ]);
    assert.deepEqual(edgeList(g, 'extends'), ['extends service.ts:Service -> repo.ts:Base']);
});

test('implements and interface extends', async () => {
    const g = await graphOf({
        'shapes.ts': `
interface Named { name: string }
export interface Shape extends Named { area(): number }
export class Circle implements Shape { name = 'c'; area() { return 1; } }`,
    });
    assert.deepEqual(edgeList(g, 'implements'), ['implements shapes.ts:Circle -> shapes.ts:Shape']);
    assert.deepEqual(edgeList(g, 'extends'), ['extends shapes.ts:Shape -> shapes.ts:Named']);
});

test('JSX renders components, wrapped default exports included', async () => {
    const g = await graphOf({
        'App.tsx': `
import Card from './Card';
import { Layout } from './Layout';
export default function App() { return <Layout><Card title="x" /><div /></Layout>; }`,
        'Card.tsx': 'function Card(props: { title: string }) { return <p>{props.title}</p>; }\nexport default memo(Card);',
        'Layout.jsx': 'export const Layout = ({ children }) => <main>{children}</main>;',
    });
    assert.deepEqual(edgeList(g, 'render'), ['render App.tsx:App -> Card.tsx:Card', 'render App.tsx:App -> Layout.jsx:Layout']);
});

test('CommonJS: require, module.exports and exports.f', async () => {
    const g = await graphOf({
        'index.js': `
const log = require('./log');
const { add } = require('./math');
const db = require('./db');
function start() { log('hi'); add(1, 2); db.connect(); }
start();`,
        'log.js': 'module.exports = function log(msg) {}',
        'math.js': 'function add(a, b) { return a + b; }\nmodule.exports = { add };',
        'db.js': 'exports.connect = function () {};',
    });
    assert.deepEqual(edgeList(g, 'call'), [
        'call index.js -> index.js:start',
        'call index.js:start -> db.js:connect',
        'call index.js:start -> log.js:log',
        'call index.js:start -> math.js:add',
    ]);
});

test('an unknown receiver guesses only a unique, uncommon method name', async () => {
    const g = await graphOf({
        'a.ts': `
class Store { checkout() {} get() {} }
class Cache { get() {} }
export function go(x: any) { x.checkout(); x.get(); console.log(); fetchIt(); }`,
    });
    assert.deepEqual(edgeList(g, 'call'), ['call a.ts:go -> a.ts:Store.checkout ?']);
});

test('folders with a single sub-folder merge, and .d.ts files are skipped', async () => {
    const g = await graphOf({
        'packages/core/src/a.ts': 'export {}',
        'packages/core/src/b.ts': 'export {}',
        'packages/core/src/types.d.ts': 'declare const x: number;',
    });
    const dirs = g.nodes.filter((n) => n.kind === 'dir').map((n) => n.label);
    assert.deepEqual(dirs, ['packages/core/src']);
    assert.equal(g.stats.files, 2);
});

test('arrow functions, class field handlers and signatures', async () => {
    const g = await graphOf({
        'w.ts': `
export const fetchUser = async (id: string): Promise<void> => {};
export class Widget { static create() {} onClick = () => { this.render(); }; render() {} }`,
    });
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    assert.equal(byId.get('function:w.ts:fetchUser').signature, 'async fetchUser(id: string): Promise<void>');
    assert.equal(byId.get('function:w.ts:fetchUser').exported, true);
    assert.equal(byId.get('method:w.ts:Widget.create').isStatic, true);
    assert.equal(byId.get('method:w.ts:Widget.onClick').parent, 'class:w.ts:Widget');
    assert.deepEqual(edgeList(g, 'call'), ['call w.ts:Widget.onClick -> w.ts:Widget.render']);
});

test('a name guess only reaches classes in files the caller imports', async () => {
    const g = await graphOf({
        'app/main.ts': `import './store';
export function go(s: any, el: any) { s.persist(); el.archive(); }`,
        'app/store.ts': 'export class Store { persist() {} }',
        'other/Unrelated.ts': 'export class Unrelated { archive() {} }',
    });
    assert.deepEqual(edgeList(g, 'call'), ['call app/main.ts:go -> app/store.ts:Store.persist ?']);
});

test('a nullable type annotation still types the receiver', async () => {
    const g = await graphOf({
        'm.ts': `class View { fit() {} }\nlet view: View | undefined;\nexport function go() { view?.fit(); }`,
    });
    assert.deepEqual(edgeList(g, 'call'), ['call m.ts:go -> m.ts:View.fit']);
});
