// src/graph/builder.ts
// Turns parsed files into GraphData (types.ts). No vscode imports, so the
// tests run it directly.
//
// Nodes:
//  - one per folder (a chain of folders holding one sub-folder and no files is one node: `src/core`)
//  - one per file, inside its folder
//  - top-level functions, classes, interfaces, type aliases and enums, inside their file
//  - methods, inside their class
//
// Edges: import, call, render, extends, implements.
//
// Names resolve the way the module system does: a name defined in the file,
// else the import that binds it, followed through the other file's exports and
// re-exports. Member calls use what's known about the receiver (`this`, a
// typed parameter, `new X()`, a namespace import); a call on a receiver of
// unknown type goes to the one method with that name among the files the
// caller's file imports (directly or through others), marked uncertain, or
// nowhere if there are several.

import * as path from 'path';
import { hashString } from '../util/hash';
import { parseSource, SOURCE_FILE, type CallInfo, type ParsedFile, type TypeInfo } from '../parser';
import type { EdgeKind, GraphData, GraphEdge, GraphNode, NodeKind, Site } from '../types';

const posix = path.posix;

/** Places kept per edge. */
const SITE_LIMIT = 8;
/** Extensions tried, in order, for an import specifier without one. */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
/** TypeScript ESM imports name the compiled file: `./util.js` means `./util.ts`. */
const COMPILED_TO_SOURCE: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
/** How deep re-export chains are followed. */
const MAX_REEXPORT_DEPTH = 8;
/**
 * Receivers that are platform globals: `console.log()` never means a `log`
 * method in the workspace.
 */
const GLOBAL_RECEIVERS = new Set(
    'console Math JSON Object Array Promise Number String Boolean Symbol Date Reflect Proxy Intl window document globalThis process navigator localStorage sessionStorage location history performance crypto URL Buffer'.split(' '),
);
/** Method names too common to guess from: `arr.map()` shouldn't point at a `map` method in the workspace. */
const COMMON_METHODS = new Set(
    [
        // arrays, maps, sets, strings, promises
        'map filter reduce forEach find findIndex some every includes indexOf push pop shift unshift slice splice concat join sort reverse flat flatMap fill',
        'keys values entries get set has delete add clear replace split trim startsWith endsWith padStart match test exec then catch finally',
        'toString valueOf call apply bind parse stringify assign create freeze',
        // DOM and events
        'remove toggle contains append prepend appendChild removeChild matches closest querySelector querySelectorAll addEventListener removeEventListener',
        'setAttribute getAttribute focus blur click scrollIntoView dispatchEvent preventDefault stopPropagation',
        // common verbs on all sorts of objects
        'emit on off once next resolve reject send write end close open start stop init update render run subscribe unsubscribe dispatch listen use log error warn info debug',
    ]
        .join(' ')
        .split(' '),
);

export interface Source {
    /** Workspace-relative, `/` separators. */
    path: string;
    text: string;
}

export function nodeId(kind: NodeKind, file: string, qname?: string): string {
    return qname === undefined ? `${kind}:${file}` : `${kind}:${file}:${qname}`;
}

/** Parse `sources` and build the graph. `cache` (path -> parse) skips files whose text hasn't changed. */
export function buildGraph(sources: Source[], cache?: Map<string, ParsedFile>, title = 'Workspace'): GraphData {
    const started = Date.now();
    const files: ParsedFile[] = [];
    for (const src of sources) {
        if (!SOURCE_FILE.test(src.path)) {
            continue;
        }
        let parsed = cache?.get(src.path);
        if (!parsed || parsed.hash !== hashString(src.text)) {
            parsed = parseSource(src.path, src.text);
            cache?.set(src.path, parsed);
        }
        files.push(parsed);
    }
    const graph = buildFromParsed(files, title);
    graph.stats.ms = Date.now() - started;
    return graph;
}

/** One file's top-level names. */
interface Scope {
    file: string;
    /** Functions, classes and types defined here, by name. */
    locals: Map<string, GraphNode>;
    /** Imported names -> where they come from. */
    bindings: Map<string, { target?: string; imported: string }>;
}

interface ClassRecord {
    node: GraphNode;
    info: TypeInfo;
    file: string;
    methods: Map<string, GraphNode>;
    bases?: ClassRecord[];
}

/** What a name resolves to: a node, or a whole module (a namespace import). */
type Resolved = { node: GraphNode } | { module: string };

export function buildFromParsed(files: ParsedFile[], title = 'Workspace'): GraphData {
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const fileSet = new Set(files.map((f) => f.filePath));
    const parsedByPath = new Map(files.map((f) => [f.filePath, f]));

    const addNode = (node: GraphNode) => {
        if (!nodes.has(node.id)) {
            nodes.set(node.id, node);
        }
        return nodes.get(node.id)!;
    };
    const addEdge = (kind: EdgeKind, source: string, target: string, site: Site, uncertain = false) => {
        if (source === target) {
            return;
        }
        const id = `${kind}:${source}->${target}`;
        let e = edges.get(id);
        if (!e) {
            e = { id, kind, source, target, n: 0, sites: [] };
            if (uncertain) {
                e.uncertain = true;
            }
            edges.set(id, e);
        } else if (e.uncertain && !uncertain) {
            delete e.uncertain;
        }
        e.n++;
        if (e.sites!.length < SITE_LIMIT) {
            e.sites!.push(site);
        }
    };

    // ---- folders --------------------------------------------------------------
    const dirOf = (p: string) => (p.includes('/') ? posix.dirname(p) : '');
    const dirs = new Set<string>();
    for (const file of fileSet) {
        for (let d = dirOf(file); d; d = dirOf(d)) {
            dirs.add(d);
        }
    }
    const childDirs = new Map<string, string[]>();
    for (const d of dirs) {
        push(childDirs, dirOf(d), d);
    }
    const hasFiles = new Set([...fileSet].map(dirOf));
    const dirNode = new Map<string, string | undefined>(); // folder -> id of the node that shows it
    const visitDir = (d: string, parent: string | undefined, prefix: string) => {
        const kids = (childDirs.get(d) ?? []).sort();
        if (d && kids.length === 1 && !hasFiles.has(d)) {
            visitDir(kids[0], parent, prefix + posix.basename(d) + '/');
            dirNode.set(d, dirNode.get(kids[0]));
            return;
        }
        let id = parent;
        if (d) {
            id = nodeId('dir', d);
            addNode({ id, kind: 'dir', label: prefix + posix.basename(d), parent, file: d });
        }
        dirNode.set(d, id);
        for (const k of kids) {
            visitDir(k, id, '');
        }
    };
    visitDir('', undefined, '');

    // ---- files ------------------------------------------------------------------
    const fileId = (file: string) => nodeId('file', file);
    for (const f of [...files].sort((a, b) => a.filePath.localeCompare(b.filePath))) {
        addNode({ id: fileId(f.filePath), kind: 'file', label: posix.basename(f.filePath), parent: dirNode.get(dirOf(f.filePath)), file: f.filePath, line: 1, grammar: f.grammar });
    }

    // ---- symbols --------------------------------------------------------------------
    const scopes = new Map<string, Scope>();
    const classes: ClassRecord[] = [];
    const classByNode = new Map<string, ClassRecord>();
    const methodsByName = new Map<string, GraphNode[]>();
    const fnByQname = new Map<string, Map<string, GraphNode>>(); // file -> qname -> function/method
    for (const f of files) {
        const scope: Scope = { file: f.filePath, locals: new Map(), bindings: new Map() };
        scopes.set(f.filePath, scope);
        const fns = new Map<string, GraphNode>();
        fnByQname.set(f.filePath, fns);

        for (const t of f.types) {
            const node = addNode({
                id: nodeId(t.kind, f.filePath, t.name),
                kind: t.kind,
                label: t.name,
                qname: t.name,
                parent: fileId(f.filePath),
                file: f.filePath,
                line: t.line,
                endLine: t.endLine,
                signature: t.signature,
                exported: t.exported || undefined,
            });
            if (!scope.locals.has(t.name)) {
                scope.locals.set(t.name, node);
            }
            if (t.kind === 'class' && !classByNode.has(node.id)) {
                const rec: ClassRecord = { node, info: t, file: f.filePath, methods: new Map() };
                classes.push(rec);
                classByNode.set(node.id, rec);
            }
        }
        for (const fn of f.functions) {
            const owner = fn.owner ? classByNode.get(nodeId('class', f.filePath, fn.owner)) : undefined;
            const node = addNode({
                id: nodeId(fn.kind, f.filePath, fn.qname),
                kind: fn.kind,
                label: fn.name,
                qname: fn.qname,
                parent: owner ? owner.node.id : fileId(f.filePath),
                file: f.filePath,
                line: fn.line,
                endLine: fn.endLine,
                signature: fn.signature,
                exported: fn.exported || undefined,
                isAsync: fn.isAsync || undefined,
                isStatic: fn.isStatic || undefined,
            });
            if (!fns.has(fn.qname)) {
                fns.set(fn.qname, node);
            }
            if (owner) {
                if (!owner.methods.has(fn.name)) {
                    owner.methods.set(fn.name, node);
                    push(methodsByName, fn.name, node);
                }
            } else if (!scope.locals.has(fn.name)) {
                scope.locals.set(fn.name, node);
            }
        }
    }

    // ---- imports ----------------------------------------------------------------------
    const resolveModule = (from: string, spec: string): string | undefined => {
        if (!spec.startsWith('.') && !spec.startsWith('/')) {
            return undefined; // a package (tsconfig `paths` aliases aren't read yet)
        }
        const base = posix.normalize(spec.startsWith('/') ? spec.slice(1) : posix.join(posix.dirname(from), spec));
        const ext = posix.extname(base);
        const candidates = [
            base,
            ...(COMPILED_TO_SOURCE[ext] ?? []).map((e) => base.slice(0, -ext.length) + e),
            ...EXTENSIONS.map((e) => base + e),
            ...EXTENSIONS.map((e) => `${base}/index${e}`),
        ];
        return candidates.find((c) => fileSet.has(c));
    };
    for (const f of files) {
        const scope = scopes.get(f.filePath)!;
        for (const imp of f.imports) {
            const target = resolveModule(f.filePath, imp.source);
            if (target && target !== f.filePath) {
                addEdge('import', fileId(f.filePath), fileId(target), { file: f.filePath, line: imp.line });
            }
            if (!imp.reexport) {
                for (const b of imp.bindings) {
                    scope.bindings.set(b.local, { target, imported: b.imported });
                }
            }
        }
    }

    /** The node a module exports under `name` (`default` included), following re-exports. */
    const resolveExport = (file: string, name: string, depth = 0): Resolved | undefined => {
        const parsed = parsedByPath.get(file);
        const scope = scopes.get(file);
        if (!parsed || !scope || depth > MAX_REEXPORT_DEPTH) {
            return undefined;
        }
        // Declared with `export` (or `export default`) on the declaration itself.
        const declared = [...parsed.functions, ...parsed.types].find((d) => !('owner' in d && d.owner) && d.exported && (name === 'default' ? d.isDefault : d.name === name && !d.isDefault));
        if (declared) {
            const node = scope.locals.get(declared.name);
            if (node) {
                return { node };
            }
        }
        // `export { a as b }`, `export default a`, `module.exports = { a }`.
        const listed = parsed.exports.find((e) => e.exported === name);
        if (listed) {
            const local = resolveLocal(file, listed.local, depth + 1);
            if (local) {
                return local;
            }
        }
        // Re-exports.
        for (const imp of parsed.imports) {
            if (!imp.reexport) {
                continue;
            }
            const target = resolveModule(file, imp.source);
            if (!target) {
                continue;
            }
            for (const b of imp.bindings) {
                if (b.local === name && b.imported === '*') {
                    return { module: target }; // export * as ns from './x'
                }
                if (b.local === name) {
                    return resolveExport(target, b.imported, depth + 1);
                }
                if (b.local === '*' && name !== 'default') {
                    const found = resolveExport(target, name, depth + 1);
                    if (found) {
                        return found;
                    }
                }
            }
        }
        // CommonJS: `module.exports = fn` and `require()` of it.
        if (name === 'default') {
            const cjs = parsed.functions.find((fn) => fn.isDefault && !fn.owner) ?? parsed.types.find((t) => t.isDefault);
            if (cjs) {
                const node = scope.locals.get(cjs.name);
                return node ? { node } : undefined;
            }
        }
        return undefined;
    };

    /** What a bare name means inside a file: something defined there, or what an import binds it to. */
    const resolveLocal = (file: string, name: string, depth = 0): Resolved | undefined => {
        const scope = scopes.get(file);
        if (!scope) {
            return undefined;
        }
        const own = scope.locals.get(name);
        if (own) {
            return { node: own };
        }
        const b = scope.bindings.get(name);
        if (!b?.target) {
            return undefined;
        }
        return b.imported === '*' ? { module: b.target } : resolveExport(b.target, b.imported, depth);
    };

    /** A dotted name (`ns.Base`, `Base`) seen from a file, resolved to a node. */
    const resolveDotted = (file: string, dotted: string): GraphNode | undefined => {
        const [head, ...rest] = dotted.split('.');
        let r = resolveLocal(file, head);
        for (const part of rest) {
            r = r && 'module' in r ? resolveExport(r.module, part) : undefined;
        }
        if (r && 'module' in r) {
            r = resolveExport(r.module, 'default');
        }
        return r && 'node' in r ? r.node : undefined;
    };

    const classOf = (node: GraphNode | undefined) => (node ? classByNode.get(node.id) : undefined);

    // ---- extends / implements ----------------------------------------------------------
    for (const f of files) {
        for (const t of f.types) {
            const node = nodes.get(nodeId(t.kind, f.filePath, t.name));
            if (!node) {
                continue;
            }
            const site = { file: f.filePath, line: t.line };
            for (const name of t.extends ?? []) {
                const base = resolveDotted(f.filePath, name);
                if (base) {
                    addEdge('extends', node.id, base.id, site);
                    const cls = classOf(node);
                    const baseCls = classOf(base);
                    if (cls && baseCls) {
                        (cls.bases ??= []).push(baseCls);
                    }
                }
            }
            for (const name of t.implements ?? []) {
                const iface = resolveDotted(f.filePath, name);
                if (iface) {
                    addEdge('implements', node.id, iface.id, site);
                }
            }
        }
    }

    /** A method of `cls` or the nearest base class that has one. */
    const findMethod = (cls: ClassRecord | undefined, name: string, seen = new Set<ClassRecord>()): GraphNode | undefined => {
        if (!cls || seen.has(cls)) {
            return undefined;
        }
        seen.add(cls);
        return cls.methods.get(name) ?? cls.bases?.map((b) => findMethod(b, name, seen)).find(Boolean);
    };

    /** Files whose code a file can reach: itself and what it imports, transitively. */
    const importsOf = new Map<string, Set<string>>();
    for (const f of files) {
        const targets = new Set<string>();
        for (const imp of f.imports) {
            const t = resolveModule(f.filePath, imp.source);
            if (t) {
                targets.add(t);
            }
        }
        importsOf.set(f.filePath, targets);
    }
    const reachableCache = new Map<string, Set<string>>();
    const reachableFrom = (file: string): Set<string> => {
        let seen = reachableCache.get(file);
        if (!seen) {
            seen = new Set([file]);
            const stack = [file];
            while (stack.length) {
                for (const next of importsOf.get(stack.pop()!) ?? []) {
                    if (!seen.has(next)) {
                        seen.add(next);
                        stack.push(next);
                    }
                }
            }
            reachableCache.set(file, seen);
        }
        return seen;
    };

    // ---- calls and renders ---------------------------------------------------------------
    /** What a call reaches, and whether that was guessed from the method name alone. */
    const resolveCall = (file: string, call: CallInfo, callerClass: ClassRecord | undefined): { target?: GraphNode; uncertain?: boolean } => {
        const kind = call.kind;
        /** `new X()` reaches X's constructor, or X itself when it has none. */
        const constructed = (node: GraphNode | undefined) => {
            const cls = classOf(node);
            return cls ? (findMethod(cls, 'constructor') ?? cls.node) : node;
        };

        if (!call.member) {
            const r = resolveLocal(file, call.callee);
            const node = r && 'module' in r ? resolveExport(r.module, 'default') : r;
            const target = node && 'node' in node ? node.node : undefined;
            if (kind === 'new') {
                return { target: constructed(target) };
            }
            // A bare call inside a method can't mean a sibling method (that needs `this.`), so no class lookup here.
            // Calling a class without `new` isn't a call to it; rendering one (`<Modal />`) is.
            return { target: target?.kind === 'class' && kind !== 'render' ? undefined : target };
        }

        const receiver = call.receiver;
        if (receiver === 'this' || receiver === 'super') {
            const cls = receiver === 'super' ? callerClass?.bases?.[0] : callerClass;
            return { target: findMethod(cls, call.callee) };
        }
        if (receiver?.startsWith('this.')) {
            const type = callerClass?.info.fieldTypes?.[receiver.slice(5)];
            const cls = type ? classOf(resolveDotted(callerClass!.file, type)) : undefined;
            if (cls) {
                return { target: findMethod(cls, call.callee) };
            }
        } else if (receiver) {
            if (call.receiverType) {
                // `user: User` or `const user = new User()`
                const cls = classOf(resolveDotted(file, call.receiverType));
                if (cls) {
                    return { target: findMethod(cls, call.callee) };
                }
            }
            const r = resolveLocal(file, receiver);
            if (r && 'module' in r) {
                // `utils.format()` with `import * as utils` or `const utils = require('./utils')`
                const found = resolveExport(r.module, call.callee);
                const node = found && 'node' in found ? found.node : undefined;
                return { target: kind === 'new' ? constructed(node) : node };
            }
            if (r && 'node' in r) {
                // A static method: `User.find()`
                const cls = classOf(r.node);
                return { target: cls ? findMethod(cls, call.callee) : undefined };
            }
            if (scopes.get(file)?.bindings.has(receiver) || GLOBAL_RECEIVERS.has(receiver)) {
                return {}; // a package's or the platform's object
            }
        }
        // Unknown receiver: guess from the method name if exactly one class the file can reach has it.
        if (kind !== 'call' || COMMON_METHODS.has(call.callee)) {
            return {};
        }
        const reachable = reachableFrom(file);
        const candidates = (methodsByName.get(call.callee) ?? []).filter((m) => reachable.has(m.file));
        return candidates.length === 1 ? { target: candidates[0], uncertain: true } : {};
    };

    for (const f of files) {
        const fns = fnByQname.get(f.filePath)!;
        for (const call of f.calls) {
            const caller = call.caller ? fns.get(call.caller) : nodes.get(fileId(f.filePath));
            if (!caller) {
                continue;
            }
            const callerClass = caller.kind === 'method' ? classByNode.get(caller.parent!) : undefined;
            const { target, uncertain } = resolveCall(f.filePath, call, callerClass);
            if (!target || target.kind === 'interface' || target.kind === 'type' || target.kind === 'enum') {
                continue;
            }
            addEdge(call.kind === 'render' ? 'render' : 'call', caller.id, target.id, { file: f.filePath, line: call.line }, uncertain);
        }
    }

    const nodeList = [...nodes.values()];
    const edgeList = [...edges.values()];
    return {
        title,
        nodes: nodeList,
        edges: edgeList,
        stats: {
            files: files.length,
            functions: nodeList.filter((n) => n.kind === 'function' || n.kind === 'method').length,
            classes: nodeList.filter((n) => n.kind === 'class').length,
            edges: edgeList.length,
            parseErrors: files.filter((f) => f.hasErrors).map((f) => f.filePath),
        },
    };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
    const list = map.get(key);
    if (list) {
        list.push(value);
    } else {
        map.set(key, [value]);
    }
}

/** The innermost symbol whose lines cover `line` in `file`, or the file itself. */
export function nodeAt(graph: GraphData, file: string, line: number): GraphNode | undefined {
    let best: GraphNode | undefined;
    let bestSize = Infinity;
    for (const n of graph.nodes) {
        if (n.file !== file || n.kind === 'file' || n.kind === 'dir' || n.line === undefined) {
            continue;
        }
        const end = n.endLine ?? n.line;
        if (line >= n.line && line <= end && end - n.line < bestSize) {
            best = n;
            bestSize = end - n.line;
        }
    }
    return best ?? graph.nodes.find((n) => n.kind === 'file' && n.file === file);
}
