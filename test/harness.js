// Previews the webview in a browser, without VS Code: serves the built
// out/webview.js and out/webview.css in test/harness/index.html, which stands
// in for the extension host and feeds it the graph of a folder. The graph is
// rebuilt on every page load, so a reload picks up changes to the folder.
//
//   npm run harness                     sample/
//   npm run harness -- <folder>         any folder
//   PORT=9000 npm run harness           another port (default 8766)
//
// Then open http://127.0.0.1:8766 (add ?theme=light for the light theme).
// `npm run harness` builds first; with `npm run watch` running, a reload is enough.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { graphOf, readFolder } = require('./helpers');

const root = path.join(__dirname, '..');
const folder = path.resolve(process.argv[2] || path.join(root, 'sample'));
const port = Number(process.env.PORT) || 8766;

const FILES = {
    '/': [path.join(__dirname, 'harness', 'index.html'), 'text/html'],
    '/webview.js': [path.join(root, 'out', 'webview.js'), 'text/javascript'],
    '/webview.css': [path.join(root, 'out', 'webview.css'), 'text/css'],
};

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost').pathname;
    const send = (status, type, body) => res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(body);
    try {
        if (url === '/graph.json') {
            const graph = await graphOf(readFolder(folder));
            graph.title = path.basename(folder);
            send(200, 'application/json', JSON.stringify(graph));
        } else if (FILES[url]) {
            const [file, type] = FILES[url];
            send(200, type, fs.readFileSync(file));
        } else {
            send(404, 'text/plain', 'Not found');
        }
    } catch (err) {
        send(500, 'text/plain', err instanceof Error ? err.message : String(err));
    }
});

server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is in use (another harness?). Stop it, or run with PORT=<another port>.` : err.message);
    process.exit(1);
});
// Local only: the page shows the folder's code structure.
server.listen(port, '127.0.0.1', () => {
    console.log(`Overseer harness: http://127.0.0.1:${port}  (graph of ${folder})`);
});
