const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authenticateToken, requireAdmin, bumpTokenVersion, VALID_ROLES } = require('../auth');
const { isWeakPassword } = require('../lib/passwords');
const { sendSafeError } = require('../lib/errors');
const { logAudit } = require('../services/audit');

const router = express.Router();
const db = getDb();

router.use(authenticateToken);
router.use(requireAdmin);

router.get('/', (req, res) => {
    try {
        const rows = db.prepare('SELECT id, username, email, role, is_active, created_at FROM users ORDER BY created_at DESC').all();
        res.json(rows);
    } catch (err) {
        sendSafeError(res, err, '[users]');
    }
});

router.get('/:id', (req, res) => {
    try {
        const row = db.prepare('SELECT id, username, email, role, is_active, created_at FROM users WHERE id = ?').get(req.params.id);
        if (!row) return res.status(404).json({ error: 'User not found' });
        res.json(row);
    } catch (err) {
        sendSafeError(res, err, '[users]');
    }
});

router.post('/', (req, res) => {
    try {
        const { username, email, password, role } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Username, email, and password are required' });
        }
        if (isWeakPassword(password)) {
            return res.status(400).json({ error: 'Password is too weak. Use at least 8 characters and avoid common passwords.' });
        }
        const userRole = role || 'user';
        if (!VALID_ROLES.includes(userRole)) return res.status(400).json({ error: 'Invalid role' });

        const passwordHash = bcrypt.hashSync(password, 12);
        const id = uuidv4();

        db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
            .run(id, username, email, passwordHash, userRole);

        logAudit(req.user.id, 'user.create', 'user', id, { username, role: userRole });
        res.status(201).json({ id, username, email, role: userRole });
    } catch (err) {
        sendSafeError(res, err, '[users]');
    }
});

router.put('/:id', (req, res) => {
    try {
        const { username, email, role, is_active } = req.body;
        const userId = req.params.id;

        if (userId === req.user.id) {
            return res.status(400).json({ error: 'Cannot modify your own account through this endpoint' });
        }

        if (role !== undefined && !VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
        if (is_active !== undefined && !(is_active === 0 || is_active === 1 || is_active === true || is_active === false)) {
            return res.status(400).json({ error: 'Invalid is_active value' });
        }

        const existing = db.prepare('SELECT id, role, is_active FROM users WHERE id = ?').get(userId);
        if (!existing) return res.status(404).json({ error: 'User not found' });

        const updates = [];
        const params = [];
        let invalidate = false;

        if (username !== undefined) { updates.push('username = ?'); params.push(username); }
        if (email !== undefined) { updates.push('email = ?'); params.push(email); }
        if (role !== undefined) {
            updates.push('role = ?');
            params.push(role);
            if (role !== existing.role) invalidate = true;
        }
        if (is_active !== undefined) {
            const activeVal = (is_active === true || is_active === 1) ? 1 : 0;
            updates.push('is_active = ?');
            params.push(activeVal);
            if (activeVal !== existing.is_active) invalidate = true;
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(userId);

        db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        if (invalidate) bumpTokenVersion(userId);
        logAudit(req.user.id, 'user.update', 'user', userId, { role, is_active });
        res.json({ message: 'User updated successfully' });
    } catch (err) {
        sendSafeError(res, err, '[users]');
    }
});

router.delete('/:id', (req, res) => {
    try {
        const userId = req.params.id;

        if (userId === req.user.id) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }

        const result = db.prepare(
            'UPDATE users SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run(userId);
        if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
        bumpTokenVersion(userId);
        logAudit(req.user.id, 'user.disable', 'user', userId);
        res.json({ message: 'User disabled successfully' });
    } catch (err) {
        sendSafeError(res, err, '[users]');
    }
});

module.exports = router;
