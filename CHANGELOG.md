# Changelog

## Unreleased

- Renamed from Graphyfy to **Overseer**, published as a new extension (`trav1snguyen.overseer`). Commands are now under **Overseer:** and settings under `overseer.*`; settings saved as `graphyfy.*` need setting again.
- Git history: a timeline along the bottom of the graph, shown by default, with a line per branch. Click a commit to see the code as it was, read-only, without checking anything out.
- What a past commit changed is outlined on the graph: green for added, blue for modified, and dashed red for deleted (shown as ghosts). In the working tree, everything not yet committed is outlined in yellow.
- Click a branch to look at it, then **Switch to** it from the banner.
- **Compare with parent** in Details opens a diff of a changed function's file.
- New command **Overseer: Show Git History**, and an `overseer.historyLimit` setting.
- AI agents: connect Claude Code or Cursor to see, live on the graph, which files the agent is reading (blue) and editing (orange), with a feed of recent activity and an option to follow the agent. It only watches, and stays on your machine.

## 0.2.0

- Follows import aliases: `paths` and `baseUrl` in `tsconfig.json` and `jsconfig.json`, through `extends`. Imports like `@/lib/api` now draw arrows instead of being treated as packages.
- Labels on the graph are sharper on displays at 100%, 125% and 150% scaling.

## 0.1.0

First release.

- Graph of a TypeScript or JavaScript workspace: folders, files, classes, interfaces and functions, connected by imports, calls, JSX renders, `extends` and `implements`.
- Files and classes open in place; arrows to a closed file are bundled into one, with a count.
- Details panel with a symbol's signature, what it calls and what calls it, and a link to the code.
- Search with `/`, and **Show in Graph** from the editor's context menu.
- Follows ES module imports, re-exports and barrels, `require()` and `module.exports`, and TypeScript's `.js` import specifiers.
- Rebuilds when files are saved, created or deleted.
- Follows the color theme, light or dark.
