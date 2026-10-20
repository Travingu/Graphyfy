// src/parser/index.ts
// The parser: tree-sitter with the TypeScript, TSX and JavaScript grammars, and
// one extractor for all three (extract.ts). Everything outside src/parser uses
// only this module.
//
//   await initParsers(wasmDir);                 // once
//   const parsed = parseSource(path, text);     // grammar picked from the extension

import type { Grammar } from '../types';
import { hashString } from '../util/hash';
import { extract } from './extract';
import { parserFor } from './loader';
import type { ParsedFile } from './types';

export { initParsers } from './loader';
export type * from './types';

/** Every file the parser reads. Declaration files (.d.ts) describe code that isn't here, so they're skipped. */
export const SOURCE_FILE = /^(?!.*\.d\.[cm]?ts$).*\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export function grammarFor(path: string): Grammar {
    if (/\.tsx$/.test(path)) {
        return 'tsx';
    }
    if (/\.[cm]?ts$/.test(path)) {
        return 'typescript';
    }
    return 'javascript'; // its grammar includes JSX
}

/** Parse one file. initParsers must have finished. */
export function parseSource(filePath: string, sourceCode: string): ParsedFile {
    const grammar = grammarFor(filePath);
    const tree = parserFor(grammar).parse(sourceCode);
    if (!tree) {
        throw new Error(`tree-sitter failed to parse ${filePath}`);
    }
    try {
        return extract(tree.rootNode, filePath, grammar, hashString(sourceCode));
    } finally {
        tree.delete(); // WASM memory isn't garbage-collected
    }
}
