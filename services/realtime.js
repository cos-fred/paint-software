let io = null;

function validSession(socket) {
    const decoded = require('../auth').verifyToken(
        socket.handshake.auth?.token
    );
    if (!decoded?.id) return false;
    const user = require('../database')
        .getDb()
        .prepare(
            'SELECT is_active,token_version,must_change_password FROM users WHERE id=?'
        )
        .get(decoded.id);
    return !!(
        user?.is_active &&
        !user.must_change_password &&
        (user.token_version || 0) === (decoded.token_version || 0)
    );
}

function init(server, allowedOrigins) {
    const { Server } = require('socket.io');
    const { verifyToken } = require('../auth');
    const { getDb } = require('../database');
    const { corsOriginOption } = require('../lib/cors');

    io = new Server(server, {
        cors: { origin: corsOriginOption(allowedOrigins) }
    });

    io.use((socket, next) => {
        try {
            const token = socket.handshake.auth && socket.handshake.auth.token;
            const decoded = token ? verifyToken(token) : null;
            if (!decoded || !decoded.id) return next(new Error('Unauthorized'));
            const user = getDb()
                .prepare(
                    'SELECT id, is_active, token_version, must_change_password FROM users WHERE id = ?'
                )
                .get(decoded.id);
            if (!user || !user.is_active || user.must_change_password)
                return next(new Error('Unauthorized'));
            if ((decoded.token_version || 0) !== (user.token_version || 0))
                return next(new Error('Unauthorized'));
            socket.userId = decoded.id;
            next();
        } catch (e) {
            next(new Error('Unauthorized'));
        }
    });

    io.on('connection', (socket) => {
        const decoded = verifyToken(socket.handshake.auth.token);
        const timer = setTimeout(
            () => socket.disconnect(true),
            Math.max(0, Math.min(decoded.exp * 1000 - Date.now(), 2147483647))
        );
        timer.unref();
        socket.on('disconnect', () => clearTimeout(timer));
        console.log('[realtime] client connected');
        socket.on('disconnect', () =>
            console.log('[realtime] client disconnected')
        );
    });
    return io;
}

// Broadcast a data-change event so all connected clients refresh.
function broadcast(type, payload = {}) {
    if (io)
        for (const socket of io.sockets.sockets.values()) {
            try {
                if (validSession(socket))
                    socket.emit('data-changed', {
                        type,
                        ...payload,
                        at: Date.now()
                    });
                else socket.disconnect(true);
            } catch {
                socket.disconnect(true);
            }
        }
}

function invalidateUser(userId) {
    if (io)
        for (const socket of io.sockets.sockets.values())
            if (socket.userId === userId) socket.disconnect(true);
}
function close() {
    if (io) {
        io.close();
        io = null;
    }
}
module.exports = { init, broadcast, invalidateUser, close };
