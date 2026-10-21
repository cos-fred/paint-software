const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-reset-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.JWT_SECRET = 'r'.repeat(48);
process.env.ADMIN_PASSWORD = 'ResetAdminPass12';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initializeDatabase, getDb } = require('../database');
const { createApp } = require('../server');
const { request, listen } = require('./http');

let server;
let adminToken;

describe('System reset', { concurrency: 1 }, () => {
    before(async () => {
        initializeDatabase();
        server = await listen(createApp());
        const login = await request(server, { method: 'POST', path: '/api/auth/login', body: { username: 'admin', password: 'ResetAdminPass12' } });
        adminToken = login.body.token;
    });

    after(async () => {
        if (server) await new Promise((resolve) => server.close(resolve));
    });

    it('only the primary admin can reset; password is required and verified', async () => {
        const wh = (await request(server, { path: '/api/warehouses', token: adminToken })).body[0];

        await request(server, { method: 'POST', path: '/api/products', token: adminToken, body: { name: 'Paint', unit_price: 10, warehouse_id: wh.id, carton_stock: 5 } });
        await request(server, { method: 'POST', path: '/api/auth/register', token: adminToken, body: { username: 'admin2', email: 'a2@x.com', password: 'Admin2Pass12', role: 'admin' } });
        await request(server, { method: 'POST', path: '/api/auth/register', token: adminToken, body: { username: 'staff', email: 's@x.com', password: 'StaffPass123', role: 'user' } });

        const admin2Login = await request(server, { method: 'POST', path: '/api/auth/login', body: { username: 'admin2', password: 'Admin2Pass12' } });
        const admin2Token = admin2Login.body.token;

        // Secondary admin is denied.
        const denied = await request(server, { method: 'POST', path: '/api/system/reset', token: admin2Token, body: { password: 'Admin2Pass12' } });
        assert.equal(denied.status, 403);

        // Wrong password is rejected.
        const wrongPw = await request(server, { method: 'POST', path: '/api/system/reset', token: adminToken, body: { password: 'nope' } });
        assert.equal(wrongPw.status, 400);

        // Correct password wipes everything except the primary admin.
        const reset = await request(server, { method: 'POST', path: '/api/system/reset', token: adminToken, body: { password: 'ResetAdminPass12' } });
        assert.equal(reset.status, 200, JSON.stringify(reset.body));

        const db = getDb();
        assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, 0);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM warehouses').get().n, 2);
        assert.ok(db.prepare('SELECT COUNT(*) n FROM settings').get().n > 0);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM sales').get().n, 0);
        assert.ok(db.prepare('SELECT id FROM users WHERE username = ?').get('admin'));

        const relogin = await request(server, { method: 'POST', path: '/api/auth/login', body: { username: 'admin', password: 'ResetAdminPass12' } });
        assert.equal(relogin.status, 200);
    });
});
