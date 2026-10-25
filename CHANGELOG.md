# Changelog

## Unreleased

- Zoomed out, nodes are drawn as dots in their kind's color, and open into labels as you zoom in. Hover over a dot to see its name.

- Renamed from Graphyfy to **Overseer**, published as a new extension (`trav1snguyen.overseer`). Commands are now under **Overseer:** and settings under `overseer.*`; settings saved as `graphyfy.*` need setting again.
- Git history: a timeline along the bottom of the graph, shown by default, with a line per branch. Click a commit to see the code as it was, read-only, without checking anything out.
- What a past commit changed is outlined on the graph: green for added, blue for modified, and dashed red for deleted (shown as ghosts). In the working tree, everything not yet committed is outlined in yellow.
- Click a branch to look at it, then **Switch to** it from the banner.
- **Compare with parent** in Details opens a diff of a changed function's file.
- New command **Overseer: Show Git History**, and an `overseer.historyLimit` setting.
- AI agents: connect Claude Code or Cursor to see, live on the graph, which files the agent is reading (blue) and editing (orange), with a feed of recent activity and an option to follow the agent. It only watches, and stays on your machine.
- Lookup table for AI agents: while an agent is connected, Overseer keeps `.overseer/lookup.md` current, with one greppable line per file and per class, function and method (lines, signature, calls), and points the agent to it at the start of each session. The agent can then find code without reading whole files, which uses fewer tokens.
- New setting `overseer.answerSearches` (off by default): when Claude Code greps the code for a name the lookup table knows, it gets the table's few matching lines instead of every match. Running the same search again goes through.

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
