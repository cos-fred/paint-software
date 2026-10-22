const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb, resetDatabase } = require('../database');
const { authenticateToken, requireAdmin } = require('../auth');
const { runBackup, getBackupStatus } = require('../services/backup');
const maintenance = require('../services/maintenance');
const { logAudit } = require('../services/audit');
const { sendSafeError } = require('../lib/errors');

const router = express.Router();
const db = getDb();

// Complete wipe and restart, preserving only the primary (initial) admin.
// Requires the primary admin's current password.
router.get('/status', authenticateToken, requireAdmin, (req, res) => {
    try {
        res.json({
            backup: getBackupStatus(),
            reset_enabled:
                process.env.NODE_ENV !== 'production' ||
                process.env.ALLOW_SYSTEM_RESET === 'true'
        });
    } catch (err) {
        sendSafeError(res, err, '[system] status');
    }
});
router.post('/backup', authenticateToken, requireAdmin, async (req, res) => {
    try {
        await runBackup({ forceRemote: true });
        logAudit(req.user.id, 'backup.create', 'system');
        res.json({ message: 'Backup verified', backup: getBackupStatus() });
    } catch (err) {
        sendSafeError(res, err, '[system] backup');
    }
});
router.get(
    '/backup/download',
    authenticateToken,
    requireAdmin,
    async (req, res) => {
        try {
            const file = await runBackup();
            logAudit(req.user.id, 'backup.download', 'system');
            res.download(file);
        } catch (err) {
            sendSafeError(res, err, '[system] backup download');
        }
    }
);
router.post('/reset', authenticateToken, async (req, res) => {
    try {
        const { password } = req.body;
        if (
            process.env.NODE_ENV === 'production' &&
            process.env.ALLOW_SYSTEM_RESET !== 'true'
        )
            return res
                .status(403)
                .json({ error: 'System reset is disabled in production' });

        if (req.user.role !== 'admin' || req.user.username !== 'admin') {
            return res
                .status(403)
                .json({
                    error: 'Only the primary administrator can reset the system'
                });
        }

        if (!password) {
            return res
                .status(400)
                .json({ error: 'Password is required to confirm the reset' });
        }

        const user = db
            .prepare('SELECT password_hash FROM users WHERE id = ?')
            .get(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const valid = bcrypt.compareSync(String(password), user.password_hash);
        if (!valid) {
            return res.status(400).json({ error: 'Incorrect password' });
        }

        maintenance.setActive(true);
        await runBackup({ forceRemote: true });
        resetDatabase(req.user.id);

        logAudit(req.user.id, 'system.reset', 'system', null, {});
        res.json({ message: 'System reset successfully' });
    } catch (err) {
        sendSafeError(res, err, '[system] reset');
    } finally {
        maintenance.setActive(false);
    }
});

module.exports = router;
