// src/parser/extract.ts
// One walk over a tree-sitter syntax tree that reads out what the graph needs.
// The TypeScript, TSX and JavaScript grammars share their node types; the
// TypeScript ones add annotations, interfaces and so on, which only show up in
// TypeScript files.
//
// Functions are the top-level ones (declarations, and `const f = () => {}`)
// plus class methods. Code inside a nested function or callback belongs to the
// function around it, and code at a module's top level to the file.

import type { Node } from 'web-tree-sitter';
import type { Grammar } from '../types';
import type { Binding, CallInfo, CallKind, FunctionInfo, ParsedFile, Span, TypeInfo } from './types';

/** The function or method whose body is being walked. */
interface FunctionContext {
    qname: string;
    /** Parameter and local variable name -> type name, for member calls. */
    vars: Map<string, string>;
}

interface Context {
    fn?: FunctionContext;
    exported?: boolean;
    isDefault?: boolean;
}

const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
const SIGNATURE_MAX = 200;

export function extract(root: Node, filePath: string, grammar: Grammar, hash: string): ParsedFile {
    const out: ParsedFile = {
        filePath,
        hash,
        grammar,
        hasErrors: root.hasError,
        imports: [],
        exports: [],
        functions: [],
        types: [],
        calls: [],
    };
    /** Module-level variable name -> type name (`const store = new Store()`). */
    const fileVars = new Map<string, string>();
    /** Name for an anonymous default export: `Button` for Button.tsx, the folder for index.ts. */
    const defaultName = anonymousName(filePath);

    const visitChildren = (node: Node, ctx: Context) => {
        for (const child of named(node)) {
            visit(child, ctx);
        }
    };

    const typeOfVar = (name: string, ctx: Context) => ctx.fn?.vars.get(name) ?? fileVars.get(name);

    const addCall = (ctx: Context, kind: CallKind, callee: string, node: Node, receiver?: string, member?: boolean) => {
        const call: CallInfo = { caller: ctx.fn?.qname, kind, callee, line: line(node) };
        if (member) {
            call.member = true;
        }
        if (receiver) {
            call.receiver = receiver;
            const type = typeOfVar(receiver, ctx);
            if (type) {
                call.receiverType = type;
            }
        }
        out.calls.push(call);
    };

    const addImport = (source: string | undefined, node: Node, bindings: Binding[] = [], reexport = false) => {
        if (source) {
            out.imports.push({ source, line: line(node), bindings, ...(reexport ? { reexport } : {}) });
        }
    };

    /** A top-level function or a method: record it, then walk its parameters and body as its own. */
    const addFunction = (fnNode: Node, name: string, ctx: Context, at: Node = fnNode, owner?: string) => {
        const qname = owner ? `${owner}.${name}` : name;
        const info: FunctionInfo = {
            kind: owner ? 'method' : 'function',
            name,
            qname,
            signature: signatureOf(fnNode, name),
            ...span(at),
        };
        if (owner) {
            info.owner = owner;
        }
        if (ctx.exported) {
            info.exported = true;
        }
        if (ctx.isDefault) {
            info.isDefault = true;
        }
        if (hasToken(fnNode, 'async')) {
            info.isAsync = true;
        }
        if (hasToken(fnNode, 'static') || (at !== fnNode && hasToken(at, 'static'))) {
            info.isStatic = true;
        }
        out.functions.push(info);
        visitChildren(fnNode, { fn: { qname, vars: new Map() } });
    };

    const addClass = (node: Node, name: string, ctx: Context) => {
        const info: TypeInfo = { kind: 'class', name, signature: squash(`class ${name} ${heritageText(node)}`), ...span(node) };
        if (ctx.exported) {
            info.exported = true;
        }
        if (ctx.isDefault) {
            info.isDefault = true;
        }
        const heritage = named(node).find((c) => c.type === 'class_heritage');
        for (const c of heritage ? named(heritage) : []) {
            if (c.type === 'extends_clause') {
                const base = expressionName(c.childForFieldName('value'));
                if (base) {
                    info.extends = [base];
                }
            } else if (c.type === 'implements_clause') {
                info.implements = named(c).map(typeName).filter(isString);
            } else {
                // JavaScript: `class A extends B` has the expression right inside the heritage.
                const base = expressionName(c);
                if (base) {
                    info.extends = [base];
                }
            }
        }
        out.types.push(info);

        const fieldTypes: Record<string, string> = {};
        for (const member of named(node.childForFieldName('body'))) {
            switch (member.type) {
                case 'method_definition': {
                    const mname = member.childForFieldName('name')?.text;
                    if (!mname) {
                        break;
                    }
                    if (mname === 'constructor') {
                        // `constructor(private repo: Repo)` declares a field.
                        for (const p of named(member.childForFieldName('parameters'))) {
                            const isProperty = named(p).some((c) => c.type === 'accessibility_modifier') || hasToken(p, 'readonly');
                            const pname = p.childForFieldName('pattern')?.text;
                            const ptype = typeName(p.childForFieldName('type'));
                            if (isProperty && pname && ptype) {
                                fieldTypes[pname] = ptype;
                            }
                        }
                    }
                    addFunction(member, mname, {}, member, name);
                    break;
                }
                case 'public_field_definition': // TypeScript
                case 'field_definition': {
                    // JavaScript
                    const fname = (member.childForFieldName('name') ?? member.childForFieldName('property'))?.text;
                    const value = member.childForFieldName('value');
                    if (fname && value && FUNCTION_VALUES.has(value.type)) {
                        addFunction(value, fname, {}, member, name); // `handle = () => {}`
                        break;
                    }
                    const ftype = typeName(member.childForFieldName('type')) ?? constructedType(value);
                    if (fname && ftype) {
                        fieldTypes[fname] = ftype;
                    }
                    if (value) {
                        visit(value, {});
                    }
                    break;
                }
                case 'method_signature':
                case 'abstract_method_signature':
                    break; // overload and abstract declarations: no body
                default:
                    visit(member, {});
            }
        }
        if (Object.keys(fieldTypes).length) {
            info.fieldTypes = fieldTypes;
        }
    };

    const addType = (node: Node, kind: 'interface' | 'type' | 'enum', ctx: Context) => {
        const name = node.childForFieldName('name')?.text;
        if (!name) {
            return;
        }
        const keyword = kind === 'type' ? 'type' : kind;
        const info: TypeInfo = { kind, name, signature: `${keyword} ${name}`, ...span(node) };
        if (ctx.exported) {
            info.exported = true;
        }
        if (ctx.isDefault) {
            info.isDefault = true;
        }
        if (kind === 'interface') {
            const clause = named(node).find((c) => c.type === 'extends_type_clause');
            const bases = named(clause).map(typeName).filter(isString);
            if (bases.length) {
                info.extends = bases;
                info.signature += ` extends ${bases.join(', ')}`;
            }
        }
        out.types.push(info);
    };

    const visitDeclarator = (d: Node, ctx: Context) => {
        const nameNode = d.childForFieldName('name');
        const value = d.childForFieldName('value');
        if (nameNode?.type === 'identifier') {
            const name = nameNode.text;
            if (!ctx.fn && value && FUNCTION_VALUES.has(value.type)) {
                addFunction(value, name, ctx, d);
                return;
            }
            if (!ctx.fn && value?.type === 'class') {
                addClass(value, name, ctx);
                return;
            }
            const required = requireSource(value);
            if (required !== undefined) {
                addImport(required, d, [{ local: name, imported: '*' }]); // const x = require('./x')
                return;
            }
            const type = typeName(d.childForFieldName('type')) ?? constructedType(value);
            if (type) {
                (ctx.fn?.vars ?? fileVars).set(name, type);
            }
        } else if (nameNode?.type === 'object_pattern') {
            const required = requireSource(value);
            if (required !== undefined) {
                addImport(required, d, patternBindings(nameNode)); // const { a, b: c } = require('./x')
                return;
            }
        }
        if (value) {
            visit(value, ctx);
        }
    };

    const visitImport = (node: Node) => {
        const bindings: Binding[] = [];
        const clause = named(node).find((c) => c.type === 'import_clause');
        for (const c of named(clause)) {
            if (c.type === 'identifier') {
                bindings.push({ local: c.text, imported: 'default' });
            } else if (c.type === 'namespace_import') {
                const id = named(c)[0];
                if (id) {
                    bindings.push({ local: id.text, imported: '*' });
                }
            } else if (c.type === 'named_imports') {
                for (const spec of named(c)) {
                    const name = spec.childForFieldName('name')?.text;
                    if (spec.type === 'import_specifier' && name) {
                        bindings.push({ local: spec.childForFieldName('alias')?.text ?? name, imported: name });
                    }
                }
            }
        }
        addImport(stringValue(node.childForFieldName('source')), node, bindings);
    };

    const visitExport = (node: Node, ctx: Context) => {
        const isDefault = hasToken(node, 'default');
        const source = node.childForFieldName('source');
        const clause = named(node).find((c) => c.type === 'export_clause');
        const specs = named(clause)
            .filter((s) => s.type === 'export_specifier')
            .map((s) => ({ name: s.childForFieldName('name')?.text, alias: s.childForFieldName('alias')?.text }))
            .filter((s): s is { name: string; alias: string | undefined } => !!s.name);

        if (source) {
            // Re-exports: `export { a as b } from './x'`, `export * as ns from './x'`, `export * from './x'`.
            const ns = named(node).find((c) => c.type === 'namespace_export');
            const nsName = ns && named(ns)[0]?.text;
            const bindings: Binding[] = clause
                ? specs.map((s) => ({ local: s.alias ?? s.name, imported: s.name }))
                : [{ local: nsName ?? '*', imported: '*' }];
            addImport(stringValue(source), node, bindings, true);
            return;
        }
        const declaration = node.childForFieldName('declaration');
        if (declaration) {
            visit(declaration, { ...ctx, exported: true, isDefault });
            return;
        }
        const value = node.childForFieldName('value');
        if (value) {
            const exportedCtx = { exported: true, isDefault: true };
            if (FUNCTION_VALUES.has(value.type)) {
                addFunction(value, value.childForFieldName('name')?.text ?? defaultName, exportedCtx);
            } else if (value.type === 'class') {
                addClass(value, value.childForFieldName('name')?.text ?? defaultName, exportedCtx);
            } else {
                // `export default Button`, or a wrapped one: `export default memo(Button)`.
                const local = value.type === 'identifier' ? value.text : wrappedIdentifier(value);
                if (local) {
                    out.exports.push({ exported: 'default', local });
                }
                visit(value, ctx);
            }
            return;
        }
        for (const s of specs) {
            out.exports.push({ exported: s.alias ?? s.name, local: s.name });
        }
    };

    /** CommonJS: `module.exports = ...`, `exports.f = ...` at a module's top level. */
    const visitAssignment = (node: Node, ctx: Context): boolean => {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (ctx.fn || !left || !right || left.type !== 'member_expression') {
            return false;
        }
        const target = left.text.replace(/\s+/g, '');
        const exportedCtx = { exported: true };
        if (target === 'module.exports') {
            if (right.type === 'identifier') {
                out.exports.push({ exported: 'default', local: right.text });
            } else if (FUNCTION_VALUES.has(right.type)) {
                addFunction(right, right.childForFieldName('name')?.text ?? defaultName, { exported: true, isDefault: true }, node);
            } else if (right.type === 'class') {
                addClass(right, right.childForFieldName('name')?.text ?? defaultName, { exported: true, isDefault: true });
            } else if (right.type === 'object') {
                for (const p of named(right)) {
                    if (p.type === 'shorthand_property_identifier') {
                        out.exports.push({ exported: p.text, local: p.text });
                    } else if (p.type === 'pair') {
                        const key = p.childForFieldName('key')?.text;
                        const value = p.childForFieldName('value');
                        if (key && value?.type === 'identifier') {
                            out.exports.push({ exported: key, local: value.text });
                        } else if (key && value && FUNCTION_VALUES.has(value.type)) {
                            addFunction(value, key, exportedCtx, p);
                        } else if (value) {
                            visit(value, ctx);
                        }
                    } else if (p.type === 'method_definition') {
                        const key = p.childForFieldName('name')?.text;
                        if (key) {
                            addFunction(p, key, exportedCtx);
                        }
                    }
                }
            } else {
                visit(right, ctx);
            }
            return true;
        }
        const m = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(target);
        if (m) {
            if (FUNCTION_VALUES.has(right.type)) {
                addFunction(right, m[1], exportedCtx, node);
            } else if (right.type === 'identifier') {
                out.exports.push({ exported: m[1], local: right.text });
            } else {
                visit(right, ctx);
            }
            return true;
        }
        return false;
    };

    const visit = (node: Node, ctx: Context): void => {
        switch (node.type) {
            case 'import_statement':
                visitImport(node);
                return;

            case 'export_statement':
                visitExport(node, ctx);
                return;

            case 'function_declaration':
            case 'generator_function_declaration': {
                const name = node.childForFieldName('name')?.text;
                if (ctx.fn || !name) {
                    break; // a nested function belongs to the one around it
                }
                addFunction(node, name, ctx);
                return;
            }

            case 'lexical_declaration':
            case 'variable_declaration':
                for (const d of named(node)) {
                    if (d.type === 'variable_declarator') {
                        visitDeclarator(d, ctx);
                    }
                }
                return;

            case 'class_declaration':
            case 'abstract_class_declaration': {
                const name = node.childForFieldName('name')?.text;
                if (!name || ctx.fn) {
                    break;
                }
                addClass(node, name, ctx);
                return;
            }

            case 'interface_declaration':
                addType(node, 'interface', ctx);
                return;
            case 'type_alias_declaration':
                addType(node, 'type', ctx);
                return;
            case 'enum_declaration':
                addType(node, 'enum', ctx);
                return;

            case 'assignment_expression':
                if (visitAssignment(node, ctx)) {
                    return;
                }
                break;

            case 'required_parameter':
            case 'optional_parameter': {
                const pname = node.childForFieldName('pattern');
                const ptype = typeName(node.childForFieldName('type'));
                if (ctx.fn && pname?.type === 'identifier' && ptype) {
                    ctx.fn.vars.set(pname.text, ptype);
                }
                break; // default values can hold calls
            }

            case 'call_expression': {
                const f = node.childForFieldName('function');
                if (f?.type === 'identifier' && f.text === 'require') {
                    addImport(requireSource(node), node); // a bare require('./x')
                    return;
                }
                if (f?.type === 'import') {
                    addImport(stringValue(named(node.childForFieldName('arguments'))[0]), node); // import('./x')
                    return;
                }
                if (f?.type === 'identifier') {
                    addCall(ctx, 'call', f.text, node);
                } else if (f?.type === 'member_expression') {
                    const property = f.childForFieldName('property')?.text;
                    if (property) {
                        addCall(ctx, 'call', property, node, receiverOf(f.childForFieldName('object')), true);
                    }
                } else if (f?.type === 'super') {
                    addCall(ctx, 'call', 'constructor', node, 'super', true);
                }
                break; // arguments can hold more calls
            }

            case 'new_expression': {
                const c = node.childForFieldName('constructor');
                if (c?.type === 'identifier') {
                    addCall(ctx, 'new', c.text, node);
                } else if (c?.type === 'member_expression') {
                    const property = c.childForFieldName('property')?.text;
                    if (property) {
                        addCall(ctx, 'new', property, node, receiverOf(c.childForFieldName('object')), true);
                    }
                }
                break;
            }

            case 'jsx_opening_element':
            case 'jsx_self_closing_element': {
                // Components start with a capital letter; <div> and friends are HTML.
                const n = node.childForFieldName('name');
                if (n?.type === 'identifier' && /^[A-Z]/.test(n.text)) {
                    addCall(ctx, 'render', n.text, node);
                } else if (n?.type === 'member_expression') {
                    const property = n.childForFieldName('property')?.text;
                    if (property) {
                        addCall(ctx, 'render', property, node, receiverOf(n.childForFieldName('object')), true);
                    }
                }
                break;
            }
        }
        visitChildren(node, ctx);
    };

    visit(root, {});
    return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function named(node: Node | null | undefined): Node[] {
    return node ? node.namedChildren.filter((c): c is Node => c !== null) : [];
}

function hasToken(node: Node, token: string): boolean {
    return node.children.some((c) => c?.type === token);
}

function isString(s: string | undefined): s is string {
    return !!s;
}

function line(node: Node): number {
    return node.startPosition.row + 1;
}

function span(node: Node): Span {
    return { line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
}

function squash(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}

function clip(s: string): string {
    return s.length > SIGNATURE_MAX ? s.slice(0, SIGNATURE_MAX - 1) + '…' : s;
}

/** The text of a plain string literal (`'./x'`, `"./x"`), or undefined. */
function stringValue(node: Node | null | undefined): string | undefined {
    if (node?.type !== 'string') {
        return undefined;
    }
    return named(node).find((c) => c.type === 'string_fragment')?.text ?? '';
}

/** `./x` for `require('./x')`, undefined for anything else. */
function requireSource(node: Node | null | undefined): string | undefined {
    if (node?.type !== 'call_expression') {
        return undefined;
    }
    const f = node.childForFieldName('function');
    if (f?.type !== 'identifier' || f.text !== 'require') {
        return undefined;
    }
    return stringValue(named(node.childForFieldName('arguments'))[0]);
}

/** `{ a, b: c }` -> a from a, c from b. */
function patternBindings(pattern: Node): Binding[] {
    const out: Binding[] = [];
    for (const p of named(pattern)) {
        if (p.type === 'shorthand_property_identifier_pattern') {
            out.push({ local: p.text, imported: p.text });
        } else if (p.type === 'pair_pattern') {
            const key = p.childForFieldName('key')?.text;
            const value = p.childForFieldName('value');
            if (key && value?.type === 'identifier') {
                out.push({ local: value.text, imported: key });
            }
        }
    }
    return out;
}

/** The name a type annotation refers to: `Repo` for `: Repo`, `Repo<T>`, `ns.Repo` (as `ns.Repo`). */
function typeName(node: Node | null | undefined): string | undefined {
    if (!node) {
        return undefined;
    }
    switch (node.type) {
        case 'type_annotation':
            return typeName(named(node)[0]);
        case 'type_identifier':
        case 'nested_type_identifier':
        case 'identifier':
            return node.text;
        case 'generic_type':
            return typeName(node.childForFieldName('name'));
        case 'union_type': {
            // `Repo | undefined` and `Repo | null` are still a Repo.
            const types = named(node).map(typeName).filter(isString);
            return types.length === 1 ? types[0] : undefined;
        }
    }
    return undefined;
}

/** `Store` for `new Store(...)`, undefined otherwise. */
function constructedType(node: Node | null | undefined): string | undefined {
    if (node?.type !== 'new_expression') {
        return undefined;
    }
    const c = node.childForFieldName('constructor');
    return c?.type === 'identifier' || c?.type === 'member_expression' ? c.text : undefined;
}

/** `Base` or `ns.Base` for a class's base expression; undefined for mixins and other calls. */
function expressionName(node: Node | null | undefined): string | undefined {
    if (node?.type === 'identifier' || node?.type === 'member_expression') {
        return node.text;
    }
    return undefined;
}

/** What a member call is made on: `obj`, `this`, `super` or `this.field`. */
function receiverOf(node: Node | null | undefined): string | undefined {
    if (!node) {
        return undefined;
    }
    if (node.type === 'identifier') {
        return node.text;
    }
    if (node.type === 'this' || node.type === 'super') {
        return node.type;
    }
    if (node.type === 'member_expression' && node.childForFieldName('object')?.type === 'this') {
        const property = node.childForFieldName('property')?.text;
        return property ? `this.${property}` : undefined;
    }
    return undefined;
}

/** `Button` in `memo(Button)` or `connect(a, b)(Button)`: the component a default export wraps. */
function wrappedIdentifier(node: Node): string | undefined {
    if (node.type !== 'call_expression') {
        return undefined;
    }
    const first = named(node.childForFieldName('arguments'))[0];
    return first?.type === 'identifier' ? first.text : undefined;
}

function heritageText(node: Node): string {
    return named(node).find((c) => c.type === 'class_heritage')?.text ?? '';
}

/** `async load(id: string): Promise<User>`: modifiers, name, type parameters, parameters and return type. */
function signatureOf(fn: Node, name: string): string {
    const modifiers = fn.children
        .filter((c) => c !== null && ['async', 'static', 'get', 'set', '*', 'accessibility_modifier'].includes(c.type))
        .map((c) => c!.text);
    const params = fn.childForFieldName('parameters')?.text ?? `(${fn.childForFieldName('parameter')?.text ?? ''})`;
    const typeParams = fn.childForFieldName('type_parameters')?.text ?? '';
    const returns = fn.childForFieldName('return_type')?.text ?? '';
    return clip(squash(`${modifiers.join(' ')} ${name}${typeParams}${params}${returns}`));
}

/** `Button` for components/Button.tsx, `auth` for auth/index.ts. */
function anonymousName(filePath: string): string {
    const parts = filePath.split('/');
    const base = parts[parts.length - 1].replace(/\.[^.]+$/, '');
    return base === 'index' && parts.length > 1 ? parts[parts.length - 2] : base;
}
