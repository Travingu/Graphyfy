// End to end through the bundle VS Code loads (out/extension.js, run
// `npm run build` first): activate with a stub `vscode`, open the panel, say
// `ready` as the webview would, and check the graph that comes back for
// sample/. Catches what only breaks after bundling, like web-tree-sitter
// finding its .wasm files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
const sample = path.join(root, 'sample');

function listFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

/** Just enough of the vscode API for activate(), the panel and a scan. */
function stubVscode() {
    const uri = (fsPath) => ({ fsPath, path: fsPath.replace(/\\/g, '/'), toString: () => `file://${fsPath}` });
    const commands = new Map();
    const posted = [];
    let receive;
    const vscode = {
        Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
        ViewColumn: { One: 1, Beside: -2 },
        Position: class {},
        Range: class {},
        commands: { registerCommand: (id, fn) => (commands.set(id, fn), { dispose() {} }) },
        window: {
            createWebviewPanel: () => ({
                webview: {
                    cspSource: 'vscode-resource:',
                    asWebviewUri: (u) => u,
                    postMessage: async (m) => posted.push(m),
                    onDidReceiveMessage: (fn) => (receive = fn),
                    set html(_) {},
                },
                onDidDispose() {},
                reveal() {},
            }),
            showErrorMessage: async (m) => posted.push({ type: 'vscode-error', message: m }),
            showWarningMessage: async () => {},
            showInformationMessage: async () => {},
            activeTextEditor: undefined,
        },
        workspace: {
            workspaceFolders: [{ name: 'sample', uri: uri(sample) }],
            textDocuments: [],
            getConfiguration: () => ({ get: () => undefined }),
            findFiles: async () => listFiles(sample).filter((f) => /\.(ts|tsx|js|jsx)$/.test(f)).map(uri),
            fs: { readFile: async (u) => fs.readFileSync(u.fsPath) },
            asRelativePath: (u) => path.relative(sample, u.fsPath),
            createFileSystemWatcher: () => ({ onDidCreate() {}, onDidDelete() {}, dispose() {} }),
            onDidSaveTextDocument: () => ({ dispose() {} }),
        },
    };
    return { vscode, commands, posted, receive: (m) => receive(m) };
}

test('the bundled extension scans the sample and posts its graph', async () => {
    const stub = stubVscode();
    const resolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
        return request === 'vscode' ? 'vscode' : resolve.call(this, request, ...rest);
    };
    require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: stub.vscode };
    try {
        const extension = require(path.join(root, 'out', 'extension.js'));
        const context = { subscriptions: [], extensionUri: { fsPath: root }, asAbsolutePath: (p) => path.join(root, p) };
        extension.activate(context);
        assert.deepEqual([...stub.commands.keys()].sort(), ['graphyfy.open', 'graphyfy.refresh', 'graphyfy.reveal']);

        stub.commands.get('graphyfy.open')();
        await stub.receive({ type: 'ready' });

        const errors = stub.posted.filter((m) => m.type === 'error' || m.type === 'vscode-error');
        assert.deepEqual(errors, []);
        const graph = stub.posted.find((m) => m.type === 'graph')?.data;
        assert.ok(graph, 'a graph was posted');
        assert.equal(graph.stats.files, 14);
        assert.ok(graph.edges.some((e) => e.kind === 'render' && e.source === 'function:src/App.tsx:App' && e.target === 'function:src/components/TaskList.tsx:TaskList'));
        assert.ok(graph.edges.some((e) => e.kind === 'extends' && e.source === 'class:src/store/TaskStore.ts:TaskStore'));
    } finally {
        Module._resolveFilename = resolve;
        delete require.cache.vscode;
    }
});
