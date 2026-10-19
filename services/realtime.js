let io = null;

function init(server) {
    const { Server } = require('socket.io');
    io = new Server(server, { cors: { origin: '*' } });
    io.on('connection', (socket) => {
        console.log('[realtime] client connected');
        socket.on('disconnect', () => console.log('[realtime] client disconnected'));
    });
    return io;
}

// Broadcast a data-change event so all connected clients refresh.
function broadcast(type, payload = {}) {
    if (io) io.emit('data-changed', { type, ...payload, at: Date.now() });
}

module.exports = { init, broadcast };