const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb, resetDatabase } = require('../database');
const { authenticateToken } = require('../auth');
const { logAudit } = require('../services/audit');
const { sendSafeError } = require('../lib/errors');

const router = express.Router();
const db = getDb();

// Complete wipe and restart, preserving only the primary (initial) admin.
// Requires the primary admin's current password.
router.post('/reset', authenticateToken, (req, res) => {
    try {
        const { password } = req.body;

        if (req.user.role !== 'admin' || req.user.username !== 'admin') {
            return res.status(403).json({ error: 'Only the primary administrator can reset the system' });
        }

        if (!password) {
            return res.status(400).json({ error: 'Password is required to confirm the reset' });
        }

        const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const valid = bcrypt.compareSync(String(password), user.password_hash);
        if (!valid) {
            return res.status(400).json({ error: 'Incorrect password' });
        }

        resetDatabase(req.user.id);

        logAudit(req.user.id, 'system.reset', 'system', null, {});
        res.json({ message: 'System reset successfully' });
    } catch (err) {
        sendSafeError(res, err, '[system] reset');
    }
});

module.exports = router;
