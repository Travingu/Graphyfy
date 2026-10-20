# Graphyfy

A VS Code extension that draws a TypeScript or JavaScript codebase as a graph you can explore: folders, files, classes and functions, connected by the imports, calls, JSX renders and inheritance between them. It's for finding your way around code you didn't write, or haven't read in a while.

## Using it

Run **Graphyfy: Open Graph** from the Command Palette, or click the graph icon in the title bar of a TypeScript or JavaScript editor. The graph opens beside your code, showing your folders with their files closed.

| To | Do |
| --- | --- |
| Open a file or class | Click it |
| See what a function calls and what calls it | Click it (the Details panel lists both) |
| Go to the code | Double-click, or **Go to code** in Details |
| Close an open file or class | Ctrl+click it (Cmd+click on macOS) |
| Find a function, class or file | Press `/` and type |
| Clear the selection | Esc |
| Find the symbol under your cursor | Right-click in the editor, **Graphyfy: Show in Graph** |

Arrows point from the code doing something to the code it does it to. An arrow that ends on a closed file stands for everything inside it, with a count.

## What it understands

- **Imports:** ES modules (named, default, namespace, re-exports and `export *` barrels), `require()`, dynamic `import()`, `index` files, and TypeScript's `.js` specifiers for `.ts` files.
- **Aliases:** `paths` and `baseUrl` from `tsconfig.json` and `jsconfig.json` (`@/components/Button`), through `extends`, including the `tsconfig.app.json` that Vite projects keep them in. In a monorepo, each package uses the config nearest to it.
- **Calls:** to imported and local functions, `this.method()`, `super.method()`, `new Class()`, methods on parameters and variables with a declared or constructed type, and on fields, including constructor parameter properties.
- **JSX:** `<Component />` is a render arrow, including components exported through `memo()` and similar wrappers.
- **Classes:** `extends` and `implements`, and methods inherited from a base class.
- **CommonJS:** `module.exports = ...`, `module.exports = { a, b }` and `exports.name = ...`.

A call on a receiver whose type isn't known goes to the one method with that name among the files the caller imports, drawn dotted and labeled a guess. When there's more than one candidate, or the name is too common to guess from (`map`, `get`, `remove`), no arrow is drawn.

There's no type checker involved. Graphyfy parses with [tree-sitter](https://tree-sitter.github.io/), so it needs no `tsconfig.json`, no build and no installed dependencies, and a file with a syntax error still contributes everything around the error. The cost is that some calls can't be followed: through callbacks and higher-order functions, through values whose type is only inferred, and through aliases defined only in a bundler's config (Vite's `resolve.alias`, webpack's `resolve.alias`). Treat the graph as a map, not a compiler's call graph.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `graphyfy.include` | `**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}` | Files to analyze. `.d.ts` files are always skipped. |
| `graphyfy.exclude` | `node_modules`, build output, minified files | Files and folders to skip |
| `graphyfy.maxFiles` | `3000` | The most files to analyze |
| `graphyfy.autoRefresh` | `true` | Rebuild the graph when files are saved, created or deleted |

## Development

```sh
npm install
npm run build      # out/extension.js, out/webview.js and the tree-sitter grammars
npm test           # parser and resolver tests, then the bundled extension end to end
npm run typecheck
```

Press **F5** to open `sample/` (a small React app and Node server) in an Extension Development Host. The second launch configuration asks for any folder, to try it on a real project. `node test/dump.js <folder>` prints the nodes and edges Graphyfy finds there.

| Path | What it does |
| --- | --- |
| `src/parser/` | tree-sitter loading, and the one-pass extractor for TypeScript, TSX and JavaScript |
| `src/graph/builder.ts` | Resolves imports, exports and calls across files into the graph |
| `src/graph/aliases.ts` | Reads import aliases from tsconfig and jsconfig files |
| `src/workspaceIndex.ts` | Finds and reads the workspace's files, and caches parses |
| `src/panel.ts`, `src/extension.ts` | The webview panel, commands and auto-refresh |
| `webview/model.ts` | What's open, what's visible, and arrow bundling |
| `webview/layout.ts`, `webview/view.ts` | ELK layout and the Cytoscape canvas |
| `webview/details.ts`, `webview/search.ts` | The Details panel and search |

## Acknowledgements

The architecture follows [Code Graph](https://github.com/kx1100/Dubhacks-26), a C/C++ graph extension built at DubHacks 2026: tree-sitter in WebAssembly, name resolution the way a reader does it, nested boxes that open in place, and an ELK left-to-right layout.

## License

MIT
