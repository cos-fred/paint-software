const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authenticateToken } = require('../auth');
const { logAudit } = require('../services/audit');

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
        res.status(500).json({ error: err.message });
    }
});

// Partial/full return of sale items — restores stock
router.post('/', (req, res) => {
    try {
        const { sale_id, items, reason } = req.body;
        if (!sale_id || !items || items.length === 0) return res.status(400).json({ error: 'Sale and at least one item are required' });

        const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(sale_id);
        if (!sale) return res.status(404).json({ error: 'Sale not found' });

        const transaction = db.transaction(() => {
            for (const item of items) {
                const { product_id, unit_type, quantity } = item;
                if (!product_id || !unit_type || !quantity || quantity <= 0) throw new Error('Invalid return item');

                // Find the original sale line to get the unit price
                const original = db.prepare('SELECT * FROM sale_items WHERE sale_id = ? AND product_id = ? AND unit_type = ?').get(sale_id, product_id, unit_type);
                if (!original) throw new Error('Returned item not found in original sale');
                if (quantity > original.quantity) throw new Error('Return quantity exceeds original sold quantity');

                const unitPrice = original.unit_price;
                const lineTotal = quantity * unitPrice;

                const returnId = uuidv4();
                db.prepare(`INSERT INTO sale_returns (id, sale_id, product_id, warehouse_id, unit_type, quantity, unit_price, line_total, reason, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(returnId, sale_id, product_id, sale.warehouse_id, unit_type, quantity, unitPrice, lineTotal, reason || null, req.user.id);

                const stockField = `${unit_type}_stock`;
                db.prepare(`UPDATE product_stock SET ${stockField} = ${stockField} + ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND warehouse_id = ?`).run(quantity, product_id, sale.warehouse_id);

                db.prepare(`INSERT INTO stock_movements (id, product_id, warehouse_id, movement_type, unit_type, quantity, reference_id, reference_type, notes, created_by) VALUES (?, ?, ?, 'return_in', ?, ?, ?, 'return', ?, ?)`)
                    .run(uuidv4(), product_id, sale.warehouse_id, unit_type, quantity, returnId, reason || null, req.user.id);
            }
        });
        transaction();

        logAudit(req.user.id, 'sale.return', 'sale', sale_id, { reason, items });
        res.status(201).json({ message: 'Return processed and stock restored' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;