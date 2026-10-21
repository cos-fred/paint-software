const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-pricing-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.JWT_SECRET = 'p'.repeat(48);
process.env.ADMIN_PASSWORD = 'PricingAdminPass12';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initializeDatabase, getDb } = require('../database');
const { createApp } = require('../server');
const { request, listen } = require('./http');

let server;
let adminToken;
let warehouseId;
let productId;

async function login(username, password) {
    return request(server, { method: 'POST', path: '/api/auth/login', body: { username, password } });
}

describe('Server-authoritative pricing and validation', { concurrency: 1 }, () => {
    before(async () => {
        initializeDatabase();
        server = await listen(createApp());

        const adminLogin = await login('admin', 'PricingAdminPass12');
        assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.body));
        adminToken = adminLogin.body.token;

        const warehouses = await request(server, { path: '/api/warehouses', token: adminToken });
        warehouseId = warehouses.body[0].id;

        // unit_price 20 -> carton_price 240
        const prod = await request(server, {
            method: 'POST',
            path: '/api/products',
            token: adminToken,
            body: { name: 'Priced Paint', unit_price: 20, warehouse_id: warehouseId, carton_stock: 50 }
        });
        assert.equal(prod.status, 201, JSON.stringify(prod.body));
        productId = prod.body.id;

        // Disable tax so total equals subtotal for deterministic assertions.
        await request(server, { method: 'PUT', path: '/api/settings/tax_enabled', token: adminToken, body: { value: 'false' } });
    });

    after(async () => {
        if (server) await new Promise((resolve) => server.close(resolve));
    });

    it('uses the configured product price, ignoring a tampered unit_price', async () => {
        const res = await request(server, {
            method: 'POST',
            path: '/api/sales',
            token: adminToken,
            body: {
                warehouse_id: warehouseId,
                payment_method: 'cash',
                items: [{ product_id: productId, unit_type: 'carton', quantity: 1, unit_price: 1 }]
            }
        });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        const sale = getDb().prepare('SELECT subtotal, total FROM sales WHERE id = ?').get(res.body.id);
        // carton_price is 240, so subtotal must be 240 despite client sending 1
        assert.equal(sale.subtotal, 240);
        assert.equal(sale.total, 240);
    });

    it('rejects a fractional quantity instead of truncating it', async () => {
        const res = await request(server, {
            method: 'POST',
            path: '/api/sales',
            token: adminToken,
            body: {
                warehouse_id: warehouseId,
                payment_method: 'cash',
                items: [{ product_id: productId, unit_type: 'carton', quantity: '1.9' }]
            }
        });
        assert.equal(res.status, 400);
        assert.equal(res.body.error, 'Quantity must be a positive whole number');
    });

    it('rejects NaN and Infinity quantities', async () => {
        for (const qty of ['abc', 1e100]) {
            const res = await request(server, {
                method: 'POST',
                path: '/api/sales',
                token: adminToken,
                body: { warehouse_id: warehouseId, payment_method: 'cash', items: [{ product_id: productId, unit_type: 'carton', quantity: qty }] }
            });
            assert.equal(res.status, 400, `quantity ${qty} should be rejected`);
        }
    });

    it('rejects a negative line discount', async () => {
        const res = await request(server, {
            method: 'POST',
            path: '/api/sales',
            token: adminToken,
            body: {
                warehouse_id: warehouseId,
                payment_method: 'cash',
                items: [{ product_id: productId, unit_type: 'carton', quantity: 1, discount: -50 }]
            }
        });
        assert.equal(res.status, 400);
    });

    it('rejects a sale-level discount that exceeds the subtotal', async () => {
        const res = await request(server, {
            method: 'POST',
            path: '/api/sales',
            token: adminToken,
            body: {
                warehouse_id: warehouseId,
                payment_method: 'cash',
                discount: 999999,
                items: [{ product_id: productId, unit_type: 'carton', quantity: 1 }]
            }
        });
        assert.equal(res.status, 400);
    });

    it('rejects an invalid discount type', async () => {
        const res = await request(server, {
            method: 'POST',
            path: '/api/sales',
            token: adminToken,
            body: {
                warehouse_id: warehouseId,
                payment_method: 'cash',
                discount_type: 'bogus',
                discount: 5,
                items: [{ product_id: productId, unit_type: 'carton', quantity: 1 }]
            }
        });
        assert.equal(res.status, 400);
        assert.equal(res.body.error, 'Invalid discount type');
    });
});
