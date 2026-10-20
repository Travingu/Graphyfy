// Prints the graph Graphyfy builds for a folder, for checking the parser and
// the name resolution by eye.
//   node test/dump.js <folder>          nodes and edges
//   node test/dump.js <folder> --json   the GraphData the webview gets
const fs = require('fs');
const path = require('path');
const { graphOf, edgeList } = require('./helpers');

const SKIP = new Set(['node_modules', 'dist', 'build', 'out', '.git']);

function walk(dir, root, files) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP.has(entry.name)) {
                walk(full, root, files);
            }
        } else {
            files[path.relative(root, full).replace(/\\/g, '/')] = fs.readFileSync(full, 'utf8');
        }
    }
    return files;
}

(async () => {
    const root = path.resolve(process.argv[2] || '.');
    const graph = await graphOf(walk(root, root, {}));
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
