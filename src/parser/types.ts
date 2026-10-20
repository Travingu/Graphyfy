// src/parser/types.ts
// What the extractor (extract.ts) reads out of one file. Names are as written
// in the source; the builder (graph/builder.ts) resolves them across files.

import type { Grammar } from '../types';

export interface Span {
    line: number;
    endLine: number;
}

/** One name an import or re-export brings in. */
export interface Binding {
    /** The name in this file (for a re-export: the name it's exported as). */
    local: string;
    /** The name in the other module: an export name, `default`, or `*` for the whole module. */
    imported: string;
}

export interface ImportInfo {
    /** The specifier as written: `./util`, `react`, `../lib/index.js`. */
    source: string;
    line: number;
    bindings: Binding[];
    /** `export { a } from './x'` and `export * from './x'`. */
    reexport?: boolean;
}

/** `export { a as b }`, `export default a`, `module.exports = a`, `exports.b = a`. */
export interface ExportInfo {
    exported: string;
    local: string;
}

export interface FunctionInfo extends Span {
    kind: 'function' | 'method';
    name: string;
    /** `Class.method` for methods, the name for functions. */
    qname: string;
    /** The class a method belongs to. */
    owner?: string;
    signature: string;
    exported?: boolean;
    isDefault?: boolean;
    isAsync?: boolean;
    isStatic?: boolean;
}

export interface TypeInfo extends Span {
    kind: 'class' | 'interface' | 'type' | 'enum';
    name: string;
    signature: string;
    exported?: boolean;
    isDefault?: boolean;
    /** Base class (one) or extended interfaces, as written: `Base`, `ns.Base`. */
    extends?: string[];
    implements?: string[];
    /** Field name -> type name, from annotations, `= new X()` and constructor parameter properties. */
    fieldTypes?: Record<string, string>;
}

export type CallKind = 'call' | 'new' | 'render';

export interface CallInfo {
    /** qname of the function or method the call is in; undefined at a module's top level. */
    caller?: string;
    kind: CallKind;
    /** The called name: `f` in `f()`, `obj.f()` and `new f()`, `Card` in `<Card />`. */
    callee: string;
    /** What a member call is made on: an identifier, `this`, `super`, or `this.field`. */
    receiver?: string;
    /** Whether the callee was reached through `.`, even when the receiver isn't recorded. */
    member?: boolean;
    /** The receiver's type when a local, parameter or module variable declares it. */
    receiverType?: string;
    line: number;
}

export interface ParsedFile {
    filePath: string;
    hash: string;
    grammar: Grammar;
    hasErrors: boolean;
    imports: ImportInfo[];
    exports: ExportInfo[];
    functions: FunctionInfo[];
    types: TypeInfo[];
    calls: CallInfo[];
}
