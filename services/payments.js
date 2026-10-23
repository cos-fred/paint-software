const { randomUUID } = require('node:crypto');
const { getDb } = require('../database');
const { ClientError } = require('../lib/errors');
const money = require('../lib/money');
const { executeOnce } = require('./idempotency');
const { logAudit } = require('./audit');
const METHODS = ['cash', 'card', 'transfer', 'momo'];

function validDate(value, label = 'Due date') {
    if (value == null || value === '') return null;
    if (
        typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value
    )
        throw new ClientError(400, `${label} must be a valid date`);
    return value;
}
function account(saleId, db = getDb()) {
    const row = db
        .prepare('SELECT * FROM sale_accounts WHERE id=?')
        .get(saleId);
    if (!row) throw new ClientError(404, 'Sale not found');
    return {
        ...row,
        payment_methods: db
            .prepare(
                "SELECT DISTINCT method FROM sale_payments WHERE sale_id=? AND kind='payment' ORDER BY method"
            )
            .all(saleId)
            .map((p) => p.method),
        net_total: row.net_total_cents / 100,
        paid_amount: row.net_paid_cents / 100,
        received_amount: row.received_cents / 100,
        refunded_amount: row.refunded_cents / 100,
        balance_due: row.balance_due_cents / 100,
        refund_due: row.refund_due_cents / 100,
        payment_state:
            row.refund_due_cents > 0
                ? 'refund_due'
                : row.balance_due_cents === 0
                  ? 'paid'
                  : row.net_paid_cents > 0
                    ? 'part_paid'
                    : 'unpaid'
    };
}
function decorate(sale) {
    const data = account(sale.id);
    return {
        ...sale,
        ...Object.fromEntries(
            [
                'net_total',
                'paid_amount',
                'received_amount',
                'refunded_amount',
                'balance_due',
                'refund_due',
                'payment_state',
                'due_date',
                'payment_methods'
            ].map((k) => [k, data[k]])
        )
    };
}
function refreshPaymentStatus(saleId) {
    const data = account(saleId);
    if (['pending', 'completed'].includes(data.payment_status))
        getDb()
            .prepare('UPDATE sales SET payment_status=? WHERE id=?')
            .run(data.balance_due_cents > 0 ? 'pending' : 'completed', saleId);
}
function initialPayment(db, saleId, amount, method, userId) {
    if (amount > 0)
        db.prepare(
            "INSERT INTO sale_payments(id,sale_id,kind,amount_cents,method,created_by) VALUES(?,?,'payment',?,?,?)"
        ).run(randomUUID(), saleId, amount, method, userId);
}
function recordPayment(req, saleId) {
    return executeOnce(req, `payment.create:${saleId}`, () => {
        const db = getDb(),
            data = account(saleId),
            kind = req.body.kind || 'payment';
        if (!['payment', 'refund'].includes(kind))
            throw new ClientError(400, 'Invalid payment kind');
        if (
            kind === 'refund' &&
            req.user.role !== 'admin' &&
            !(req.user.permissions || []).includes('manage_returns')
        )
            throw new ClientError(
                403,
                'Return permission is required to pay a refund'
            );
        if (
            kind === 'payment' &&
            ['cancelled', 'refunded'].includes(data.payment_status)
        )
            throw new ClientError(
                409,
                'Cannot collect money on a cancelled or refunded sale'
            );
        const amount = money.cents(req.body.amount, 'Payment amount'),
            method = req.body.method || data.payment_method;
        if (!amount)
            throw new ClientError(
                400,
                'Payment amount must be greater than zero'
            );
        if (!METHODS.includes(method))
            throw new ClientError(400, 'Invalid payment method');
        if (
            amount >
            (kind === 'payment'
                ? data.balance_due_cents
                : data.refund_due_cents)
        )
            throw new ClientError(
                409,
                kind === 'payment'
                    ? 'Payment exceeds the outstanding balance'
                    : 'Refund exceeds the amount owed to the customer'
            );
        const reference = req.body.reference ?? '',
            notes = req.body.notes ?? '';
        if (
            typeof reference !== 'string' ||
            reference.length > 120 ||
            typeof notes !== 'string' ||
            notes.length > 1000
        )
            throw new ClientError(400, 'Invalid payment reference or notes');
        const id = randomUUID();
        db.prepare(
            'INSERT INTO sale_payments(id,sale_id,kind,amount_cents,method,reference,notes,created_by) VALUES(?,?,?,?,?,?,?,?)'
        ).run(
            id,
            saleId,
            kind,
            amount,
            method,
            reference.trim(),
            notes.trim(),
            req.user.id
        );
        refreshPaymentStatus(saleId);
        logAudit(req.user.id, `sale.${kind}`, 'sale', saleId, {
            payment_id: id,
            amount: amount / 100,
            method
        });
        return {
            id,
            message:
                kind === 'payment' ? 'Payment recorded' : 'Refund recorded',
            account: account(saleId)
        };
    });
}
module.exports = {
    METHODS,
    validDate,
    account,
    decorate,
    initialPayment,
    refreshPaymentStatus,
    recordPayment
};
