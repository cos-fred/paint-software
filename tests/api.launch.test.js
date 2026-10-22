const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-launch-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(temp, 'app.db');
process.env.BACKUP_DIR = path.join(temp, 'backups');
process.env.JWT_SECRET = 'launch-test-signing-key-with-at-least-48-characters';
process.env.ADMIN_PASSWORD = 'LaunchAdminPass12';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { initializeDatabase, getDb } = require('../database');
const { createApp } = require('../server');
const { request, listen } = require('./http');
const { generateToken } = require('../auth');
let server, token, warehouse, other;
const send = (method, url, body, as = token, headers = {}) =>
    request(server, { method, path: url, body, token: as, headers });
const post = (url, body, as = token, headers = {}) =>
    send('POST', url, body, as, headers);
async function product(options = {}) {
    const response = await post('/api/products', {
        name: randomUUID(),
        warehouse_id: warehouse,
        unit_price: 10,
        units_per_carton: 12,
        cartons: 10,
        ...options
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.id;
}
async function sale(items, extra = {}, headers = {}) {
    return post(
        '/api/sales',
        { warehouse_id: warehouse, items, ...extra },
        token,
        headers
    );
}
const stock = (id) =>
    getDb()
        .prepare(
            'SELECT unit_stock FROM product_stock WHERE product_id=? AND warehouse_id=?'
        )
        .get(id, warehouse).unit_stock;
describe('Launch business invariants', { concurrency: 1 }, () => {
    before(async () => {
        initializeDatabase();
        server = await listen(createApp());
        token = (
            await post(
                '/api/auth/login',
                { username: 'admin', password: process.env.ADMIN_PASSWORD },
                null
            )
        ).body.token;
        [warehouse, other] = (await send('GET', '/api/warehouses')).body.map(
            (w) => w.id
        );
    });
    after(async () => {
        await new Promise((resolve) => server.close(resolve));
        getDb().close();
    });

    it('restores exactly the initial stock after duplicate lines, a partial return and cancellation', async () => {
        const id = await product();
        const created = await sale([
            { product_id: id, unit_type: 'unit', quantity: 5 },
            { product_id: id, unit_type: 'unit', quantity: 5 }
        ]);
        const details = await send('GET', '/api/sales/' + created.body.id);
        const returned = await post('/api/returns', {
            sale_id: created.body.id,
            items: [{ sale_item_id: details.body.items[1].id, quantity: 2 }]
        });
        assert.equal(returned.status, 201);
        assert.equal(stock(id), 112);
        const cancelled = await send('DELETE', '/api/sales/' + created.body.id);
        assert.equal(cancelled.status, 200);
        assert.equal(stock(id), 120);
        assert.equal(
            getDb()
                .prepare(
                    'SELECT SUM(quantity) AS q FROM sale_returns WHERE sale_id=?'
                )
                .get(created.body.id).q,
            10
        );
        assert.equal(
            (await send('DELETE', '/api/sales/' + created.body.id)).status,
            400
        );
    });
    it('supports old product-based return requests across all matching sale lines', async () => {
        const id = await product();
        const created = await sale([
            { product_id: id, unit_type: 'unit', quantity: 5 },
            { product_id: id, unit_type: 'unit', quantity: 5 }
        ]);
        const returned = await post('/api/returns', {
            sale_id: created.body.id,
            items: [{ product_id: id, unit_type: 'unit', quantity: 6 }]
        });
        assert.equal(returned.status, 201, JSON.stringify(returned.body));
        assert.equal(stock(id), 116);
    });
    it('allocates order discounts exactly and credits the actual selected line', async () => {
        const id = await product();
        const created = await sale(
            [
                {
                    product_id: id,
                    unit_type: 'unit',
                    quantity: 1,
                    discount: 4,
                    extra: 2
                },
                { product_id: id, unit_type: 'unit', quantity: 1 }
            ],
            { discount: 1 }
        );
        assert.equal(created.body.total, 17);
        const details = (await send('GET', '/api/sales/' + created.body.id))
            .body;
        assert.deepEqual(
            details.items.map((i) => i.net_total_cents),
            [762, 938]
        );
        const returned = await post('/api/returns', {
            sale_id: created.body.id,
            items: [{ sale_item_id: details.items[1].id, quantity: 1 }]
        });
        assert.equal(returned.body.credit_amount, 9.38);
        const metrics = (
            await send('GET', '/api/reports/sales/by-product?limit=500')
        ).body.find((row) => row.id === id);
        assert.equal(metrics.gross_revenue, 17);
        assert.equal(metrics.returns_value, 9.38);
        assert.equal(metrics.total_revenue, 7.62);
    });
    it('credits discounted sales without exceeding the sale amount', async () => {
        const id = await product();
        const created = await sale([
            { product_id: id, unit_type: 'unit', quantity: 1, discount: 4 }
        ]);
        assert.equal(created.body.total, 6);
        const returned = await post('/api/returns', {
            sale_id: created.body.id,
            items: [{ product_id: id, unit_type: 'unit', quantity: 1 }]
        });
        assert.equal(returned.body.credit_amount, 6);
        const metrics = (
            await send('GET', '/api/reports/sales/by-product?limit=500')
        ).body.find((row) => row.id === id);
        assert.equal(metrics.total_revenue, 0);
        assert.equal(metrics.total_quantity_sold, 0);
    });
    it('rounds cumulative partial credits so all pennies are returned exactly once', async () => {
        const id = await product({ unit_price: 0.01 });
        const created = await sale(
            [{ product_id: id, unit_type: 'unit', quantity: 3 }],
            { discount: 0.01 }
        );
        const credits = [];
        for (let n = 0; n < 3; n++)
            credits.push(
                (
                    await post('/api/returns', {
                        sale_id: created.body.id,
                        items: [
                            { product_id: id, unit_type: 'unit', quantity: 1 }
                        ]
                    })
                ).body.credit_amount
            );
        assert.deepEqual(credits, [0, 0.01, 0.01]);
        assert.equal(stock(id), 120);
        assert.equal(
            (
                await post('/api/returns', {
                    sale_id: created.body.id,
                    items: [{ product_id: id, unit_type: 'unit', quantity: 1 }]
                })
            ).status,
            400
        );
    });
    it('a refund after a partial return credits and restores only the remainder', async () => {
        const id = await product();
        const created = await sale([
            { product_id: id, unit_type: 'carton', quantity: 2 }
        ]);
        await post('/api/returns', {
            sale_id: created.body.id,
            items: [{ product_id: id, unit_type: 'carton', quantity: 1 }]
        });
        const refunded = await send(
            'PUT',
            `/api/sales/${created.body.id}/payment-status`,
            { payment_status: 'refunded' }
        );
        assert.equal(refunded.status, 200);
        assert.equal(stock(id), 120);
        assert.equal(
            getDb()
                .prepare(
                    'SELECT SUM(amount_cents) AS n FROM sale_returns WHERE sale_id=?'
                )
                .get(created.body.id).n,
            24000
        );
        assert.equal(
            (
                await send('GET', '/api/reports/sales/by-product?limit=500')
            ).body.find((row) => row.id === id).total_revenue,
            0
        );
    });
    it('five distinct staff users cannot oversell the last three units', async () => {
        const id = await product({ cartons: 0, loose_units: 3 });
        const db = getDb();
        const hash = db
            .prepare("SELECT password_hash FROM users WHERE username='admin'")
            .get().password_hash;
        const tokens = Array.from({ length: 5 }, (_, index) => {
            const user = {
                id: randomUUID(),
                username: 'concurrent-' + index,
                token_version: 0
            };
            db.prepare(
                "INSERT INTO users(id,username,email,password_hash,role) VALUES(?,?,?,?,'user')"
            ).run(
                user.id,
                user.username,
                user.username + '@test.invalid',
                hash
            );
            return generateToken(user);
        });
        const responses = await Promise.all(
            tokens.map((as) =>
                post(
                    '/api/sales',
                    {
                        warehouse_id: warehouse,
                        items: [
                            { product_id: id, unit_type: 'unit', quantity: 1 }
                        ]
                    },
                    as
                )
            )
        );
        assert.equal(responses.filter((r) => r.status === 201).length, 3);
        assert.equal(responses.filter((r) => r.status === 400).length, 2);
        assert.equal(stock(id), 0);
    });
    it('five simultaneous retries create one sale and one stock deduction', async () => {
        const id = await product();
        const headers = { 'Idempotency-Key': randomUUID() };
        const responses = await Promise.all(
            Array.from({ length: 5 }, () =>
                sale(
                    [{ product_id: id, unit_type: 'unit', quantity: 2 }],
                    {},
                    headers
                )
            )
        );
        assert.equal(new Set(responses.map((r) => r.body.id)).size, 1);
        assert.equal(responses.filter((r) => r.status === 201).length, 1);
        assert.equal(responses.filter((r) => r.status === 200).length, 4);
        assert.equal(stock(id), 118);
        assert.equal(
            (
                await sale(
                    [{ product_id: id, unit_type: 'unit', quantity: 3 }],
                    {},
                    headers
                )
            ).status,
            409
        );
        assert.equal(stock(id), 118);
    });
    it('a failed duplicate-line sale rolls all stock and records back', async () => {
        const id = await product({ cartons: 0, loose_units: 9 });
        const created = await sale([
            { product_id: id, unit_type: 'unit', quantity: 5 },
            { product_id: id, unit_type: 'unit', quantity: 5 }
        ]);
        assert.equal(created.status, 400);
        assert.equal(stock(id), 9);
        assert.equal(
            getDb()
                .prepare(
                    'SELECT COUNT(*) AS n FROM sale_items WHERE product_id=?'
                )
                .get(id).n,
            0
        );
    });
    it('changing carton size recalculates automatic pricing and preserves explicit pricing', async () => {
        const automatic = await product();
        await send('PUT', '/api/products/' + automatic, {
            units_per_carton: 6
        });
        assert.equal(
            (
                await sale([
                    { product_id: automatic, unit_type: 'carton', quantity: 1 }
                ])
            ).body.total,
            60
        );
        const manual = await product({ carton_price: 99 });
        await send('PUT', '/api/products/' + manual, { units_per_carton: 6 });
        assert.equal(
            (
                await sale([
                    { product_id: manual, unit_type: 'carton', quantity: 1 }
                ])
            ).body.total,
            99
        );
    });
    it('enforces first-login password changes on the server and exposes permissions', async () => {
        const created = await post('/api/auth/register', {
            username: 'first-login',
            email: 'first@test.invalid',
            password: 'FirstLoginPass12',
            permissions: ['manage_returns']
        });
        assert.equal(created.status, 201);
        const login = (
            await post(
                '/api/auth/login',
                { username: 'first-login', password: 'FirstLoginPass12' },
                null
            )
        ).body;
        assert.deepEqual(login.user.permissions, ['manage_returns']);
        assert.equal(
            (await send('GET', '/api/auth/me', undefined, login.token)).body
                .must_change_password,
            1
        );
        const denied = await send(
            'GET',
            '/api/products',
            undefined,
            login.token
        );
        assert.equal(denied.status, 403);
        assert.equal(denied.body.code, 'PASSWORD_CHANGE_REQUIRED');
        const changed = await send(
            'PUT',
            '/api/auth/change-password',
            {
                current_password: 'FirstLoginPass12',
                new_password: 'ChangedFirstPass12'
            },
            login.token
        );
        assert.equal(changed.status, 200);
        assert.equal(
            (await send('GET', '/api/products', undefined, login.token)).status,
            401
        );
        const fresh = (
            await post(
                '/api/auth/login',
                { username: 'first-login', password: 'ChangedFirstPass12' },
                null
            )
        ).body.token;
        assert.equal(
            (await send('GET', '/api/products', undefined, fresh)).status,
            200
        );
    });
    it('validates a complete settings group before saving any field and audits successful saves', async () => {
        const before = (await send('GET', '/api/settings/company_name')).body
            .value;
        const failed = await send('PUT', '/api/settings', {
            values: {
                company_name: 'Must not persist',
                company_email: 'invalid'
            }
        });
        assert.equal(failed.status, 400);
        assert.equal(
            (await send('GET', '/api/settings/company_name')).body.value,
            before
        );
        assert.equal(
            (
                await send('PUT', '/api/settings', {
                    values: {
                        company_name: 'Launch Test Company',
                        low_stock_threshold_default: 0
                    }
                })
            ).status,
            200
        );
        assert.ok(
            getDb()
                .prepare(
                    "SELECT 1 FROM audit_logs WHERE action='settings.update'"
                )
                .get()
        );
    });
    it('paginates stable sales and finds an old sale by receipt ID', async () => {
        const id = await product();
        let first;
        for (let n = 0; n < 55; n++) {
            const response = await sale([
                { product_id: id, unit_type: 'unit', quantity: 1 }
            ]);
            first ||= response.body.id;
        }
        const one = (await send('GET', '/api/sales?limit=50&offset=0')).body;
        const two = (await send('GET', '/api/sales?limit=50&offset=50')).body;
        assert.equal(one.length, 50);
        assert.ok(two.length);
        assert.equal(
            one.some((a) => two.some((b) => a.id === b.id)),
            false
        );
        assert.equal(
            (await send('GET', '/api/sales?search=' + first.slice(0, 8)))
                .body[0].id,
            first
        );
    });
    it('normalizes carton quantities separately from 20L container quantities', async () => {
        const id = await product({ liter20_stock: 10, liter20_price: 40 });
        await sale([
            { product_id: id, unit_type: 'carton', quantity: 1 },
            { product_id: id, unit_type: 'unit', quantity: 2 },
            { product_id: id, unit_type: 'liter20', quantity: 3 }
        ]);
        const metrics = (
            await send('GET', '/api/reports/sales/by-product?limit=500')
        ).body.find((row) => row.id === id);
        assert.equal(metrics.total_quantity_sold, 14);
        assert.equal(metrics.total_liter20_sold, 3);
    });
    it('exports a valid spreadsheet after dependency hardening', async () => {
        const ExcelJS = require('exceljs');
        const response = await fetch(
            `http://127.0.0.1:${server.address().port}/api/products/stock/export?format=excel`,
            { headers: { Authorization: 'Bearer ' + token } }
        );
        assert.equal(response.status, 200);
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
        assert.equal(workbook.worksheets.length, 2);
        assert.equal(workbook.worksheets[0].getCell('A1').value, 'Product');
    });
});
