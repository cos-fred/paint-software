const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authenticateToken } = require('../auth');

const router = express.Router();
const db = getDb();

router.use(authenticateToken);

router.get('/', (req, res) => {
    try {
        const { status, warehouse_id, limit = 100, offset = 0 } = req.query;
        let query = 'SELECT po.*, w.name as warehouse_name FROM purchase_orders po LEFT JOIN warehouses w ON po.warehouse_id = w.id WHERE 1=1';
        const params = [];

        if (status) {
            query += ' AND po.status = ?';
            params.push(status);
        }
        if (warehouse_id) {
            query += ' AND po.warehouse_id = ?';
            params.push(warehouse_id);
        }

        query += ' ORDER BY po.order_date DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const rows = db.prepare(query).all(...params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/:id', (req, res) => {
    try {
        const order = db.prepare(
            `SELECT po.*, w.name as warehouse_name, w.code as warehouse_code
             FROM purchase_orders po
             LEFT JOIN warehouses w ON po.warehouse_id = w.id
             WHERE po.id = ?`
        ).get(req.params.id);
        if (!order) return res.status(404).json({ error: 'Purchase order not found' });

        const items = db.prepare(
            `SELECT poi.*, p.name as product_name
             FROM purchase_order_items poi
             JOIN products p ON poi.product_id = p.id
             WHERE poi.purchase_order_id = ?`
        ).all(req.params.id);

        res.json({ ...order, items });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/', (req, res) => {
    try {
        const { supplier_name, supplier_contact, warehouse_id, expected_date, items, notes } = req.body;

        if (!supplier_name || !warehouse_id || !items || items.length === 0) {
            return res.status(400).json({ error: 'Supplier name, warehouse, and at least one item are required' });
        }

        const orderId = uuidv4();
        let totalCost = 0;

        const validatedItems = items.map(item => {
            const lineTotal = item.quantity * item.unit_cost;
            totalCost += lineTotal;
            return { ...item, line_total: lineTotal };
        });

        const transaction = db.transaction(() => {
            db.prepare(
                `INSERT INTO purchase_orders (id, supplier_name, supplier_contact, warehouse_id, expected_date, total_cost, notes, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(orderId, supplier_name, supplier_contact, warehouse_id, expected_date, totalCost, notes, req.user.id);

            for (const item of validatedItems) {
                const itemId = uuidv4();
                db.prepare(
                    `INSERT INTO purchase_order_items (id, purchase_order_id, product_id, warehouse_id, unit_type, quantity, unit_cost, line_total)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                ).run(itemId, orderId, item.product_id, warehouse_id, item.unit_type, item.quantity, item.unit_cost, item.line_total);
            }
        });

        transaction();
        res.status(201).json({ id: orderId, total_cost: totalCost, message: 'Purchase order created' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/:id/receive', (req, res) => {
    try {
        const orderId = req.params.id;

        const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(orderId);
        if (!order) return res.status(404).json({ error: 'Purchase order not found' });
        if (order.status === 'received') {
            return res.status(400).json({ error: 'Order already received' });
        }

        const items = db.prepare('SELECT * FROM purchase_order_items WHERE purchase_order_id = ?').all(orderId);

        const transaction = db.transaction(() => {
            for (const item of items) {
                const stockField = `${item.unit_type}_stock`;
                db.prepare(`UPDATE product_stock SET ${stockField} = ${stockField} + ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND warehouse_id = ?`).run(item.quantity, item.product_id, order.warehouse_id);
                
                const movementId = uuidv4();
                db.prepare(
                    `INSERT INTO stock_movements (id, product_id, warehouse_id, movement_type, unit_type, quantity, reference_id, reference_type, created_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                ).run(movementId, item.product_id, order.warehouse_id, 'in', item.unit_type, item.quantity, orderId, 'purchase_order', req.user.id);
            }

            db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run('received', orderId);
        });

        transaction();
        res.json({ message: 'Purchase order received and stock updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/:id/status', (req, res) => {
    try {
        const { status } = req.body;
        const validStatuses = ['pending', 'ordered', 'partial', 'received', 'cancelled'];
        
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }

        const result = db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(status, req.params.id);
        if (result.changes === 0) return res.status(404).json({ error: 'Purchase order not found' });
        res.json({ message: 'Status updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/:id', (req, res) => {
    try {
        const order = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(req.params.id);
        if (!order) return res.status(404).json({ error: 'Purchase order not found' });
        if (order.status === 'received') {
            return res.status(400).json({ error: 'Cannot delete received order' });
        }

        const transaction = db.transaction(() => {
            db.prepare('DELETE FROM purchase_order_items WHERE purchase_order_id = ?').run(req.params.id);
            db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(req.params.id);
        });

        transaction();
        res.json({ message: 'Purchase order deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;