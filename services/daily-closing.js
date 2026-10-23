const { randomUUID, createHash } = require('node:crypto');
const { getDb } = require('../database');
const { ClientError } = require('../lib/errors');
const money = require('../lib/money');
const { validDate, METHODS } = require('./payments');
const { logAudit } = require('./audit');
const TIMEZONE = 'Africa/Accra';
function report(date, warehouseId) {
    validDate(date, 'Business date');
    if (!date) throw new ClientError(400, 'Select a business date');
    const db = getDb(),
        warehouse = db
            .prepare('SELECT id,name FROM warehouses WHERE id=?')
            .get(warehouseId);
    if (!warehouse) throw new ClientError(400, 'Select a warehouse');
    // Ghana time is UTC throughout the year. Use an exclusive next-day bound.
    const start = date + ' 00:00:00',
        end =
            new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10) +
            ' 00:00:00';
    const payments = db
        .prepare(
            `SELECT sp.*,s.customer_id,c.name AS customer_name,u.username AS recorded_by FROM sale_payments sp
        JOIN sales s ON s.id=sp.sale_id LEFT JOIN customers c ON c.id=s.customer_id LEFT JOIN users u ON u.id=sp.created_by
        WHERE s.warehouse_id=? AND sp.received_at>=? AND sp.received_at<? ORDER BY sp.received_at,sp.id`
        )
        .all(warehouseId, start, end);
    const sales = db
        .prepare(
            'SELECT id,total FROM sales WHERE warehouse_id=? AND sale_date>=? AND sale_date<? ORDER BY id'
        )
        .all(warehouseId, start, end);
    const credits = db
        .prepare(
            'SELECT id,amount_cents,kind FROM sale_returns WHERE warehouse_id=? AND created_at>=? AND created_at<? ORDER BY id'
        )
        .all(warehouseId, start, end);
    const methods = METHODS.map((method) => {
        const rows = payments.filter((p) => p.method === method),
            received = rows
                .filter((p) => p.kind === 'payment')
                .reduce((n, p) => n + p.amount_cents, 0),
            refunded = rows
                .filter((p) => p.kind === 'refund')
                .reduce((n, p) => n + p.amount_cents, 0);
        return {
            method,
            received_cents: received,
            refunded_cents: refunded,
            net_cents: received - refunded,
            entry_count: rows.length
        };
    });
    const signature = createHash('sha256')
        .update(
            JSON.stringify({
                sales,
                credits,
                payments: payments.map((p) => [
                    p.id,
                    p.kind,
                    p.amount_cents,
                    p.method,
                    p.received_at
                ])
            })
        )
        .digest('hex');
    const closing = db
        .prepare(
            'SELECT dc.*,u.username AS closed_by_name FROM daily_closings dc LEFT JOIN users u ON u.id=dc.closed_by WHERE business_date=? AND warehouse_id=?'
        )
        .get(date, warehouseId);
    const previous = db
        .prepare(
            'SELECT counted_cash_cents FROM daily_closings WHERE warehouse_id=? AND business_date<? ORDER BY business_date DESC LIMIT 1'
        )
        .get(warehouseId, date);
    const gross = sales.reduce((n, s) => n + Math.round(s.total * 100), 0),
        creditTotal = credits.reduce((n, c) => n + c.amount_cents, 0);
    return {
        business_date: date,
        timezone: TIMEZONE,
        warehouse,
        signature,
        sale_count: sales.length,
        gross_sales_cents: gross,
        credits_cents: creditTotal,
        net_sales_cents: gross - creditTotal,
        methods,
        payments,
        imported_entry_count: payments.filter((p) => p.origin === 'legacy')
            .length,
        opening_cash_suggestion_cents: previous?.counted_cash_cents || 0,
        closing: closing
            ? {
                  ...closing,
                  snapshot: JSON.parse(closing.snapshot_json),
                  stale:
                      JSON.parse(closing.snapshot_json).signature !== signature
              }
            : null
    };
}
function close(req) {
    const db = getDb();
    return db
        .transaction(() => {
            const data = report(req.body.business_date, req.body.warehouse_id);
            if (data.business_date > new Date().toISOString().slice(0, 10))
                throw new ClientError(400, 'Cannot close a future day');
            if (req.body.signature !== data.signature)
                throw new ClientError(
                    409,
                    'Transactions changed. Reload the report and check the cash count.'
                );
            const existing = data.closing;
            if (req.body.revision !== (existing?.revision || 0))
                throw new ClientError(
                    409,
                    'This closing was changed by another user. Reload it.'
                );
            const opening = money.cents(req.body.opening_cash, 'Opening cash'),
                added = money.cents(req.body.cash_added ?? 0, 'Cash added'),
                removed = money.cents(
                    req.body.cash_removed ?? 0,
                    'Cash removed'
                ),
                counted = money.cents(req.body.counted_cash, 'Counted cash');
            const expected =
                opening +
                added -
                removed +
                data.methods.find((m) => m.method === 'cash').net_cents;
            if (!Number.isSafeInteger(expected) || expected < 0)
                throw new ClientError(
                    400,
                    'Cash removed or refunded exceeds the available cash. Check the opening cash and cash movements.'
                );
            const difference = counted - expected,
                notes = req.body.notes ?? '';
            if (typeof notes !== 'string' || notes.length > 2000)
                throw new ClientError(400, 'Invalid closing notes');
            if (
                (difference !== 0 || added || removed || existing) &&
                !notes.trim()
            )
                throw new ClientError(
                    400,
                    'Explain cash differences, cash movements or changes to a previous closing in the notes'
                );
            const id = existing?.id || randomUUID(),
                revision = (existing?.revision || 0) + 1;
            const snapshot = { ...data, closing: null };
            db.prepare(
                `INSERT INTO daily_closings(id,business_date,warehouse_id,revision,snapshot_json,opening_cash_cents,cash_added_cents,cash_removed_cents,counted_cash_cents,expected_cash_cents,difference_cents,notes,closed_by)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(business_date,warehouse_id) DO UPDATE SET revision=excluded.revision,snapshot_json=excluded.snapshot_json,
            opening_cash_cents=excluded.opening_cash_cents,cash_added_cents=excluded.cash_added_cents,cash_removed_cents=excluded.cash_removed_cents,counted_cash_cents=excluded.counted_cash_cents,
            expected_cash_cents=excluded.expected_cash_cents,difference_cents=excluded.difference_cents,notes=excluded.notes,closed_by=excluded.closed_by,closed_at=CURRENT_TIMESTAMP`
            ).run(
                id,
                data.business_date,
                data.warehouse.id,
                revision,
                JSON.stringify(snapshot),
                opening,
                added,
                removed,
                counted,
                expected,
                difference,
                notes.trim(),
                req.user.id
            );
            const saved = db
                .prepare('SELECT * FROM daily_closings WHERE id=?')
                .get(id);
            db.prepare(
                'INSERT INTO daily_closing_revisions(closing_id,revision,record_json,created_by) VALUES(?,?,?,?)'
            ).run(id, revision, JSON.stringify(saved), req.user.id);
            logAudit(
                req.user.id,
                existing ? 'closing.amend' : 'closing.save',
                'daily_closing',
                id,
                {
                    business_date: data.business_date,
                    warehouse_id: data.warehouse.id,
                    difference_cents: difference,
                    revision
                }
            );
            return report(data.business_date, data.warehouse.id);
        })
        .immediate();
}
module.exports = { report, close, TIMEZONE };
