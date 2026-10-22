const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-units-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.JWT_SECRET = 'u'.repeat(48);
process.env.ADMIN_PASSWORD = 'UnitsAdminPass12';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initializeDatabase, getDb } = require('../database');
const { createApp } = require('../server');
const { request, listen } = require('./http');
const { splitUnits } = require('../lib/stock');

let server;
let token;
let warehouseId;

describe('Carton + unit single-pool inventory', { concurrency: 1 }, () => {
    before(async () => {
        initializeDatabase();
        server = await listen(createApp());
        const login = await request(server, {
            method: 'POST',
            path: '/api/auth/login',
            body: { username: 'admin', password: 'UnitsAdminPass12' }
        });
        token = login.body.token;
        warehouseId = (
            await request(server, { path: '/api/warehouses', token })
        ).body[0].id;
    });

    after(async () => {
        if (server) await new Promise((resolve) => server.close(resolve));
    });

    it('creates a product with configurable units-per-carton and calculates total units', async () => {
        const res = await request(server, {
            method: 'POST',
            path: '/api/products',
            token,
            body: {
                name: 'Emulsion',
                unit_price: 10,
                units_per_carton: 12,
                warehouse_id: warehouseId,
                cartons: 5,
                loose_units: 7
            }
        });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.unit_stock, 67);
        assert.equal(res.body.carton_price, 120);
        const stock = getDb()
            .prepare(
                'SELECT unit_stock FROM product_stock WHERE product_id=? AND warehouse_id=?'
            )
            .get(res.body.id, warehouseId);
        assert.equal(stock.unit_stock, 67);
    });

    it('rejects a non-positive units-per-carton', async () => {
        const res = await request(server, {
            method: 'POST',
            path: '/api/products',
            token,
            body: {
                name: 'Bad',
                unit_price: 10,
                units_per_carton: 0,
                warehouse_id: warehouseId
            }
        });
        assert.equal(res.status, 400);
    });

    it('sells cartons and units against the same total-units pool', async () => {
        const prod = await request(server, {
            method: 'POST',
            path: '/api/products',
            token,
            body: {
                name: 'Paint',
                unit_price: 10,
                units_per_carton: 12,
                warehouse_id: warehouseId,
                cartons: 10
            }
        });
        const pid = prod.body.id;

        const sale1 = await request(server, {
            method: 'POST',
            path: '/api/sales',
            token,
            body: {
                warehouse_id: warehouseId,
                payment_method: 'cash',
                items: [{ product_id: pid, unit_type: 'carton', quantity: 2 }]
            }
        });
        assert.equal(sale1.status, 201, JSON.stringify(sale1.body));
        const subtotal1 = getDb()
            .prepare('SELECT subtotal FROM sales WHERE id=?')
            .get(sale1.body.id).subtotal;
        assert.equal(subtotal1, 240);

        const sale2 = await request(server, {
            method: 'POST',
            path: '/api/sales',
            token,
            body: {
                warehouse_id: warehouseId,
                payment_method: 'cash',
                items: [{ product_id: pid, unit_type: 'unit', quantity: 3 }]
            }
        });
        assert.equal(sale2.status, 201, JSON.stringify(sale2.body));
        const subtotal2 = getDb()
            .prepare('SELECT subtotal FROM sales WHERE id=?')
            .get(sale2.body.id).subtotal;
        assert.equal(subtotal2, 30);

        const stock = getDb()
            .prepare(
                'SELECT unit_stock FROM product_stock WHERE product_id=? AND warehouse_id=?'
            )
            .get(pid, warehouseId).unit_stock;
        assert.equal(stock, 10 * 12 - 24 - 3);
    });

    it('splits total units into cartons and loose units', () => {
        assert.deepEqual(splitUnits(67, 12), {
            cartons: 5,
            units: 7,
            totalUnits: 67
        });
        assert.deepEqual(splitUnits(5, 12), {
            cartons: 0,
            units: 5,
            totalUnits: 5
        });
        assert.deepEqual(splitUnits(24, 12), {
            cartons: 2,
            units: 0,
            totalUnits: 24
        });
    });

    it('returns restore the correct number of units', async () => {
        const prod = await request(server, {
            method: 'POST',
            path: '/api/products',
            token,
            body: {
                name: 'Return Paint',
                unit_price: 10,
                units_per_carton: 12,
                warehouse_id: warehouseId,
                cartons: 10
            }
        });
        const pid = prod.body.id;
        const sale = await request(server, {
            method: 'POST',
            path: '/api/sales',
            token,
            body: {
                warehouse_id: warehouseId,
                payment_method: 'cash',
                items: [{ product_id: pid, unit_type: 'carton', quantity: 1 }]
            }
        });
        const before = getDb()
            .prepare(
                'SELECT unit_stock FROM product_stock WHERE product_id=? AND warehouse_id=?'
            )
            .get(pid, warehouseId).unit_stock;
        const ret = await request(server, {
            method: 'POST',
            path: '/api/returns',
            token,
            body: {
                sale_id: sale.body.id,
                items: [{ product_id: pid, unit_type: 'carton', quantity: 1 }]
            }
        });
        assert.equal(ret.status, 201, JSON.stringify(ret.body));
        const after = getDb()
            .prepare(
                'SELECT unit_stock FROM product_stock WHERE product_id=? AND warehouse_id=?'
            )
            .get(pid, warehouseId).unit_stock;
        assert.equal(after, before + 12);
    });

    it('records the sale-time units-per-carton and prints the real carton size', async () => {
        const prod = await request(server, {
            method: 'POST',
            path: '/api/products',
            token,
            body: {
                name: 'Six Pack',
                unit_price: 10,
                units_per_carton: 6,
                warehouse_id: warehouseId,
                cartons: 10
            }
        });
        const pid = prod.body.id;
        const sale = await request(server, {
            method: 'POST',
            path: '/api/sales',
            token,
            body: {
                warehouse_id: warehouseId,
                payment_method: 'cash',
                items: [{ product_id: pid, unit_type: 'carton', quantity: 1 }]
            }
        });
        assert.equal(sale.status, 201, JSON.stringify(sale.body));

        const item = getDb()
            .prepare(
                'SELECT units_per_carton FROM sale_items WHERE sale_id = ?'
            )
            .get(sale.body.id);
        assert.equal(item.units_per_carton, 6);

        const receipt = await request(server, {
            path: `/api/sales/${sale.body.id}/receipt`,
            token
        });
        assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
        assert.equal(receipt.body.items[0].unit_type, 'Carton (6 units)');
    });

    it('returns use the units-per-carton that applied when the sale was made', async () => {
        const prod = await request(server, {
            method: 'POST',
            path: '/api/products',
            token,
            body: {
                name: 'Return Six Pack',
                unit_price: 10,
                units_per_carton: 6,
                warehouse_id: warehouseId,
                cartons: 10
            }
        });
        const pid = prod.body.id;
        const sale = await request(server, {
            method: 'POST',
            path: '/api/sales',
            token,
            body: {
                warehouse_id: warehouseId,
                payment_method: 'cash',
                items: [{ product_id: pid, unit_type: 'carton', quantity: 1 }]
            }
        });
        assert.equal(sale.status, 201, JSON.stringify(sale.body));

        const put = await request(server, {
            method: 'PUT',
            path: `/api/products/${pid}`,
            token,
            body: { units_per_carton: 10 }
        });
        assert.equal(put.status, 200, JSON.stringify(put.body));

        const before = getDb()
            .prepare(
                'SELECT unit_stock FROM product_stock WHERE product_id=? AND warehouse_id=?'
            )
            .get(pid, warehouseId).unit_stock;
        const ret = await request(server, {
            method: 'POST',
            path: '/api/returns',
            token,
            body: {
                sale_id: sale.body.id,
                items: [{ product_id: pid, unit_type: 'carton', quantity: 1 }]
            }
        });
        assert.equal(ret.status, 201, JSON.stringify(ret.body));
        const after = getDb()
            .prepare(
                'SELECT unit_stock FROM product_stock WHERE product_id=? AND warehouse_id=?'
            )
            .get(pid, warehouseId).unit_stock;
        assert.equal(after, before + 6);
    });

    it('cancelling a sale restores the sale-time carton size after an edit', async () => {
        const prod = await request(server, {
            method: 'POST',
            path: '/api/products',
            token,
            body: {
                name: 'Cancel Six Pack',
                unit_price: 10,
                units_per_carton: 6,
                warehouse_id: warehouseId,
                cartons: 10
            }
        });
        const pid = prod.body.id;
        const sale = await request(server, {
            method: 'POST',
            path: '/api/sales',
            token,
            body: {
                warehouse_id: warehouseId,
                payment_method: 'cash',
                items: [{ product_id: pid, unit_type: 'carton', quantity: 1 }]
            }
        });
        assert.equal(sale.status, 201, JSON.stringify(sale.body));

        const put = await request(server, {
            method: 'PUT',
            path: `/api/products/${pid}`,
            token,
            body: { units_per_carton: 10 }
        });
        assert.equal(put.status, 200, JSON.stringify(put.body));

        const cancel = await request(server, {
            method: 'DELETE',
            path: `/api/sales/${sale.body.id}`,
            token
        });
        assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
        const stock = getDb()
            .prepare(
                'SELECT unit_stock FROM product_stock WHERE product_id=? AND warehouse_id=?'
            )
            .get(pid, warehouseId).unit_stock;
        assert.equal(stock, 60);
    });

    it('converts legacy carton stock to total units when units-per-carton is set', async () => {
        const db = getDb();
        const legacyId = 'legacy-' + Math.random().toString(36).slice(2);
        db.prepare(
            "INSERT INTO products (id, name, unit_price, carton_price, liter20_price, units_per_carton, low_stock_threshold) VALUES (?, 'Legacy', 20, 240, 0, 0, 10)"
        ).run(legacyId);
        db.prepare(
            'INSERT INTO product_stock (id, product_id, warehouse_id, unit_stock, carton_stock, liter20_stock) VALUES (?, ?, ?, 0, 5, 0)'
        ).run(
            'st-' + Math.random().toString(36).slice(2),
            legacyId,
            warehouseId
        );
        db.prepare(
            "INSERT INTO alerts(id,type,product_id,warehouse_id,message,severity) VALUES(?,'system',?,?,'Inventory review required: legacy cartons','warning')"
        ).run('alert-' + legacyId, legacyId, warehouseId);

        const put = await request(server, {
            method: 'PUT',
            path: `/api/products/${legacyId}`,
            token,
            body: { units_per_carton: 12 }
        });
        assert.equal(put.status, 200, JSON.stringify(put.body));
        const row = db
            .prepare(
                'SELECT unit_stock, carton_stock FROM product_stock WHERE product_id=? AND warehouse_id=?'
            )
            .get(legacyId, warehouseId);
        assert.equal(row.unit_stock, 60);
        assert.equal(row.carton_stock, 0);
        assert.equal(
            db
                .prepare('SELECT is_read FROM alerts WHERE id=?')
                .get('alert-' + legacyId).is_read,
            1
        );
    });
});
