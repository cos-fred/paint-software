const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-api-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.JWT_SECRET = 'b'.repeat(48);
process.env.ADMIN_PASSWORD = 'InitialAdminPass12';
process.env.LOGIN_RATE_LIMIT_MAX = '3';
process.env.LOGIN_RATE_LIMIT_WINDOW_MS = '60000';
process.env.CORS_ORIGIN = 'https://app.example.com';
process.env.BACKUP_DIR = path.join(tmpDir, 'backups');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initializeDatabase, getDb } = require('../database');
const { createApp } = require('../server');
const { request, listen } = require('./http');

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'InitialAdminPass12';
const STAFF_USER = 'staffer';
const STAFF_PASS = 'StaffPass123';

let server;
let adminToken;
let staffToken;
let warehouseId;
let productId;
let saleId;

async function login(username, password) {
    const res = await request(server, {
        method: 'POST',
        path: '/api/auth/login',
        body: { username, password }
    });
    return res;
}

describe('API security', { concurrency: 1 }, () => {
    before(async () => {
        initializeDatabase();
        server = await listen(createApp());

        const adminLogin = await login(ADMIN_USER, ADMIN_PASS);
        assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.body));
        adminToken = adminLogin.body.token;

        const warehouses = await request(server, { path: '/api/products/warehouses', token: adminToken });
        assert.equal(warehouses.status, 200);
        warehouseId = warehouses.body[0].id;

        const createdUser = await request(server, {
            method: 'POST',
            path: '/api/auth/register',
            token: adminToken,
            body: { username: STAFF_USER, email: 'staff@example.com', password: STAFF_PASS, role: 'user' }
        });
        assert.equal(createdUser.status, 201, JSON.stringify(createdUser.body));

        const staffLogin = await login(STAFF_USER, STAFF_PASS);
        assert.equal(staffLogin.status, 200);
        staffToken = staffLogin.body.token;
    });

    after(async () => {
        if (server) await new Promise((resolve) => server.close(resolve));
    });

    it('rejects anonymous product mutations', async () => {
        const res = await request(server, {
            method: 'POST',
            path: '/api/products',
            body: { name: 'Nope', unit_price: 1, warehouse_id: warehouseId }
        });
        assert.equal(res.status, 401);
    });

    it('rejects ordinary users from creating, updating, deleting products or moving stock', async () => {
        const create = await request(server, {
            method: 'POST',
            path: '/api/products',
            token: staffToken,
            body: { name: 'Unauthorized Paint', unit_price: 10, warehouse_id: warehouseId, carton_stock: 5 }
        });
        assert.equal(create.status, 403);

        const count = getDb().prepare('SELECT COUNT(*) as n FROM products').get().n;
        assert.equal(count, 0);

        const adminCreate = await request(server, {
            method: 'POST',
            path: '/api/products',
            token: adminToken,
            body: { name: 'Interior White', unit_price: 20, warehouse_id: warehouseId, carton_stock: 10, liter20_stock: 4 }
        });
        assert.equal(adminCreate.status, 201, JSON.stringify(adminCreate.body));
        productId = adminCreate.body.id;

        const upd = await request(server, {
            method: 'PUT',
            path: `/api/products/${productId}`,
            token: staffToken,
            body: { name: 'Hacked' }
        });
        assert.equal(upd.status, 403);

        const stock = await request(server, {
            method: 'POST',
            path: `/api/products/${productId}/stock-movement`,
            token: staffToken,
            body: { movement_type: 'in', unit_type: 'carton', quantity: 99, warehouse_id: warehouseId }
        });
        assert.equal(stock.status, 403);

        const del = await request(server, {
            method: 'DELETE',
            path: `/api/products/${productId}`,
            token: staffToken
        });
        assert.equal(del.status, 403);
        const still = getDb().prepare('SELECT name FROM products WHERE id = ?').get(productId);
        assert.equal(still.name, 'Interior White');
    });

    it('lets staff create sales but not change payment status or cancel', async () => {
        const sale = await request(server, {
            method: 'POST',
            path: '/api/sales',
            token: staffToken,
            body: {
                warehouse_id: warehouseId,
                payment_method: 'cash',
                items: [{ product_id: productId, unit_type: 'carton', quantity: 1 }]
            }
        });
        assert.equal(sale.status, 201, JSON.stringify(sale.body));
        saleId = sale.body.id;

        const status = await request(server, {
            method: 'PUT',
            path: `/api/sales/${saleId}/payment-status`,
            token: staffToken,
            body: { payment_status: 'refunded' }
        });
        assert.equal(status.status, 403);

        const cancel = await request(server, {
            method: 'DELETE',
            path: `/api/sales/${saleId}`,
            token: staffToken
        });
        assert.equal(cancel.status, 403);
        const row = getDb().prepare('SELECT payment_status FROM sales WHERE id = ?').get(saleId);
        assert.equal(row.payment_status, 'completed');
    });

    it('rejects invalid payment transitions and restocks on cancel', async () => {
        const completedAgain = await request(server, {
            method: 'PUT',
            path: `/api/sales/${saleId}/payment-status`,
            token: adminToken,
            body: { payment_status: 'completed' }
        });
        assert.equal(completedAgain.status, 400);

        const pending = await request(server, {
            method: 'PUT',
            path: `/api/sales/${saleId}/payment-status`,
            token: adminToken,
            body: { payment_status: 'pending' }
        });
        assert.equal(pending.status, 400);

        const before = getDb().prepare(
            'SELECT carton_stock FROM product_stock WHERE product_id = ? AND warehouse_id = ?'
        ).get(productId, warehouseId).carton_stock;

        const cancel = await request(server, {
            method: 'DELETE',
            path: `/api/sales/${saleId}`,
            token: adminToken
        });
        assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
        const after = getDb().prepare(
            'SELECT carton_stock FROM product_stock WHERE product_id = ? AND warehouse_id = ?'
        ).get(productId, warehouseId);
        assert.equal(after.carton_stock, before + 1);
        const saleRow = getDb().prepare('SELECT payment_status FROM sales WHERE id = ?').get(saleId);
        assert.equal(saleRow.payment_status, 'cancelled');

        const cancelAgain = await request(server, {
            method: 'DELETE',
            path: `/api/sales/${saleId}`,
            token: adminToken
        });
        assert.equal(cancelAgain.status, 400);
    });

    it('does not expose internal errors for invalid sale payloads', async () => {
        const res = await request(server, {
            method: 'POST',
            path: '/api/sales',
            token: staffToken,
            body: {
                warehouse_id: warehouseId,
                items: [{ product_id: productId, unit_type: 'carton); DROP TABLE products;--', quantity: 1 }]
            }
        });
        assert.equal(res.status, 400);
        const text = JSON.stringify(res.body);
        assert.equal(text.includes('SQLITE'), false);
        assert.equal(text.includes('DROP TABLE'), false);
        assert.equal(res.body.error, 'Invalid unit type');
    });

    it('allows configured CORS origin and withholds it from others', async () => {
        const allowed = await request(server, {
            path: '/api/health',
            headers: { Origin: 'https://app.example.com' }
        });
        assert.equal(allowed.status, 200);
        assert.equal(allowed.headers['access-control-allow-origin'], 'https://app.example.com');

        const denied = await request(server, {
            path: '/api/health',
            headers: { Origin: 'https://evil.example' }
        });
        assert.equal(denied.status, 200);
        assert.notEqual(denied.headers['access-control-allow-origin'], 'https://evil.example');
    });

    it('throttles repeated failed logins without blocking other API routes', async () => {
        const first = await login('admin', 'wrong-password-1');
        const second = await login('admin', 'wrong-password-2');
        const third = await login('admin', 'wrong-password-3');
        assert.equal(first.status, 401);
        assert.equal(second.status, 401);
        assert.equal(third.status, 401);
        const fourth = await login('admin', 'wrong-password-4');
        assert.equal(fourth.status, 429);

        const health = await request(server, { path: '/api/health' });
        assert.equal(health.status, 200);

        const products = await request(server, { path: '/api/products', token: adminToken });
        assert.equal(products.status, 200);
    });

    it('revokes stale privileges after demotion, disable, and password change', async () => {
        const extra = await request(server, {
            method: 'POST',
            path: '/api/auth/register',
            token: adminToken,
            body: { username: 'tempadmin', email: 'tempadmin@example.com', password: 'TempAdminPass9', role: 'admin' }
        });
        assert.equal(extra.status, 201, JSON.stringify(extra.body));
        const extraLogin = await login('tempadmin', 'TempAdminPass9');
        assert.equal(extraLogin.status, 200);
        const extraToken = extraLogin.body.token;
        const extraId = extra.body.id;

        const beforeDemote = await request(server, {
            method: 'POST',
            path: '/api/products',
            token: extraToken,
            body: { name: 'Temp Product', unit_price: 5, warehouse_id: warehouseId }
        });
        assert.equal(beforeDemote.status, 201, JSON.stringify(beforeDemote.body));

        const demote = await request(server, {
            method: 'PUT',
            path: `/api/auth/users/${extraId}`,
            token: adminToken,
            body: { role: 'user' }
        });
        assert.equal(demote.status, 200);

        const afterDemote = await request(server, {
            method: 'POST',
            path: '/api/products',
            token: extraToken,
            body: { name: 'Should Fail', unit_price: 5, warehouse_id: warehouseId }
        });
        assert.equal(afterDemote.status, 403);

        const disable = await request(server, {
            method: 'PUT',
            path: `/api/auth/users/${extraId}`,
            token: adminToken,
            body: { is_active: 0 }
        });
        assert.equal(disable.status, 200);
        const afterDisable = await request(server, { path: '/api/products', token: extraToken });
        assert.equal(afterDisable.status, 403);

        const change = await request(server, {
            method: 'PUT',
            path: '/api/auth/change-password',
            token: staffToken,
            body: { current_password: STAFF_PASS, new_password: 'StaffPass456' }
        });
        assert.equal(change.status, 200, JSON.stringify(change.body));
        const stale = await request(server, { path: '/api/products', token: staffToken });
        assert.equal(stale.status, 403);
        const fresh = await login(STAFF_USER, 'StaffPass456');
        assert.equal(fresh.status, 200);
        const ok = await request(server, { path: '/api/products', token: fresh.body.token });
        assert.equal(ok.status, 200);
    });
});
