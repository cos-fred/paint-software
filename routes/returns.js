const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authenticateToken, requirePermission } = require('../auth');
const { logAudit } = require('../services/audit');
const { stockColumn, UNIT_TYPES } = require('../lib/stock');
const { ClientError, sendSafeError } = require('../lib/errors');

const router = express.Router();
const db = getDb();

router.use(authenticateToken);

router.get('/', (req, res) => {
    try {
        const { sale_id, limit = 100 } = req.query;
        let query = `SELECT sr.*, p.name as product_name, u.username as created_by_name
            FROM sale_returns sr JOIN products p ON sr.product_id = p.id LEFT JOIN users u ON sr.created_by = u.id`;
        const params = [];
        if (sale_id) { query += ' WHERE sr.sale_id = ?'; params.push(sale_id); }
        query += ' ORDER BY sr.created_at DESC LIMIT ?';
        params.push(parseInt(limit));
        res.json(db.prepare(query).all(...params));
    } catch (err) {
        sendSafeError(res, err, '[returns]');
    }
});

// Partial/full return of sale items — restores stock
router.post('/', requirePermission('manage_returns'), (req, res) => {
    try {
        const { sale_id, items, reason } = req.body;
        if (!sale_id || !items || items.length === 0) return res.status(400).json({ error: 'Sale and at least one item are required' });

        const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(sale_id);
        if (!sale) return res.status(404).json({ error: 'Sale not found' });
        if (sale.payment_status === 'cancelled' || sale.payment_status === 'refunded') {
            return res.status(400).json({ error: 'Cannot return items on a cancelled or refunded sale' });
        }

        const transaction = db.transaction(() => {
            const summed = new Map();
            for (const item of items) {
                const product_id = item.product_id;
                const unit_type = item.unit_type;
                const quantity = Number(item.quantity);

                if (!product_id || !unit_type || !Number.isInteger(quantity) || quantity <= 0) {
                    throw new ClientError(400, 'Invalid return item');
                }
                if (!UNIT_TYPES.includes(unit_type)) throw new ClientError(400, 'Invalid unit type');

                const key = `${product_id}:${unit_type}`;
                summed.set(key, (summed.get(key) || 0) + quantity);
            }

            for (const [key, quantity] of summed.entries()) {
                const [product_id, unit_type] = key.split(':');

                const original = db.prepare('SELECT * FROM sale_items WHERE sale_id = ? AND product_id = ? AND unit_type = ?').get(sale_id, product_id, unit_type);
                if (!original) throw new ClientError(400, 'Returned item not found in original sale');

                const alreadyReturned = db.prepare('SELECT COALESCE(SUM(quantity), 0) as q FROM sale_returns WHERE sale_id = ? AND product_id = ? AND unit_type = ?').get(sale_id, product_id, unit_type).q;
                if (alreadyReturned + quantity > original.quantity) {
                    throw new ClientError(400, 'Return quantity exceeds the remaining returnable quantity for this item');
                }

                const unitPrice = original.unit_price;
                const lineTotal = quantity * unitPrice;

                const returnId = uuidv4();
                db.prepare(`INSERT INTO sale_returns (id, sale_id, product_id, warehouse_id, unit_type, quantity, unit_price, line_total, reason, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(returnId, sale_id, product_id, sale.warehouse_id, unit_type, quantity, unitPrice, lineTotal, reason || null, req.user.id);

                const stockField = stockColumn(unit_type);
                db.prepare(`UPDATE product_stock SET ${stockField} = ${stockField} + ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND warehouse_id = ?`).run(quantity, product_id, sale.warehouse_id);

                db.prepare(`INSERT INTO stock_movements (id, product_id, warehouse_id, movement_type, unit_type, quantity, reference_id, reference_type, notes, created_by) VALUES (?, ?, ?, 'return_in', ?, ?, ?, 'return', ?, ?)`)
                    .run(uuidv4(), product_id, sale.warehouse_id, unit_type, quantity, returnId, reason || null, req.user.id);
            }
        });
        transaction();

        logAudit(req.user.id, 'sale.return', 'sale', sale_id, { reason, items });
        res.status(201).json({ message: 'Return processed and stock restored' });
    } catch (err) {
        sendSafeError(res, err, '[returns]');
    }
});

module.exports = router;