const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path');
const { randomUUID } = require('node:crypto');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-business-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(temporary, 'app.db');
process.env.JWT_SECRET = 'b'.repeat(48);
process.env.ADMIN_PASSWORD = 'BusinessAdminPass22';
const { before, after, it } = require('node:test');
const assert = require('node:assert/strict');
const { initializeDatabase, getDb } = require('../database');
const { createApp } = require('../server');
const { generateToken } = require('../auth');
const { listen, request } = require('./http');
let server, token, staffToken, warehouses;
const send = (method, url, body, as = token, headers = {}) =>
    request(server, { method, path: url, body, token: as, headers });
async function ok(method, url, body, as = token, headers = {}) {
    const result = await send(method, url, body, as, headers);
    assert.ok(
        result.status >= 200 && result.status < 300,
        JSON.stringify(result)
    );
    return result.body;
}
async function customer() {
    return (
        await ok('POST', '/api/customers', {
            name: 'Business ' + randomUUID(),
            phone: '0240000000'
        })
    ).id;
}
async function product(extra = {}) {
    return (
        await ok('POST', '/api/products', {
            name: 'Paint ' + randomUUID(),
            warehouse_id: warehouses[0].id,
            unit_price: 10,
            units_per_carton: 10,
            cartons: 10,
            liter20_price: 20,
            liter20_stock: 3,
            ...extra
        })
    ).id;
}
async function sale(id, extra = {}) {
    return (
        await ok('POST', '/api/sales', {
            warehouse_id: warehouses[0].id,
            items: [{ product_id: id, unit_type: 'unit', quantity: 10 }],
            ...extra
        })
    ).id;
}
before(async () => {
    initializeDatabase();
    server = await listen(createApp());
    token = (
        await ok(
            'POST',
            '/api/auth/login',
            { username: 'admin', password: process.env.ADMIN_PASSWORD },
            null
        )
    ).token;
    warehouses = await ok('GET', '/api/warehouses');
    const staff = { id: randomUUID(), username: 'counter', token_version: 0 };
    getDb()
        .prepare(
            "INSERT INTO users(id,username,email,password_hash,role,permissions) VALUES(?,?,'counter@example.invalid','unused','user',?)"
        )
        .run(
            staff.id,
            staff.username,
            JSON.stringify(['manage_products', 'manage_returns'])
        );
    staffToken = generateToken(staff);
});
after(async () => {
    await new Promise((resolve) => server.close(resolve));
    getDb().close();
});

it('tracks deposits, overdue statements, concurrent collections and idempotent retries', async () => {
    const person = await customer(),
        id = await product(),
        yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const invoice = await sale(id, {
        customer_id: person,
        amount_paid: 30,
        due_date: yesterday
    });
    let details = await ok('GET', '/api/sales/' + invoice);
    assert.equal(details.payment_state, 'part_paid');
    assert.equal(details.balance_due, 70);
    assert.equal(
        (await ok('GET', '/api/customers?search=Business')).find(
            (c) => c.id === person
        ).overdue_balance,
        70
    );
    assert.equal(
        (await send('DELETE', '/api/customers/' + person)).status,
        409
    );
    const headers = { 'Idempotency-Key': 'business-payment-once-12345' };
    const body = { amount: 20, method: 'momo' };
    await ok('POST', `/api/sales/${invoice}/payments`, body, token, headers);
    const replay = await send(
        'POST',
        `/api/sales/${invoice}/payments`,
        body,
        token,
        headers
    );
    assert.equal(replay.status, 200);
    const attempts = await Promise.all(
        Array.from({ length: 5 }, () =>
            send('POST', `/api/sales/${invoice}/payments`, {
                amount: 20,
                method: 'cash'
            })
        )
    );
    assert.equal(attempts.filter((r) => r.status === 201).length, 2);
    assert.equal(attempts.filter((r) => r.status === 409).length, 3);
    const statement = await ok('GET', `/api/customers/${person}/statement`);
    assert.equal(statement.summary.balance_due, 10);
    await ok('POST', `/api/sales/${invoice}/payments`, {
        amount: 10,
        method: 'card'
    });
    details = await ok('GET', '/api/sales/' + invoice);
    assert.equal(details.payment_status, 'completed');
    assert.equal(details.balance_due, 0);
    assert.equal(
        getDb()
            .prepare(
                'SELECT unit_stock FROM product_stock WHERE product_id=? AND warehouse_id=?'
            )
            .get(id, warehouses[0].id).unit_stock,
        90
    );
    assert.equal(
        (await ok('GET', `/api/sales/${invoice}/payments`)).payments.length,
        5
    );
});

it('requires a named customer for new credit sales and rejects overpayments', async () => {
    const id = await product();
    assert.equal(
        (
            await send('POST', '/api/sales', {
                warehouse_id: warehouses[0].id,
                items: [{ product_id: id, unit_type: 'unit', quantity: 1 }],
                amount_paid: 0
            })
        ).status,
        400
    );
    assert.equal(
        (
            await send('POST', '/api/sales', {
                warehouse_id: warehouses[0].id,
                items: [{ product_id: id, unit_type: 'unit', quantity: 1 }],
                amount_paid: 11
            })
        ).status,
        400
    );
    assert.equal(
        (
            await send('POST', '/api/sales', {
                warehouse_id: warehouses[0].id,
                items: [{ product_id: id, unit_type: 'unit', quantity: 1 }],
                amount_paid: 10,
                due_date: '2026-02-30'
            })
        ).status,
        400
    );
});

it('credits unpaid balances before calculating cash refunds and never pays a refund twice', async () => {
    const id = await product(),
        person = await customer(),
        invoice = await sale(id, { customer_id: person, amount_paid: 30 });
    const details = await ok('GET', '/api/sales/' + invoice),
        line = details.items[0].id;
    await ok('POST', '/api/returns', {
        sale_id: invoice,
        items: [{ sale_item_id: line, quantity: 4 }]
    });
    assert.equal(
        (await ok('GET', `/api/sales/${invoice}/payments`)).account.balance_due,
        30
    );
    await ok('POST', '/api/returns', {
        sale_id: invoice,
        items: [{ sale_item_id: line, quantity: 5 }]
    });
    let ledger = await ok('GET', `/api/sales/${invoice}/payments`);
    assert.equal(ledger.account.refund_due, 20);
    assert.equal(ledger.payments.length, 1);
    const headers = { 'Idempotency-Key': 'business-refund-once-12345' },
        body = { kind: 'refund', amount: 20, method: 'cash' };
    await ok(
        'POST',
        `/api/sales/${invoice}/payments`,
        body,
        staffToken,
        headers
    );
    assert.equal(
        (
            await send(
                'POST',
                `/api/sales/${invoice}/payments`,
                body,
                staffToken,
                headers
            )
        ).status,
        200
    );
    assert.equal(
        (
            await send('POST', `/api/sales/${invoice}/payments`, {
                kind: 'refund',
                amount: 1,
                method: 'cash'
            })
        ).status,
        409
    );
    await ok('DELETE', '/api/sales/' + invoice);
    ledger = await ok('GET', `/api/sales/${invoice}/payments`);
    assert.equal(ledger.account.refund_due, 10);
    assert.equal(ledger.account.balance_due, 0);
    await ok('POST', `/api/sales/${invoice}/payments`, {
        kind: 'refund',
        amount: 10,
        method: 'transfer'
    });
    assert.equal(
        (await ok('GET', `/api/customers/${person}/statement`)).summary
            .refund_due,
        0
    );
    assert.equal(
        getDb()
            .prepare(
                'SELECT unit_stock FROM product_stock WHERE product_id=? AND warehouse_id=?'
            )
            .get(id, warehouses[0].id).unit_stock,
        100
    );
});

async function countSheet(target, delta = 0) {
    const draft = await ok(
        'POST',
        '/api/stocktakes',
        { warehouse_id: warehouses[0].id },
        staffToken
    );
    const items = draft.items.map((i) => ({
        id: i.id,
        counted_units: i.expected_units + (i.product_id === target ? delta : 0),
        counted_liter20: i.expected_liter20
    }));
    return { draft, items };
}
it('stocktake adjustments require complete counts, revision checks and owner approval', async () => {
    const id = await product(),
        { draft, items } = await countSheet(id, -7);
    const before = getDb()
        .prepare(
            'SELECT unit_stock FROM product_stock WHERE product_id=? AND warehouse_id=?'
        )
        .get(id, warehouses[0].id).unit_stock;
    assert.equal(
        (
            await send(
                'POST',
                `/api/stocktakes/${draft.id}/submit`,
                { revision: 0, items: items.slice(1), notes: 'Counted' },
                staffToken
            )
        ).status,
        400
    );
    const submitted = await ok(
        'POST',
        `/api/stocktakes/${draft.id}/submit`,
        { revision: 0, items, notes: 'Seven units damaged or missing' },
        staffToken
    );
    assert.equal(
        getDb()
            .prepare(
                'SELECT unit_stock FROM product_stock WHERE product_id=? AND warehouse_id=?'
            )
            .get(id, warehouses[0].id).unit_stock,
        before
    );
    assert.equal(
        (
            await send(
                'POST',
                `/api/stocktakes/${draft.id}/approve`,
                { revision: submitted.revision },
                staffToken
            )
        ).status,
        403
    );
    const approved = await ok('POST', `/api/stocktakes/${draft.id}/approve`, {
        revision: submitted.revision
    });
    assert.equal(approved.status, 'approved');
    assert.equal(
        getDb()
            .prepare(
                'SELECT unit_stock FROM product_stock WHERE product_id=? AND warehouse_id=?'
            )
            .get(id, warehouses[0].id).unit_stock,
        before - 7
    );
    assert.equal(
        (
            await send('POST', `/api/stocktakes/${draft.id}/approve`, {
                revision: submitted.revision
            })
        ).status,
        409
    );
    assert.equal(
        getDb()
            .prepare(
                "SELECT COUNT(*) AS n FROM stock_movements WHERE reference_type='stock_adjustment' AND reference_id=?"
            )
            .get(draft.id).n,
        1
    );
});

it('stocktakes reject stale inventory and new products, then support a clean recount', async () => {
    const id = await product();
    let { draft, items } = await countSheet(id);
    let row = await ok('POST', `/api/stocktakes/${draft.id}/submit`, {
        revision: 0,
        items
    });
    await sale(id);
    assert.equal(
        (
            await send('POST', `/api/stocktakes/${draft.id}/approve`, {
                revision: row.revision
            })
        ).status,
        409
    );
    row = await ok(
        'POST',
        `/api/stocktakes/${draft.id}/recount`,
        { revision: row.revision },
        staffToken
    );
    assert.ok(row.items.every((i) => i.counted_units === null));
    const fresh = row.items.map((i) => ({
        id: i.id,
        counted_units: i.expected_units,
        counted_liter20: i.expected_liter20
    }));
    row = await ok('POST', `/api/stocktakes/${draft.id}/submit`, {
        revision: row.revision,
        items: fresh
    });
    await product();
    assert.equal(
        (
            await send('POST', `/api/stocktakes/${draft.id}/approve`, {
                revision: row.revision
            })
        ).status,
        409
    );
    await ok('POST', `/api/stocktakes/${draft.id}/cancel`, {
        revision: row.revision
    });
});

it('daily closing uses real collections, protects stale reports and preserves closing history', async () => {
    const db = getDb(),
        today = new Date().toISOString().slice(0, 10),
        person = await customer();
    const id = await product();
    await sale(id, { customer_id: person, amount_paid: 30 });
    const other = await sale(id, {
        items: [{ product_id: id, unit_type: 'unit', quantity: 4 }],
        amount_paid: 40,
        payment_method: 'card'
    });
    const line = (await ok('GET', '/api/sales/' + other)).items[0].id;
    await ok('POST', '/api/returns', {
        sale_id: other,
        items: [{ sale_item_id: line, quantity: 1 }]
    });
    await ok('POST', `/api/sales/${other}/payments`, {
        kind: 'refund',
        amount: 10,
        method: 'cash'
    });
    const url =
        '/api/daily-closing?' +
        new URLSearchParams({ date: today, warehouse_id: warehouses[0].id });
    let report = await ok('GET', url);
    assert.equal(report.timezone, 'Africa/Accra');
    assert.ok(
        report.methods.find((m) => m.method === 'card').received_cents >= 4000
    );
    const expected =
        100 + report.methods.find((m) => m.method === 'cash').net_cents / 100;
    let body = {
        business_date: today,
        warehouse_id: warehouses[0].id,
        signature: report.signature,
        revision: 0,
        opening_cash: 100,
        counted_cash: expected - 1
    };
    assert.equal((await send('POST', '/api/daily-closing', body)).status, 400);
    assert.equal(
        (
            await send(
                'POST',
                '/api/daily-closing',
                { ...body, notes: 'Count variance' },
                staffToken
            )
        ).status,
        403
    );
    report = await ok('POST', '/api/daily-closing', {
        ...body,
        notes: 'Count variance'
    });
    assert.equal(report.closing.difference_cents, -100);
    assert.equal(report.closing.revision, 1);
    await sale(id, {
        items: [{ product_id: id, unit_type: 'unit', quantity: 1 }],
        amount_paid: 10
    });
    assert.equal((await ok('GET', url)).closing.stale, true);
    assert.equal(
        (
            await send('POST', '/api/daily-closing', {
                ...body,
                revision: 1,
                notes: 'Updated count'
            })
        ).status,
        409
    );
    report = await ok('GET', url);
    body = {
        ...body,
        signature: report.signature,
        revision: 1,
        counted_cash:
            100 +
            report.methods.find((m) => m.method === 'cash').net_cents / 100,
        notes: 'Updated count after a late sale'
    };
    report = await ok('POST', '/api/daily-closing', body);
    assert.equal(report.closing.revision, 2);
    assert.equal(report.closing.difference_cents, 0);
    assert.equal(
        (await ok('GET', `/api/daily-closing/${report.closing.id}/history`))
            .length,
        2
    );
    assert.equal((await send('POST', '/api/daily-closing', body)).status, 409);
    const empty = await ok(
        'GET',
        '/api/daily-closing?' +
            new URLSearchParams({ date: today, warehouse_id: warehouses[1].id })
    );
    assert.equal(empty.payments.length, 0);
    assert.equal(empty.closing, null);
    const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const futureReport = await ok(
        'GET',
        '/api/daily-closing?' +
            new URLSearchParams({
                date: future,
                warehouse_id: warehouses[0].id
            })
    );
    assert.equal(
        (
            await send('POST', '/api/daily-closing', {
                ...body,
                business_date: future,
                signature: futureReport.signature,
                revision: 0
            })
        ).status,
        400
    );
    assert.equal(db.pragma('foreign_key_check').length, 0);
});

it('paint details can be saved, searched and cleared without changing stock quantities', async () => {
    const id = await product({
        brand: 'Coastal',
        colour_name: 'Ocean Blue',
        colour_code: 'OC-417',
        finish: 'Satin',
        container_size: '4L'
    });
    const rows = await ok('GET', '/api/products?search=OC-417');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, id);
    assert.equal(rows[0].container_size, '4L');
    await ok('PUT', '/api/products/' + id, { brand: '', finish: 'Matt' });
    const p = await ok('GET', '/api/products/' + id);
    assert.equal(p.brand, '');
    assert.equal(p.colour_code, 'OC-417');
    assert.equal(p.finish, 'Matt');
    assert.equal(
        (
            await send('PUT', '/api/products/' + id, {
                colour_code: { bad: true }
            })
        ).status,
        400
    );
    assert.equal(
        getDb()
            .prepare(
                'SELECT unit_stock FROM product_stock WHERE product_id=? AND warehouse_id=?'
            )
            .get(id, warehouses[0].id).unit_stock,
        100
    );
});

it('daily closing includes Ghana midnight and excludes the next midnight', async () => {
    const id = await product(),
        day = '2026-09-15',
        previous = await sale(id),
        current = await sale(id),
        next = await sale(id);
    const db = getDb();
    for (const [invoice, time] of [
        [previous, '2026-09-14 23:59:59'],
        [current, '2026-09-15 00:00:00'],
        [next, '2026-09-16 00:00:00']
    ])
        db.prepare(
            'UPDATE sale_payments SET received_at=? WHERE sale_id=?'
        ).run(time, invoice);
    const report = await ok(
        'GET',
        '/api/daily-closing?' +
            new URLSearchParams({ date: day, warehouse_id: warehouses[0].id })
    );
    assert.ok(report.payments.some((p) => p.sale_id === current));
    assert.ok(
        !report.payments.some(
            (p) => p.sale_id === previous || p.sale_id === next
        )
    );
});

it('a verified development reset also clears ledgers, count sheets and closing history', async () => {
    const response = await send('POST', '/api/system/reset', {
        password: process.env.ADMIN_PASSWORD
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    for (const table of [
        'sale_payments',
        'stocktakes',
        'stocktake_items',
        'daily_closings',
        'daily_closing_revisions',
        'sales',
        'products'
    ])
        assert.equal(
            getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
            0,
            table
        );
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    assert.equal(getDb().pragma('foreign_key_check').length, 0);
});
