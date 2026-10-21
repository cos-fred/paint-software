const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authenticateToken, requirePermission } = require('../auth');
const { logAudit } = require('../services/audit');
const { checkLowStock } = require('../services/low-stock');
const { stockColumn, toUnits, UNIT_TYPES } = require('../lib/stock');
const { ClientError, sendSafeError } = require('../lib/errors');
const { parsePositiveInteger, parseLimit } = require('../lib/validation');

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
        `).all(parseLimit(limit, 100));
        res.json(rows);
    } catch (err) {
        sendSafeError(res, err, '[transfers]');
    }
});

router.post('/', requirePermission('manage_transfers'), (req, res) => {
    try {
        const { product_id, from_warehouse_id, to_warehouse_id, unit_type, quantity, notes } = req.body;
        if (!product_id || !from_warehouse_id || !to_warehouse_id || !unit_type || !quantity) {
            return res.status(400).json({ error: 'Product, warehouses, unit type, and quantity are required' });
        }
        if (from_warehouse_id === to_warehouse_id) {
            return res.status(400).json({ error: 'Source and destination warehouses must be different' });
        }
        if (!UNIT_TYPES.includes(unit_type)) return res.status(400).json({ error: 'Invalid unit type' });
        const qty = parsePositiveInteger(quantity, 'Quantity');

        const product = db.prepare('SELECT id, units_per_carton FROM products WHERE id = ? AND is_active = 1').get(product_id);
        if (!product) return res.status(400).json({ error: 'Product not found or archived' });
        const sourceWh = db.prepare('SELECT id FROM warehouses WHERE id = ? AND is_active = 1').get(from_warehouse_id);
        if (!sourceWh) return res.status(400).json({ error: 'Source warehouse not found or inactive' });
        const destWh = db.prepare('SELECT id FROM warehouses WHERE id = ? AND is_active = 1').get(to_warehouse_id);
        if (!destWh) return res.status(400).json({ error: 'Destination warehouse not found or inactive' });

        const stockField = stockColumn(unit_type);
        const unitsDelta = toUnits(unit_type, qty, product.units_per_carton);
        const source = db.prepare(`SELECT ${stockField} as stock FROM product_stock WHERE product_id = ? AND warehouse_id = ?`).get(product_id, from_warehouse_id);
        if (!source) return res.status(404).json({ error: 'Product not found in source warehouse' });
        if (source.stock < unitsDelta) return res.status(400).json({ error: 'Insufficient stock in source warehouse' });

        const transferId = uuidv4();
        const transaction = db.transaction(() => {
            const deducted = db.prepare(`UPDATE product_stock SET ${stockField} = ${stockField} - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND warehouse_id = ? AND ${stockField} >= ?`).run(unitsDelta, product_id, from_warehouse_id, unitsDelta);
            if (deducted.changes === 0) throw new ClientError(400, 'Insufficient stock in source warehouse');
            const received = db.prepare(`UPDATE product_stock SET ${stockField} = ${stockField} + ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND warehouse_id = ?`).run(unitsDelta, product_id, to_warehouse_id);
            if (received.changes === 0) throw new ClientError(409, 'Destination stock row not found');

            db.prepare(`INSERT INTO stock_transfers (id, product_id, from_warehouse_id, to_warehouse_id, unit_type, quantity, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(transferId, product_id, from_warehouse_id, to_warehouse_id, unit_type, qty, notes || null, req.user.id);

            const mv = db.prepare(`INSERT INTO stock_movements (id, product_id, warehouse_id, movement_type, unit_type, quantity, reference_id, reference_type, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'transfer', ?, ?)`);
            mv.run(uuidv4(), product_id, from_warehouse_id, 'transfer_out', unit_type, qty, transferId, notes || null, req.user.id);
            mv.run(uuidv4(), product_id, to_warehouse_id, 'transfer_in', unit_type, qty, transferId, notes || null, req.user.id);
        });
        transaction();

        checkLowStock(product_id, from_warehouse_id, unit_type, source.stock - unitsDelta, source.stock);

        logAudit(req.user.id, 'stock.transfer', 'product', product_id, { from_warehouse_id, to_warehouse_id, unit_type, quantity: qty });
        res.status(201).json({ id: transferId, message: 'Stock transferred successfully' });
    } catch (err) {
        sendSafeError(res, err, '[transfers]');
    }
});

module.exports = router;