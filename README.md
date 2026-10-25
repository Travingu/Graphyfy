# Overseer

A VS Code extension that draws a TypeScript or JavaScript codebase as a graph you can explore: folders, files, classes and functions, connected by the imports, calls, JSX renders and inheritance between them. It's for finding your way around code you didn't write, or haven't read in a while.

## Using it

Run **Overseer: Open Graph** from the Command Palette, or click the graph icon in the title bar of a TypeScript or JavaScript editor. The graph opens beside your code, showing your folders with their files closed.

| To | Do |
| --- | --- |
| Open a file or class | Click it |
| See what a function calls and what calls it | Click it (the Details panel lists both) |
| Go to the code | Double-click, or **Go to code** in Details |
| Close an open file or class | Ctrl+click it (Cmd+click on macOS) |
| Find a function, class or file | Press `/` and type |
| Clear the selection | Esc |
| Find the symbol under your cursor | Right-click in the editor, **Overseer: Show in Graph** |

Zoomed out too far to read the labels, each file, class and function is drawn as a dot in its color. Hover over one to see its name. Zoom back in and the dots open into labels. Arrows point from the code doing something to the code it does it to. An arrow that ends on a closed file stands for everything inside it, with a count.

## Git history

A timeline of the repository's history runs along the bottom of the graph. **History** in the toolbar hides and shows it, and **Overseer: Show Git History** brings it back. Commits run left to right, oldest first, with one line per branch. Branch names sit above their latest commit, and the hollow dot at the right end is your working tree.

| To | Do |
| --- | --- |
| See the code as it was at a commit | Click the commit. The graph is rebuilt from that commit, read-only. Your files and branch don't change. |
| Look at a branch | Click its name, or its latest commit. **Switch to** in the banner checks it out after asking. |
| Go back to your files | **Back to working tree** in the banner, or click the dot at the right end |
| Move along the timeline | Arrow keys, Home and End. Enter opens the commit. |
| Compare a changed function with the version before | Select it, then **Compare with parent** in Details |

What a past commit changed is outlined on the graph, compared with its parent (the first parent of a merge): green for added, blue for modified, and dashed red for deleted, which are shown where they used to be. A closed file or folder with changes inside gets a blue outline. On your working tree, everything you haven't committed yet is outlined in yellow, with deletions dashed. Untick **Show changes** in the legend to hide the outlines.

Overseer reads commits straight from Git with `git` on your PATH and never changes your repository, except when you choose **Switch to**. Git refuses that switch if uncommitted changes would be overwritten.

## AI agents

Overseer can show, live, which files Claude Code or Cursor is reading and editing. Click **Connect** next to an agent in the Details panel (with nothing selected), or run **Overseer: Connect an AI Agent**. While the agent works:

- the file it's reading glows blue on the graph, and the one it's editing glows orange (a closed folder lights up for what's inside it)
- the toolbar says what it's doing: *Claude editing App.tsx*
- **Recent activity** in Details lists each file, newest first. Click one to find it on the graph.
- tick **Follow the agent on the graph** to pan to each file as it's touched

Connecting adds a hook to the agent's project settings: `.claude/settings.local.json` for Claude Code, `.cursor/hooks.json` for Cursor. The hook is a small script that Overseer copies to `.overseer/hook.js`. On every read or edit it appends one line to `.overseer/activity.jsonl`. It only watches: it never blocks, slows or changes what the agent does, unless you turn on `overseer.answerSearches` (below). Everything stays on your machine and out of git (`.overseer/` ignores itself, and `.cursor/hooks.json` goes in `.git/info/exclude`). **Disconnect** removes the hook and leaves the rest of those files as they were.

### Lookup table

While an agent is connected, Overseer keeps a lookup table of your code in `.overseer/lookup.md`. It has one line per file, listing what that file imports, and one line per class, function and method, giving its `path:start-end`, signature and what it calls. The table is rewritten when files change, even with the graph closed. Each session, the agent is told to grep the table before it searches the codebase or reads whole files. Claude Code gets this from the hook at session start, and Cursor from an always-applied rule in `.cursor/rules/overseer.mdc` (also kept out of git). One grep then returns where a function is defined and every function that calls it, so the agent reads only the lines it needs. The table is roughly a seventh the size of the source.

Agents still tend to fall back on searching the code themselves. Turn on `overseer.answerSearches` to stop that for Claude Code. When Claude greps the code for a plain name the table knows (`AgentHub`, `writeLookup`), the hook answers from the table instead: a few lines saying where the name is defined and what uses it, not every match in the code. If Claude runs the same search again within two minutes, it goes through, so text the table doesn't cover (strings, comments) is still one step away. Searches for regexes, text, single files or non-code files always go through. Cursor has no hook before a search, so this applies only to Claude Code.

The hook runs with Node.js, so `node` has to be on your PATH. Files an agent reaches through shell commands (`cat`, `sed`) don't show up, because hooks only see the agent's own file tools.

## What it understands

- **Imports:** ES modules (named, default, namespace, re-exports and `export *` barrels), `require()`, dynamic `import()`, `index` files, and TypeScript's `.js` specifiers for `.ts` files.
- **Aliases:** `paths` and `baseUrl` from `tsconfig.json` and `jsconfig.json` (`@/components/Button`), through `extends`, including the `tsconfig.app.json` that Vite projects keep them in. In a monorepo, each package uses the config nearest to it.
- **Calls:** to imported and local functions, `this.method()`, `super.method()`, `new Class()`, methods on parameters and variables with a declared or constructed type, and on fields, including constructor parameter properties.
- **JSX:** `<Component />` is a render arrow, including components exported through `memo()` and similar wrappers.
- **Classes:** `extends` and `implements`, and methods inherited from a base class.
- **CommonJS:** `module.exports = ...`, `module.exports = { a, b }` and `exports.name = ...`.

A call on a receiver whose type isn't known goes to the one method with that name among the files the caller imports, drawn dotted and labeled a guess. When there's more than one candidate, or the name is too common to guess from (`map`, `get`, `remove`), no arrow is drawn.

There's no type checker involved. Overseer parses with [tree-sitter](https://tree-sitter.github.io/), so it needs no `tsconfig.json`, no build and no installed dependencies, and a file with a syntax error still contributes everything around the error. The cost is that some calls can't be followed: through callbacks and higher-order functions, through values whose type is only inferred, and through aliases defined only in a bundler's config (Vite's `resolve.alias`, webpack's `resolve.alias`). Treat the graph as a map, not a compiler's call graph.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `overseer.include` | `**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}` | Files to analyze. `.d.ts` files are always skipped. |
| `overseer.exclude` | `node_modules`, build output, minified files | Files and folders to skip |
| `overseer.maxFiles` | `3000` | The most files to analyze |
| `overseer.autoRefresh` | `true` | Rebuild the graph when files are saved, created or deleted |
| `overseer.historyLimit` | `500` | The most commits the history timeline shows |
| `overseer.answerSearches` | `false` | Answer Claude Code's greps for names from the lookup table instead of searching the code |

## Development

```sh
npm install
npm run build      # out/extension.js, out/webview.js and the tree-sitter grammars
npm test           # parser and resolver tests, then the bundled extension end to end
npm run typecheck
npm run harness    # the graph page in a browser, without VS Code
```

`npm run harness` builds, then serves the webview at http://127.0.0.1:8766 with the graph of `sample/`. `npm run harness -- <folder>` uses any folder, `?theme=light` switches to the light theme, and `PORT=<n>` picks another port. The page stands in for VS Code: it sends the graph and logs what the webview sends back to the browser console. It has no Git history, agents or Go to code, so use F5 for those. With `npm run watch` running, reloading the page picks up both webview changes and changes to the folder.

Press **F5** to open `sample/` (a small React app and Node server) in an Extension Development Host. The second launch configuration asks for any folder, to try it on a real project. `node test/dump.js <folder>` prints the nodes and edges Overseer finds there.

| Path | What it does |
| --- | --- |
| `src/parser/` | tree-sitter loading, and the one-pass extractor for TypeScript, TSX and JavaScript |
| `src/graph/builder.ts` | Resolves imports, exports and calls across files into the graph |
| `src/graph/aliases.ts` | Reads import aliases from tsconfig and jsconfig files |
| `src/workspaceIndex.ts` | Finds and reads the workspace's files, and caches parses |
| `src/git/git.ts` | The git commands: log, trees, blobs, diffs and switching |
| `src/git/lanes.ts`, `src/git/changes.ts` | Timeline lanes, and the added, modified and removed markers |
| `src/historyIndex.ts` | Builds the graph at any commit, caching parses by blob |
| `src/agents/`, `src/agentHub.ts` | The AI agent hook, connecting it to Claude Code and Cursor, following its activity log, and the lookup table (`lookup.ts`) |
| `src/panel.ts`, `src/extension.ts` | The webview panel, commands and auto-refresh |
| `webview/model.ts` | What's open, what's visible, and arrow bundling |
| `webview/layout.ts`, `webview/view.ts` | ELK layout and the Cytoscape canvas |
| `webview/details.ts`, `webview/search.ts` | The Details panel and search |
| `webview/timeline.ts` | The Git history strip |
| `webview/agents.ts` | The AI agents section and live activity feed |

## Acknowledgements

The architecture follows [Code Graph](https://github.com/kx1100/Dubhacks-26), a C/C++ graph extension built at DubHacks 2026: tree-sitter in WebAssembly, name resolution the way a reader does it, nested boxes that open in place, and an ELK left-to-right layout.

## License

MIT
