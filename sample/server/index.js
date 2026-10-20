const http = require('http');
const { route } = require('./routes');
const log = require('./log');

function start(port) {
    const server = http.createServer((req, res) => route(req, res));
    server.listen(port, () => log(`Listening on ${port}`));
}

start(Number(process.env.PORT) || 3000);
