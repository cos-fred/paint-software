const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-recovery-api-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(directory, 'app.db');
process.env.JWT_SECRET = 'r'.repeat(48);
process.env.ADMIN_PASSWORD = 'RecoveryFixturePass22';
const { before, after, it } = require('node:test');
const assert = require('node:assert/strict');
const { initializeDatabase, getDb } = require('../database');
const { createApp } = require('../server');
const { listen, request } = require('./http');
let server, token, warehouse;
async function send(method, url, body, headers = {}) {
    return request(server, { method, path: url, body, token, headers });
}
before(async () => {
    initializeDatabase();
    server = await listen(createApp());
    token = (
        await send('POST', '/api/auth/login', {
            username: 'admin',
            password: process.env.ADMIN_PASSWORD
        })
    ).body.token;
    warehouse = (await send('GET', '/api/warehouses')).body[0].id;
});
after(async () => {
    await new Promise((resolve) => server.close(resolve));
    getDb().close();
});

it('rejects returns with missing warehouse stock without leaving partial credits', async () => {
    const created = await send('POST', '/api/products', {
        name: 'Missing stock row return', warehouse_id: warehouse,
        unit_price: 10, units_per_carton: 12, cartons: 1
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const product = created.body.id;
    const sale = await send('POST', '/api/sales', {
        warehouse_id: warehouse,
        items: [{ product_id: product, unit_type: 'unit', quantity: 1 }]
    });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const db = getDb();
    db.prepare('DELETE FROM product_stock WHERE product_id=? AND warehouse_id=?').run(product, warehouse);
    const snapshot = () => ['sale_returns', 'stock_movements', 'sale_payments', 'audit_logs']
        .map((table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    const before = snapshot();
    const result = await send('POST', '/api/returns', {
        sale_id: sale.body.id,
        items: [{ product_id: product, unit_type: 'unit', quantity: 1 }]
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'Product stock row not found for this warehouse');
    assert.deepEqual(snapshot(), before);
    assert.equal(db.prepare('SELECT total FROM sales WHERE id=?').get(sale.body.id).total, 10);
});

it('returns and cancellation recover only their own stock pool without duplicate recovery events', async () => {
    const created = await send('POST', '/api/products', {
        name: 'Recovery Paint',
        warehouse_id: warehouse,
        unit_price: 10,
        units_per_carton: 1,
        cartons: 5,
        liter20_price: 20,
        liter20_stock: 5,
        low_stock_threshold: 1
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const product = created.body.id;
    const sale = async (items) => {
        const result = await send('POST', '/api/sales', {
            warehouse_id: warehouse,
            items
        });
        assert.equal(result.status, 201, JSON.stringify(result.body));
        return result.body.id;
    };
    const units = await sale([
        { product_id: product, unit_type: 'unit', quantity: 2 },
        { product_id: product, unit_type: 'unit', quantity: 2 }
    ]);
    const liters = await sale([
        { product_id: product, unit_type: 'liter20', quantity: 4 }
    ]);
    const db = getDb();
    const unread = (pool) =>
        db
            .prepare(
                "SELECT COUNT(*) AS n FROM alerts WHERE product_id=? AND stock_pool=? AND type='low_stock' AND is_read=0"
            )
            .get(product, pool).n;
    assert.equal(unread('unit_stock'), 1);
    assert.equal(unread('liter20_stock'), 1);
    assert.equal((await send('DELETE', '/api/sales/' + units)).status, 200);
    assert.equal(unread('unit_stock'), 0);
    assert.equal(unread('liter20_stock'), 1);
    const details = (await send('GET', '/api/sales/' + liters)).body;
    const body = {
        sale_id: liters,
        items: [{ sale_item_id: details.items[0].id, quantity: 1 }]
    };
    const headers = { 'Idempotency-Key': 'stock-recovery-return-1234' };
    assert.equal(
        (await send('POST', '/api/returns', body, headers)).status,
        201
    );
    assert.equal(
        (await send('POST', '/api/returns', body, headers)).status,
        200
    );
    assert.equal(unread('liter20_stock'), 0);
    const events = db
        .prepare(
            "SELECT stock_pool FROM alerts WHERE product_id=? AND message LIKE 'Stock recovered:%'"
        )
        .all(product);
    assert.equal(events.length, 2);
    assert.deepEqual(
        new Set(events.map((e) => e.stock_pool)),
        new Set(['unit_stock', 'liter20_stock'])
    );
    assert.equal(
        (
            await send('PUT', `/api/sales/${liters}/payment-status`, {
                payment_status: 'refunded'
            })
        ).status,
        200
    );
    assert.equal(
        db
            .prepare(
                "SELECT COUNT(*) AS n FROM alerts WHERE product_id=? AND message LIKE 'Stock recovered:%'"
            )
            .get(product).n,
        2
    );
    assert.deepEqual(
        db
            .prepare(
                'SELECT unit_stock,liter20_stock FROM product_stock WHERE product_id=? AND warehouse_id=?'
            )
            .get(product, warehouse),
        { unit_stock: 5, liter20_stock: 5 }
    );
});

it('new sales and receipt responses expose no sales tax field', async () => {
    const created = await send('POST', '/api/products', {
        name: 'No Tax Paint',
        warehouse_id: warehouse,
        unit_price: 10,
        units_per_carton: 1,
        cartons: 2
    });
    const sale = await send('POST', '/api/sales', {
        warehouse_id: warehouse,
        items: [{ product_id: created.body.id, unit_type: 'unit', quantity: 1 }]
    });
    assert.equal(sale.status, 201);
    const details = (await send('GET', '/api/sales/' + sale.body.id)).body;
    const receipt = (await send('GET', `/api/sales/${sale.body.id}/receipt`))
        .body;
    assert.equal(Object.hasOwn(details, 'tax'), false);
    assert.equal(Object.hasOwn(receipt, 'tax'), false);
    assert.equal(
        getDb()
            .prepare('PRAGMA table_info(sales)')
            .all()
            .some((c) => c.name === 'tax'),
        false
    );
});

it('refunds and incoming transfers both publish recovery after committing stock', async () => {
    const product = (
        await send('POST', '/api/products', {
            name: 'Refund and transfer paint',
            warehouse_id: warehouse,
            unit_price: 10,
            units_per_carton: 1,
            cartons: 7,
            low_stock_threshold: 1
        })
    ).body.id;
    async function sell() {
        const sale = await send('POST', '/api/sales', {
            warehouse_id: warehouse,
            items: [{ product_id: product, unit_type: 'unit', quantity: 6 }]
        });
        assert.equal(sale.status, 201);
        return sale.body.id;
    }
    const first = await sell();
    assert.equal(
        (
            await send('PUT', `/api/sales/${first}/payment-status`, {
                payment_status: 'refunded'
            })
        ).status,
        200
    );
    await sell();
    const other = (await send('GET', '/api/warehouses')).body.find(
        (w) => w.id !== warehouse
    ).id;
    getDb()
        .prepare(
            'UPDATE product_stock SET unit_stock=10 WHERE product_id=? AND warehouse_id=?'
        )
        .run(product, other);
    const moved = await send('POST', '/api/transfers', {
        product_id: product,
        from_warehouse_id: other,
        to_warehouse_id: warehouse,
        unit_type: 'unit',
        quantity: 2
    });
    assert.equal(moved.status, 201, JSON.stringify(moved.body));
    assert.equal(
        getDb()
            .prepare(
                "SELECT COUNT(*) AS n FROM alerts WHERE product_id=? AND warehouse_id=? AND message LIKE 'Stock recovered:%'"
            )
            .get(product, warehouse).n,
        2
    );
    assert.equal(
        getDb()
            .prepare(
                "SELECT COUNT(*) AS n FROM alerts WHERE product_id=? AND warehouse_id=? AND type='low_stock' AND is_read=0"
            )
            .get(product, warehouse).n,
        0
    );
});

it('labels legacy carton receipts explicitly when their historical size is unknown', async () => {
    const product = (
        await send('POST', '/api/products', {
            name: 'Unknown historical carton',
            warehouse_id: warehouse,
            unit_price: 10,
            units_per_carton: 12,
            cartons: 2
        })
    ).body.id;
    const sale = await send('POST', '/api/sales', {
        warehouse_id: warehouse,
        items: [{ product_id: product, unit_type: 'carton', quantity: 1 }]
    });
    assert.equal(sale.status, 201);
    getDb()
        .prepare('UPDATE sale_items SET units_per_carton=0 WHERE sale_id=?')
        .run(sale.body.id);
    const receipt = await send('GET', `/api/sales/${sale.body.id}/receipt`);
    assert.equal(receipt.status, 200);
    assert.equal(receipt.body.items[0].unit_type, 'Carton (size not recorded)');
});
