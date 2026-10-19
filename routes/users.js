const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authenticateToken, requireAdmin } = require('../auth');

const router = express.Router();
const db = getDb();

router.use(authenticateToken);
router.use(requireAdmin);

router.get('/', (req, res) => {
    try {
        const rows = db.prepare('SELECT id, username, email, role, created_at FROM users ORDER BY created_at DESC').all();
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/:id', (req, res) => {
    try {
        const row = db.prepare('SELECT id, username, email, role, created_at FROM users WHERE id = ?').get(req.params.id);
        if (!row) return res.status(404).json({ error: 'User not found' });
        res.json(row);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/', (req, res) => {
    try {
        const { username, email, password, role } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Username, email, and password are required' });
        }

        const passwordHash = bcrypt.hashSync(password, 10);
        const id = uuidv4();

        db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
            .run(id, username, email, passwordHash, role || 'user');

        res.status(201).json({ id, username, email, role: role || 'user' });
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Username or email already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

router.put('/:id', (req, res) => {
    try {
        const { username, email, role } = req.body;
        const userId = req.params.id;

        if (userId === req.user.id) {
            return res.status(400).json({ error: 'Cannot modify your own account through this endpoint' });
        }

        const updates = [];
        const params = [];

        if (username !== undefined) { updates.push('username = ?'); params.push(username); }
        if (email !== undefined) { updates.push('email = ?'); params.push(email); }
        if (role !== undefined) { updates.push('role = ?'); params.push(role); }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        params.push(userId);

        const result = db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ message: 'User updated successfully' });
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Username or email already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

router.delete('/:id', (req, res) => {
    try {
        const userId = req.params.id;

        if (userId === req.user.id) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }

        const result = db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ message: 'User deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;