const log = require('./log');

function route(req, res) {
    log(`${req.method} ${req.url}`);
    if (req.url === '/health') {
        return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'Not found' });
}

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

module.exports = { route };
