const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'paint-sale-stock-')), 'test.db');
process.env.JWT_SECRET = 'sale-stock-test-'.repeat(4);
process.env.ADMIN_PASSWORD = 'StockValidationPass12';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initializeDatabase, getDb } = require('../database');
const { createApp } = require('../server');
const { request, listen } = require('./http');
let server, token, warehouses;
async function product(name, extra = {}) {
    const result = await request(server, { method: 'POST', path: '/api/products', token,
        body: { name, unit_price: 10, units_per_carton: 12, cartons: 1,
            loose_units: 2, warehouse_id: warehouses[0].id, ...extra } });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.id;
}
const item = (product_id, quantity, unit_type = 'unit') => ({ product_id, quantity, unit_type });
async function sale(items, extra = {}) {
    return request(server, { method: 'POST', path: '/api/sales', token,
        headers: { 'Idempotency-Key': 'stock-validation-request' },
        body: { warehouse_id: warehouses[0].id, items, ...extra } });
}
function snapshot() {
    const db = getDb();
    return {
        stock: db.prepare('SELECT * FROM product_stock ORDER BY product_id,warehouse_id').all(),
        counts: ['sales', 'sale_items', 'sale_payments', 'stock_movements', 'audit_logs', 'request_keys']
            .map((table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)
    };
}
describe('Sale stock shortage feedback', { concurrency: 1 }, () => {
    before(async () => {
        initializeDatabase(); server = await listen(createApp());
        token = (await request(server, { method: 'POST', path: '/api/auth/login',
            body: { username: 'admin', password: process.env.ADMIN_PASSWORD } })).body.token;
        warehouses = (await request(server, { path: '/api/warehouses', token })).body;
    });
    after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); });
    it('lists all insufficient products, excludes sufficient lines and writes nothing', async () => {
        const enough = await product('Enough paint');
        const blue = await product('Ocean Blue', { sku: 'BLUE-01' });
        const white = await product('White 20L', { liter20_stock: 1, liter20_price: 50 });
        const before = snapshot();
        const result = await sale([item(enough, 1), item(blue, 15), item(white, 2, 'liter20')]);
        assert.equal(result.status, 400);
        assert.equal(result.body.code, 'INSUFFICIENT_STOCK');
        assert.deepEqual(result.body.shortages.map((s) => s.product_id), [blue, white]);
        assert.match(result.body.error, /Ocean Blue \(BLUE-01\).*15 units.*14 units total/);
        assert.match(result.body.error, /White 20L.*2 20L containers.*1 20L container/);
        assert.deepEqual(result.body.shortages.map((s) => s.item_indexes), [[1], [2]]);
        assert.deepEqual(snapshot(), before);
    });
    it('combines duplicate unit lines and mixed cartons/units before checking stock', async () => {
        const p = await product('Mixed carton paint');
        const result = await sale([item(p, 1, 'carton'), item(p, 2), item(p, 1)]);
        assert.equal(result.status, 400);
        const [shortage] = result.body.shortages;
        assert.equal(shortage.requested, 15);
        assert.equal(shortage.available, 14);
        assert.deepEqual(shortage.item_indexes, [0, 1, 2]);
        assert.equal(shortage.requested_label, '1 carton + 3 units (15 units total)');
        assert.equal(shortage.available_label, '1 carton + 2 loose units (14 units total)');
    });
    it('reports unit and 20L shortages separately for the same product', async () => {
        const p = await product('Both pools', { liter20_stock: 2, liter20_price: 50 });
        const result = await sale([item(p, 15), item(p, 3, 'liter20')]);
        assert.deepEqual(result.body.shortages.map((s) => s.pool), ['units', 'liter20']);
        assert.deepEqual(result.body.shortages.map((s) => s.item_indexes), [[0], [1]]);
    });
    it('uses zero stock and names the product when it has no row in the warehouse', async () => {
        const p = await product('Unstocked branch paint');
        const result = await sale([item(p, 1)], { warehouse_id: warehouses[1].id });
        assert.equal(result.status, 400);
        assert.equal(result.body.shortages[0].product_name, 'Unstocked branch paint');
        assert.equal(result.body.shortages[0].available, 0);
    });
    it('accepts a corrected exact-stock sale and keeps 20L independent', async () => {
        const p = await product('Corrected paint', { liter20_stock: 2, liter20_price: 50 });
        assert.equal((await sale([item(p, 2, 'carton')])).status, 400);
        const result = await sale([item(p, 1, 'carton'), item(p, 2), item(p, 2, 'liter20')]);
        assert.equal(result.status, 201, JSON.stringify(result.body));
        const stock = getDb().prepare('SELECT unit_stock,liter20_stock FROM product_stock WHERE product_id=? AND warehouse_id=?')
            .get(p, warehouses[0].id);
        assert.deepEqual(stock, { unit_stock: 0, liter20_stock: 0 });
        assert.equal((await sale([item(p, 1, 'carton'), item(p, 2), item(p, 2, 'liter20')])).status, 200);
    });
});
