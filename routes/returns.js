const express = require('express');
const { getDb } = require('../database');
const { authenticateToken, requirePermission } = require('../auth');
const { logAudit } = require('../services/audit');
const { returnableItems, creditItem } = require('../services/sale-returns');
const { publishStockChanges } = require('../services/low-stock');
const { executeOnce } = require('../services/idempotency');
const { ClientError, sendSafeError } = require('../lib/errors');
const {
    parsePositiveInteger,
    parseLimit,
    parseOffset
} = require('../lib/validation');
const router = express.Router();
const db = getDb();
router.use(authenticateToken);

router.get('/', (req, res) => {
    try {
        let query = `SELECT sr.*,p.name AS product_name,u.username AS created_by_name FROM sale_returns sr JOIN products p ON p.id=sr.product_id LEFT JOIN users u ON u.id=sr.created_by WHERE 1=1`;
        const params = [];
        if (req.query.sale_id) {
            query += ' AND sr.sale_id=?';
            params.push(req.query.sale_id);
        }
        if (req.query.warehouse_id) {
            query += ' AND sr.warehouse_id=?';
            params.push(req.query.warehouse_id);
        }
        if (req.query.search) {
            query +=
                ' AND (p.name LIKE ? OR sr.sale_id LIKE ? OR sr.reason LIKE ?)';
            params.push(
                ...Array(3).fill(`%${String(req.query.search).slice(0, 200)}%`)
            );
        }
        query += ' ORDER BY sr.created_at DESC,sr.rowid DESC LIMIT ? OFFSET ?';
        params.push(
            parseLimit(req.query.limit, 50),
            parseOffset(req.query.offset)
        );
        res.json(db.prepare(query).all(...params));
    } catch (err) {
        sendSafeError(res, err, '[returns]');
    }
});

router.post('/', requirePermission('manage_returns'), (req, res) => {
    try {
        const stockChanges = new Map();
        const result = executeOnce(req, 'sale.return', () => {
            const { sale_id, items, reason } = req.body;
            if (!Array.isArray(items) || !items.length || items.length > 200)
                throw new ClientError(
                    400,
                    'Sale and at least one item are required'
                );
            if (
                reason != null &&
                (typeof reason !== 'string' || reason.length > 2000)
            )
                throw new ClientError(400, 'Invalid return reason');
            const sale = db
                .prepare('SELECT * FROM sales WHERE id=?')
                .get(sale_id);
            if (!sale) throw new ClientError(404, 'Sale not found');
            if (['cancelled', 'refunded'].includes(sale.payment_status))
                throw new ClientError(
                    400,
                    'Cannot return items on a cancelled or refunded sale'
                );
            const lines = returnableItems(sale_id);
            let credit = 0;
            for (const item of items) {
                let remaining = parsePositiveInteger(item && item.quantity);
                const candidates = lines.filter((line) =>
                    item.sale_item_id
                        ? line.id === item.sale_item_id
                        : line.product_id === item.product_id &&
                          line.unit_type === item.unit_type
                );
                if (!candidates.length)
                    throw new ClientError(
                        400,
                        'Returned item not found in original sale'
                    );
                if (
                    remaining >
                    candidates.reduce(
                        (n, line) => n + line.remaining_quantity,
                        0
                    )
                )
                    throw new ClientError(
                        400,
                        'Return quantity exceeds the remaining returnable quantity for this item'
                    );
                for (const line of candidates) {
                    const quantity = Math.min(
                        remaining,
                        line.remaining_quantity
                    );
                    if (quantity > 0)
                        credit += creditItem(
                            line,
                            quantity,
                            req.user.id,
                            reason,
                            'return',
                            stockChanges
                        );
                    remaining -= quantity;
                    if (!remaining) break;
                }
            }
            logAudit(req.user.id, 'sale.return', 'sale', sale_id, {
                reason,
                credit: credit / 100
            });
            return {
                message: 'Return processed and stock restored',
                credit_amount: credit / 100
            };
        });
        if (!result.replay) publishStockChanges(stockChanges);
        res.status(result.replay ? 200 : 201).json(result.body);
    } catch (err) {
        sendSafeError(res, err, '[returns]');
    }
});
module.exports = router;
