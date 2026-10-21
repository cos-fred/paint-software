let io = null;

function init(server, allowedOrigins) {
    const { Server } = require('socket.io');
    const { verifyToken } = require('../auth');
    const { getDb } = require('../database');
    const { corsOriginOption } = require('../lib/cors');

    io = new Server(server, { cors: { origin: corsOriginOption(allowedOrigins) } });

    io.use((socket, next) => {
        try {
            const token = socket.handshake.auth && socket.handshake.auth.token;
            const decoded = token ? verifyToken(token) : null;
            if (!decoded || !decoded.id) return next(new Error('Unauthorized'));
            const user = getDb().prepare('SELECT id, is_active, token_version FROM users WHERE id = ?').get(decoded.id);
            if (!user || !user.is_active) return next(new Error('Unauthorized'));
            if ((decoded.token_version || 0) !== (user.token_version || 0)) return next(new Error('Unauthorized'));
            socket.userId = decoded.id;
            next();
        } catch (e) {
            next(new Error('Unauthorized'));
        }
    });

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