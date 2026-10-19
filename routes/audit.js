const express = require('express');
const { getDb } = require('../database');
const { authenticateToken, requireAdmin } = require('../auth');

const router = express.Router();
const db = getDb();

router.use(authenticateToken);
router.use(requireAdmin);

router.get('/', (req, res) => {
    try {
        const { limit = 200, search } = req.query;
        let query = `SELECT al.*, u.username as user_name FROM audit_logs al LEFT JOIN users u ON al.user_id = u.id`;
        const params = [];
        if (search) { query += ' WHERE al.action LIKE ? OR al.entity_type LIKE ?'; params.push(`%${search}%`, `%${search}%`); }
        query += ' ORDER BY al.created_at DESC LIMIT ?';
        params.push(parseInt(limit));
        res.json(db.prepare(query).all(...params));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;