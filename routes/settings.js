const express = require('express');
const { getDb } = require('../database');
const { authenticateToken, requireAdmin } = require('../auth');

const router = express.Router();
const db = getDb();

router.use(authenticateToken);

const SENSITIVE_KEYS = ['notifications_webhook_url'];

// Only known settings may be written, and each value is validated before it is
// persisted. This keeps values such as `currency` safe to render in the UI.
const SETTING_VALIDATORS = {
    company_name: (v) => typeof v === 'string' && v.length > 0 && v.length <= 120,
    company_address: (v) => typeof v === 'string' && v.length <= 300,
    company_phone: (v) => typeof v === 'string' && v.length <= 40,
    company_email: (v) => v === '' || (typeof v === 'string' && v.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)),
    show_total_value: (v) => v === 'true' || v === 'false',
    currency: (v) => typeof v === 'string' && /^[A-Z]{3}$/.test(v),
    low_stock_threshold_default: (v) => /^\d+$/.test(v) && Number(v) <= 1000000,
    notifications_enabled: (v) => v === 'true' || v === 'false',
    notifications_webhook_url: (v) => v === '' || (typeof v === 'string' && v.length <= 500 && /^https?:\/\/\S+$/i.test(v))
};

function filterForUser(rows, user) {
    if (user.role === 'admin') return rows;
    return rows.filter((r) => !SENSITIVE_KEYS.includes(r.key));
}

// Readable by all authenticated users so company info and preferences apply
// consistently across the app. Writes remain admin-only.
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
        if (description !== undefined && (typeof description !== 'string' || description.length > 300)) {
            return res.status(400).json({ error: 'Invalid description' });
        }

        const key = req.params.key;
        const validator = Object.prototype.hasOwnProperty.call(SETTING_VALIDATORS, key)
            ? SETTING_VALIDATORS[key]
            : null;
        if (!validator) {
            return res.status(400).json({ error: 'Unknown setting' });
        }
        let normalized = String(value);
        if (key === 'currency') normalized = normalized.toUpperCase();
        if (!validator(normalized)) {
            return res.status(400).json({ error: `Invalid value for ${req.params.key}` });
        }

        db.prepare(
            `INSERT INTO settings (key, value, description) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = ?, description = COALESCE(?, description)`
        ).run(req.params.key, normalized, description, normalized, description);

        res.json({ message: 'Setting saved', key: req.params.key, value: normalized });
    } catch (err) {
        console.error(err); res.status(500).json({ error: 'Something went wrong' });
    }
});

router.delete('/:key', requireAdmin, (req, res) => {
    try {
        const protectedKeys = ['company_name', 'company_address', 'currency'];
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
