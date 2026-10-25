// Prints the graph Overseer builds for a folder, for checking the parser and
// the name resolution by eye.
//   node test/dump.js <folder>          nodes and edges
//   node test/dump.js <folder> --json   the GraphData the webview gets
const path = require('path');
const { graphOf, edgeList, readFolder } = require('./helpers');

(async () => {
    const root = path.resolve(process.argv[2] || '.');
    const graph = await graphOf(readFolder(root));
    if (process.argv.includes('--json')) {
        process.stdout.write(JSON.stringify(graph));
        return;
    }
    console.log(`${graph.stats.files} files, ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
    for (const n of graph.nodes) {
        console.log(`  ${n.kind.padEnd(9)} ${n.id}${n.signature ? `  ${n.signature}` : ''}`);
    }
    for (const e of edgeList(graph)) {
        console.log(`  ${e}`);
    }
    if (graph.stats.parseErrors.length) {
        console.log(`Partly parsed: ${graph.stats.parseErrors.join(', ')}`);
    }
})();
