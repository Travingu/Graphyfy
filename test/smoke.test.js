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
        Uri: {
            joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)),
            file: (p) => uri(p),
            from: (parts) => ({ ...parts, toString: () => `${parts.scheme}:${parts.path}?${parts.query}` }),
        },
        RelativePattern: class {},
        ViewColumn: { One: 1, Beside: -2 },
        Position: class {},
        Range: class {},
        commands: { registerCommand: (id, fn) => (commands.set(id, fn), { dispose() {} }), executeCommand: async () => {} },
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
            findFiles: async (glob) => listFiles(sample).filter((f) => (glob.includes('tsconfig') ? /[tj]sconfig[\w.-]*\.json$/ : /\.(ts|tsx|js|jsx)$/).test(f)).map(uri),
            fs: { readFile: async (u) => fs.readFileSync(u.fsPath) },
            asRelativePath: (u) => path.relative(sample, u.fsPath),
            createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {} }),
            onDidSaveTextDocument: () => ({ dispose() {} }),
            onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
            registerTextDocumentContentProvider: () => ({ dispose() {} }),
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
        assert.deepEqual([...stub.commands.keys()].sort(), ['overseer.connectAgent', 'overseer.disconnectAgent', 'overseer.history', 'overseer.open', 'overseer.refresh', 'overseer.reveal']);

        stub.commands.get('overseer.open')();
        await stub.receive({ type: 'ready' });

        const errors = stub.posted.filter((m) => m.type === 'error' || m.type === 'vscode-error');
        assert.deepEqual(errors, []);
        const graph = stub.posted.find((m) => m.type === 'graph')?.data;
        assert.ok(graph, 'a graph was posted');
        assert.equal(graph.stats.files, 14);
        assert.ok(graph.edges.some((e) => e.kind === 'render' && e.source === 'function:src/App.tsx:App' && e.target === 'function:src/components/TaskList.tsx:TaskList'));
        assert.ok(graph.edges.some((e) => e.kind === 'extends' && e.source === 'class:src/store/TaskStore.ts:TaskStore'));

        // sample/ sits inside this repository: its history, and the graph at the first commit that has it.
        await stub.receive({ type: 'loadHistory' });
        const history = stub.posted.find((m) => m.type === 'history' || m.type === 'historyError');
        assert.equal(history?.type, 'history', history?.message);
        const oldest = history.data.commits.at(-1);
        await stub.receive({ type: 'viewCommit', sha: oldest.sha, seq: 1 });
        const atCommit = stub.posted.find((m) => m.type === 'graph' && m.seq === 1);
        assert.equal(atCommit?.view.kind, 'commit');
        assert.equal(atCommit.view.sha, oldest.sha);
        assert.ok(atCommit.data.stats.files > 0);
        // The first commit has no parent, so everything in it is new.
        assert.ok(atCommit.data.nodes.filter((n) => n.kind !== 'dir').every((n) => n.change === 'added'));
    } finally {
        Module._resolveFilename = resolve;
        delete require.cache.vscode;
    }
});
