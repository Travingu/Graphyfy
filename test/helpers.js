// Lets the tests require src/**/*.ts directly (compiled on the fly by esbuild;
// type checking is `npm run typecheck`) and builds graphs from inline sources.
const fs = require('fs');
const esbuild = require('esbuild');
const { copyParsers } = require('../scripts/build');

require.extensions['.ts'] = (module, filename) => {
    const { code } = esbuild.transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node20', sourcefile: filename });
    module._compile(code, filename);
};

const { initParsers } = require('../src/parser');
const { buildGraph } = require('../src/graph/builder.ts');

const ready = initParsers(copyParsers());

/** Builds a graph from `{ path: text }`. */
async function graphOf(files) {
    await ready;
    return buildGraph(Object.entries(files).map(([path, text]) => ({ path, text })));
}

/** Edges as readable strings: `call src/a.ts:main -> src/b.ts:helper`. */
function edgeList(graph, kind) {
    const name = (id) => id.replace(/^[a-z]+:/, '');
    return graph.edges
        .filter((e) => !kind || e.kind === kind)
        .map((e) => `${e.kind} ${name(e.source)} -> ${name(e.target)}${e.uncertain ? ' ?' : ''}`)
        .sort();
}

module.exports = { graphOf, edgeList };
