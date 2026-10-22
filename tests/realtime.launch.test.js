const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-live-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(temp, 'app.db');
process.env.JWT_SECRET = 'live-test-signing-key-of-more-than-48-characters';
process.env.ADMIN_PASSWORD = 'LiveAdminPass12';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { initializeDatabase, getDb } = require('../database');
const { generateToken, bumpTokenVersion } = require('../auth');
const realtime = require('../services/realtime');
let server, live, url;
const clients = [];
function connect(token) {
    return new Promise((resolve, reject) => {
        const socket = io(url, {
            auth: { token },
            transports: ['websocket'],
            reconnection: false,
            timeout: 2000
        });
        clients.push(socket);
        socket.once('connect', () => resolve(socket));
        socket.once('connect_error', reject);
    });
}
function disconnection(socket) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error('Expected session to disconnect')),
            3000
        );
        socket.once('disconnect', () => {
            clearTimeout(timeout);
            resolve();
        });
    });
}
describe('Live updates honor current account state', { concurrency: 1 }, () => {
    before(async () => {
        initializeDatabase();
        server = require('node:http').createServer(
            require('../server').createApp()
        );
        live = realtime.init(server, []);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        url = 'http://127.0.0.1:' + server.address().port;
    });
    after(async () => {
        clients.forEach((socket) => socket.disconnect());
        await new Promise((resolve) => live.close(resolve));
        getDb().close();
    });
    it('rejects accounts that must change their password', async () => {
        const id = randomUUID();
        const hash = getDb()
            .prepare("SELECT password_hash FROM users WHERE username='admin'")
            .get().password_hash;
        getDb()
            .prepare(
                'INSERT INTO users(id,username,email,password_hash,must_change_password) VALUES(?,?,?, ?,1)'
            )
            .run(id, 'required', 'required@example.invalid', hash);
        await assert.rejects(
            connect(generateToken({ id, username: 'required' })),
            /Unauthorized/
        );
    });
    it('disconnects an existing socket immediately when sessions are revoked', async () => {
        const admin = getDb()
            .prepare("SELECT * FROM users WHERE username='admin'")
            .get();
        const socket = await connect(generateToken(admin));
        const done = disconnection(socket);
        bumpTokenVersion(admin.id);
        await done;
        assert.equal(socket.connected, false);
    });
    it('does not broadcast to an account disabled after connecting', async () => {
        const admin = getDb()
            .prepare("SELECT * FROM users WHERE username='admin'")
            .get();
        const socket = await connect(generateToken(admin));
        let received = false;
        socket.on('data-changed', () => {
            received = true;
        });
        const done = disconnection(socket);
        getDb()
            .prepare('UPDATE users SET is_active=0 WHERE id=?')
            .run(admin.id);
        realtime.broadcast('change');
        await done;
        assert.equal(received, false);
        getDb()
            .prepare('UPDATE users SET is_active=1 WHERE id=?')
            .run(admin.id);
    });
    it('disconnects when the JWT expires even without a new broadcast', async () => {
        const admin = getDb()
            .prepare("SELECT * FROM users WHERE username='admin'")
            .get();
        const token = require('jsonwebtoken').sign(
            { id: admin.id, token_version: admin.token_version },
            process.env.JWT_SECRET,
            { expiresIn: 2 }
        );
        const socket = await connect(token);
        await disconnection(socket);
        assert.equal(socket.connected, false);
    });
});
