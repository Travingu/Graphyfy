// Builds the extension into out/:
//   src/extension.ts -> out/extension.js   (extension host, CommonJS for Node)
//   webview/main.ts  -> out/webview.js     (the graph page, plus out/webview.css)
// and copies the tree-sitter runtime and grammars to out/parsers/, where
// src/parser/loader.ts loads them.
//
// Usage: node scripts/build.js [--watch] [--production]
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const out = path.join(root, 'out');

const WASM = [
    'web-tree-sitter/web-tree-sitter.wasm',
    'tree-sitter-typescript/tree-sitter-typescript.wasm',
    'tree-sitter-typescript/tree-sitter-tsx.wasm',
    'tree-sitter-javascript/tree-sitter-javascript.wasm',
];

/** @type {import('esbuild').BuildOptions} */
const extension = {
    entryPoints: [path.join(root, 'src', 'extension.ts')],
    outfile: path.join(out, 'extension.js'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: ['vscode'],
    // web-tree-sitter's ESM build reads import.meta.url, which a CommonJS bundle doesn't have.
    banner: { js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;" },
    define: { 'import.meta.url': 'importMetaUrl' },
    logLevel: 'warning',
};

/** @type {import('esbuild').BuildOptions} */
const webview = {
    entryPoints: [path.join(root, 'webview', 'main.ts')],
    outfile: path.join(out, 'webview.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'warning',
};

function copyParsers() {
    const dest = path.join(out, 'parsers');
    fs.mkdirSync(dest, { recursive: true });
    for (const file of WASM) {
        fs.copyFileSync(path.join(root, 'node_modules', file), path.join(dest, path.basename(file)));
    }
    return dest;
}

module.exports = { copyParsers };

if (require.main === module) {
    const watch = process.argv.includes('--watch');
    const production = process.argv.includes('--production');
    const extra = { minify: production, sourcemap: !production };
    copyParsers();
    (async () => {
        if (watch) {
            for (const options of [extension, webview]) {
                const ctx = await esbuild.context({ ...options, ...extra, logLevel: 'info' });
                await ctx.watch();
            }
            return;
        }
        await Promise.all([esbuild.build({ ...extension, ...extra }), esbuild.build({ ...webview, ...extra })]);
        console.log('Built out/extension.js and out/webview.js');
    })().catch(() => process.exit(1));
}
