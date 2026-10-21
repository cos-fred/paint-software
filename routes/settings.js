const express = require('express');
const { getDb } = require('../database');
const { authenticateToken, requireAdmin } = require('../auth');

const router = express.Router();
const db = getDb();

router.use(authenticateToken);

const SENSITIVE_KEYS = ['notifications_webhook_url'];

function filterForUser(rows, user) {
    if (user.role === 'admin') return rows;
    return rows.filter((r) => !SENSITIVE_KEYS.includes(r.key));
}

// Readable by all authenticated users so company info and tax settings
// apply consistently across the app. Writes remain admin-only.
router.get('/', (req, res) => {
    try {
        const rows = db.prepare('SELECT * FROM settings ORDER BY key').all();
        res.json(filterForUser(rows, req.user));
    } catch (err) {
        console.error(err); res.status(500).json({ error: 'Something went wrong' });
    }
});

router.get('/:key', (req, res) => {
    try {
        if (req.user.role !== 'admin' && SENSITIVE_KEYS.includes(req.params.key)) {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const row = db.prepare('SELECT * FROM settings WHERE key = ?').get(req.params.key);
        if (!row) return res.status(404).json({ error: 'Setting not found' });
        res.json(row);
    } catch (err) {
        console.error(err); res.status(500).json({ error: 'Something went wrong' });
    }
});

router.put('/:key', requireAdmin, (req, res) => {
    try {
        const { value, description } = req.body;

        if (value === undefined) {
            return res.status(400).json({ error: 'Value is required' });
        }

        db.prepare(
            `INSERT INTO settings (key, value, description) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = ?, description = COALESCE(?, description)`
        ).run(req.params.key, value, description, value, description);

        res.json({ message: 'Setting saved', key: req.params.key, value });
    } catch (err) {
        console.error(err); res.status(500).json({ error: 'Something went wrong' });
    }
});

router.delete('/:key', requireAdmin, (req, res) => {
    try {
        const protectedKeys = ['company_name', 'company_address', 'tax_rate', 'currency'];
        if (protectedKeys.includes(req.params.key)) {
            return res.status(400).json({ error: 'Cannot delete protected setting' });
        }

        const result = db.prepare('DELETE FROM settings WHERE key = ?').run(req.params.key);
        if (result.changes === 0) return res.status(404).json({ error: 'Setting not found' });
        res.json({ message: 'Setting deleted' });
    } catch (err) {
        console.error(err); res.status(500).json({ error: 'Something went wrong' });
    }
});

module.exports = router;
