// src/parser/loader.ts
// Loads the tree-sitter runtime and the TypeScript, TSX and JavaScript
// grammars (WebAssembly) once per extension host. scripts/build.mjs copies the
// .wasm files into out/parsers/.

import { Language, Parser } from 'web-tree-sitter';
import * as path from 'path';
import type { Grammar } from '../types';

const GRAMMAR_FILE: Record<Grammar, string> = {
    typescript: 'tree-sitter-typescript.wasm',
    tsx: 'tree-sitter-tsx.wasm',
    javascript: 'tree-sitter-javascript.wasm',
};

let loading: Promise<void> | undefined;
let parsers: Record<Grammar, Parser> | undefined;

/** Loads the parsers from `wasmDir` (out/parsers). Concurrent and repeated calls share one load. */
export function initParsers(wasmDir: string): Promise<void> {
    if (!loading) {
        loading = (async () => {
            // Bundled, web-tree-sitter can't find its runtime .wasm next to itself.
            await Parser.init({ locateFile: (file: string) => path.join(wasmDir, file) });
            const make = async (grammar: Grammar) => {
                const parser = new Parser();
                parser.setLanguage(await Language.load(path.join(wasmDir, GRAMMAR_FILE[grammar])));
                return parser;
            };
            const [typescript, tsx, javascript] = await Promise.all([make('typescript'), make('tsx'), make('javascript')]);
            parsers = { typescript, tsx, javascript };
        })();
        // A failed load can be retried instead of caching the rejection.
        loading.catch(() => {
            loading = undefined;
        });
    }
    return loading;
}

export function parserFor(grammar: Grammar): Parser {
    if (!parsers) {
        throw new Error('The parsers are not loaded yet (await initParsers first).');
    }
    return parsers[grammar];
}
