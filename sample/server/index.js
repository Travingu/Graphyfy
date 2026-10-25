const http = require('http');
const { route } = require('./routes');
const log = require('./log');

function start(port) {
    const server = http.createServer((req, res) => {
        try {
            route(req, res);
        } catch (err) {
            log(`Error handling ${req.method} ${req.url}: ${err.stack || err}`);
            if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    });
    server.on('error', (err) => {
        log(`Server error: ${err.message}`);
        process.exitCode = 1;
    });
    server.listen(port, () => log(`Listening on ${port}`));
}

start(Number(process.env.PORT) || 3000);
