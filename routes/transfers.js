const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authenticateToken, requireAdmin } = require('../auth');
const { logAudit } = require('../services/audit');
const { stockColumn } = require('../lib/stock');
const { ClientError, sendSafeError } = require('../lib/errors');

const router = express.Router();
const db = getDb();

router.use(authenticateToken);

router.get('/', (req, res) => {
    try {
        const { limit = 100 } = req.query;
        const rows = db.prepare(`
            SELECT st.*, p.name as product_name, u.username as created_by_name,
                fw.name as from_warehouse_name, tw.name as to_warehouse_name
            FROM stock_transfers st
            JOIN products p ON st.product_id = p.id
            JOIN warehouses fw ON st.from_warehouse_id = fw.id
            JOIN warehouses tw ON st.to_warehouse_id = tw.id
            LEFT JOIN users u ON st.created_by = u.id
            ORDER BY st.created_at DESC LIMIT ?
        `).all(parseInt(limit));
        res.json(rows);
    } catch (err) {
        sendSafeError(res, err, '[transfers]');
    }
});

router.post('/', requireAdmin, (req, res) => {
    try {
        const { product_id, from_warehouse_id, to_warehouse_id, unit_type, quantity, notes } = req.body;
        if (!product_id || !from_warehouse_id || !to_warehouse_id || !unit_type || !quantity) {
            return res.status(400).json({ error: 'Product, warehouses, unit type, and quantity are required' });
        }
        if (from_warehouse_id === to_warehouse_id) {
            return res.status(400).json({ error: 'Source and destination warehouses must be different' });
        }
        if (!['carton', 'liter20'].includes(unit_type)) return res.status(400).json({ error: 'Invalid unit type' });
        if (quantity <= 0) return res.status(400).json({ error: 'Quantity must be positive' });

        const stockField = stockColumn(unit_type);
        const source = db.prepare(`SELECT ${stockField} as stock FROM product_stock WHERE product_id = ? AND warehouse_id = ?`).get(product_id, from_warehouse_id);
        if (!source) return res.status(404).json({ error: 'Product not found in source warehouse' });
        if (source.stock < quantity) return res.status(400).json({ error: 'Insufficient stock in source warehouse' });

        const transferId = uuidv4();
        const transaction = db.transaction(() => {
            const deducted = db.prepare(`UPDATE product_stock SET ${stockField} = ${stockField} - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND warehouse_id = ? AND ${stockField} >= ?`).run(quantity, product_id, from_warehouse_id, quantity);
            if (deducted.changes === 0) throw new ClientError(400, 'Insufficient stock in source warehouse');
            db.prepare(`UPDATE product_stock SET ${stockField} = ${stockField} + ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND warehouse_id = ?`).run(quantity, product_id, to_warehouse_id);

            db.prepare(`INSERT INTO stock_transfers (id, product_id, from_warehouse_id, to_warehouse_id, unit_type, quantity, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(transferId, product_id, from_warehouse_id, to_warehouse_id, unit_type, quantity, notes || null, req.user.id);

            const mv = db.prepare(`INSERT INTO stock_movements (id, product_id, warehouse_id, movement_type, unit_type, quantity, reference_id, reference_type, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'transfer', ?, ?)`);
            mv.run(uuidv4(), product_id, from_warehouse_id, 'transfer_out', unit_type, quantity, transferId, notes || null, req.user.id);
            mv.run(uuidv4(), product_id, to_warehouse_id, 'transfer_in', unit_type, quantity, transferId, notes || null, req.user.id);
        });
        transaction();

        logAudit(req.user.id, 'stock.transfer', 'product', product_id, { from_warehouse_id, to_warehouse_id, unit_type, quantity });
        res.status(201).json({ id: transferId, message: 'Stock transferred successfully' });
    } catch (err) {
        sendSafeError(res, err, '[transfers]');
    }
});

module.exports = router;