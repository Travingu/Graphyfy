module.exports = function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
};
