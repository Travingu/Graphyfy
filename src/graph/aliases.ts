// src/graph/aliases.ts
// Import aliases from tsconfig.json and jsconfig.json: `compilerOptions.paths`
// (`@/*` -> `src/*`) and `baseUrl` (`components/Button` from `src`), followed
// through `extends`. No vscode imports, so the tests run it directly.
//
// A file uses the aliases of the nearest folder above it whose config files
// define any. Every config file in that folder counts, since a project's root
// tsconfig.json often only lists references and the paths sit in a sibling
// (tsconfig.app.json in Vite's templates). An alias only ever produces a
// candidate path; the builder keeps it only if that file is in the workspace.

import * as path from 'path';

const posix = path.posix;

/** tsconfig.json, tsconfig.app.json, tsconfig.base.json, jsconfig.json and so on. */
export const CONFIG_FILE = /(^|\/)(tsconfig|jsconfig)[\w.-]*\.json$/;
/** How deep `extends` chains are followed. */
const MAX_EXTENDS_DEPTH = 8;

interface PathRule {
    /** The pattern before and after its `*`; `suffix` is undefined for a pattern without one. */
    prefix: string;
    suffix?: string;
    /** Workspace-relative targets, with the `*` kept. */
    targets: string[];
}

interface AliasConfig {
    rules: PathRule[];
    /** Workspace-relative folder that bare specifiers resolve from. */
    baseUrl?: string;
}

/** What one config file contributes once its `extends` chain is applied. */
interface Resolved {
    paths?: PathRule[];
    baseUrl?: string;
}

export interface Aliases {
    /** Workspace-relative paths an import specifier could mean, best first, without extensions tried. */
    candidates(fromFile: string, spec: string): string[];
}

/** Read aliases from config files (`path` workspace-relative with `/`, `text` the file's contents). */
export function readAliases(configs: { path: string; text: string }[]): Aliases {
    const texts = new Map(configs.map((c) => [c.path, c.text]));
    const parsed = new Map<string, Record<string, unknown> | undefined>();
    const readJson = (file: string) => {
        if (!parsed.has(file)) {
            const text = texts.get(file);
            parsed.set(file, text === undefined ? undefined : parseJsonc(text));
        }
        return parsed.get(file);
    };

    const resolved = new Map<string, Resolved>();
    const resolve = (file: string, depth = 0): Resolved => {
        const done = resolved.get(file);
        if (done) {
            return done;
        }
        const json = readJson(file);
        if (!json || depth > MAX_EXTENDS_DEPTH) {
            return {};
        }
        resolved.set(file, {}); // an `extends` cycle ends here
        const dir = posix.dirname(file);
        // Later entries of an `extends` array override earlier ones, and the file's own options override them all.
        let out: Resolved = {};
        for (const ext of asList(json.extends)) {
            const base = extendedFile(dir, ext, texts);
            if (base) {
                out = { ...out, ...definedOnly(resolve(base, depth + 1)) };
            }
        }
        const opts = isObject(json.compilerOptions) ? json.compilerOptions : {};
        if (typeof opts.baseUrl === 'string') {
            out.baseUrl = join(dir, opts.baseUrl);
        }
        if (isObject(opts.paths)) {
            // `paths` are relative to `baseUrl` when this file sets one, otherwise to this file's folder.
            const from = typeof opts.baseUrl === 'string' ? join(dir, opts.baseUrl) : dir;
            out.paths = Object.entries(opts.paths).map(([pattern, targets]) => {
                const star = pattern.indexOf('*');
                return {
                    prefix: star < 0 ? pattern : pattern.slice(0, star),
                    suffix: star < 0 ? undefined : pattern.slice(star + 1),
                    targets: asList(targets).map((t) => join(from, t)),
                };
            });
        }
        resolved.set(file, out);
        return out;
    };

    // Folder -> the aliases its config files define, tsconfig.json and jsconfig.json first.
    const byDir = new Map<string, AliasConfig>();
    const order = (p: string) => (/(^|\/)[tj]sconfig\.json$/.test(p) ? 0 : 1);
    for (const file of [...texts.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b))) {
        const r = resolve(file);
        if (!r.paths && !r.baseUrl) {
            continue;
        }
        const dir = dirOf(file);
        const config = byDir.get(dir) ?? { rules: [] };
        config.rules.push(...(r.paths ?? []));
        config.baseUrl ??= r.baseUrl;
        byDir.set(dir, config);
    }

    const configFor = (file: string): AliasConfig | undefined => {
        for (let d = dirOf(file); ; d = dirOf(d)) {
            const config = byDir.get(d);
            if (config || !d) {
                return config;
            }
        }
    };

    return {
        candidates(fromFile, spec) {
            const config = configFor(fromFile);
            if (!config) {
                return [];
            }
            const out: string[] = [];
            // The longest matching prefix wins, and an exact pattern beats any wildcard, as in TypeScript.
            const matches = config.rules
                .filter((r) => (r.suffix === undefined ? spec === r.prefix : spec.length >= r.prefix.length + r.suffix.length && spec.startsWith(r.prefix) && spec.endsWith(r.suffix)))
                .sort((a, b) => Number(b.suffix === undefined) - Number(a.suffix === undefined) || b.prefix.length - a.prefix.length);
            for (const rule of matches) {
                const star = spec.slice(rule.prefix.length, spec.length - (rule.suffix?.length ?? 0));
                out.push(...rule.targets.map((t) => posix.normalize(t.replace('*', star))));
            }
            if (config.baseUrl !== undefined) {
                out.push(join(config.baseUrl, spec));
            }
            return out;
        },
    };
}

/** The config file an `extends` entry names, if it's in the workspace. Package configs (`@tsconfig/node20`) aren't read. */
function extendedFile(dir: string, ext: string, texts: Map<string, string>): string | undefined {
    if (!ext.startsWith('.') && !ext.startsWith('/')) {
        return undefined;
    }
    const base = join(dir, ext);
    return [base, base + '.json'].find((c) => texts.has(c));
}

/** JSON with comments and trailing commas, as tsconfig allows. Undefined when it still doesn't parse. */
export function parseJsonc(text: string): Record<string, unknown> | undefined {
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            const start = i;
            for (i++; i < text.length && text[i] !== '"'; i++) {
                if (text[i] === '\\') {
                    i++;
                }
            }
            out += text.slice(start, i + 1);
        } else if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') {
                i++;
            }
            out += '\n';
        } else if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end < 0 ? text.length : end + 1;
        } else {
            out += c;
        }
    }
    try {
        const json: unknown = JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
        return isObject(json) ? json : undefined;
    } catch {
        return undefined;
    }
}

function join(dir: string, rel: string): string {
    const p = posix.normalize(rel.startsWith('/') ? rel.slice(1) : posix.join(dir, rel));
    return p === '.' ? '' : p.replace(/\/$/, '');
}

function dirOf(p: string): string {
    return p.includes('/') ? posix.dirname(p) : '';
}

function asList(v: unknown): string[] {
    return (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string');
}

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function definedOnly(r: Resolved): Resolved {
    const out: Resolved = {};
    if (r.paths) {
        out.paths = r.paths;
    }
    if (r.baseUrl !== undefined) {
        out.baseUrl = r.baseUrl;
    }
    return out;
}
