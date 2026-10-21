const express = require('express');
const { getDb } = require('../database');
const { authenticateToken } = require('../auth');
const { parseLimit } = require('../lib/validation');

const router = express.Router();
const db = getDb();

router.use(authenticateToken);

router.get('/', (req, res) => {
    try {
        const { unread_only, warehouse_id, limit = 50 } = req.query;
        let query = 'SELECT a.*, p.name as product_name, w.name as warehouse_name FROM alerts a LEFT JOIN products p ON a.product_id = p.id LEFT JOIN warehouses w ON a.warehouse_id = w.id WHERE 1=1';
        const params = [];

        if (unread_only === 'true') {
            query += ' AND a.is_read = 0';
        }
        if (warehouse_id) {
            query += ' AND a.warehouse_id = ?';
            params.push(warehouse_id);
        }

        query += ' ORDER BY a.created_at DESC LIMIT ?';
        params.push(parseLimit(limit, 50));

        const rows = db.prepare(query).all(...params);
        res.json(rows);
    } catch (err) {
        console.error(err); res.status(500).json({ error: 'Something went wrong' });
    }
});

router.get('/unread-count', (req, res) => {
    try {
        const { warehouse_id } = req.query;
        let query = 'SELECT COUNT(*) as count FROM alerts WHERE is_read = 0';
        const params = [];
        
        if (warehouse_id) {
            query += ' AND warehouse_id = ?';
            params.push(warehouse_id);
        }
        
        const row = db.prepare(query).get(...params);
        res.json(row);
    } catch (err) {
        console.error(err); res.status(500).json({ error: 'Something went wrong' });
    }
});

router.put('/read-all', (req, res) => {
    try {
        const { warehouse_id } = req.body;
        let query = 'UPDATE alerts SET is_read = 1 WHERE is_read = 0';
        const params = [];
        
        if (warehouse_id) {
            query += ' AND warehouse_id = ?';
            params.push(warehouse_id);
        }
        
        const result = db.prepare(query).run(...params);
        res.json({ message: 'All alerts marked as read', count: result.changes });
    } catch (err) {
        console.error(err); res.status(500).json({ error: 'Something went wrong' });
    }
});

router.put('/:id/read', (req, res) => {
    try {
        const result = db.prepare('UPDATE alerts SET is_read = 1 WHERE id = ?').run(req.params.id);
        if (result.changes === 0) return res.status(404).json({ error: 'Alert not found' });
        res.json({ message: 'Alert marked as read' });
    } catch (err) {
        console.error(err); res.status(500).json({ error: 'Something went wrong' });
    }
});

router.delete('/:id', (req, res) => {
    try {
        const result = db.prepare('DELETE FROM alerts WHERE id = ?').run(req.params.id);
        if (result.changes === 0) return res.status(404).json({ error: 'Alert not found' });
        res.json({ message: 'Alert deleted' });
    } catch (err) {
        console.error(err); res.status(500).json({ error: 'Something went wrong' });
    }
});

module.exports = router;