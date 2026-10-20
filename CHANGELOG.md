# Changelog

## 0.1.0

First release.

- Graph of a TypeScript or JavaScript workspace: folders, files, classes, interfaces and functions, connected by imports, calls, JSX renders, `extends` and `implements`.
- Files and classes open in place; arrows to a closed file are bundled into one, with a count.
- Details panel with a symbol's signature, what it calls and what calls it, and a link to the code.
- Search with `/`, and **Show in Graph** from the editor's context menu.
- Follows ES module imports, re-exports and barrels, `require()` and `module.exports`, and TypeScript's `.js` import specifiers.
- Rebuilds when files are saved, created or deleted.
- Follows the color theme, light or dark.
