const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { generateToken, authenticateToken, VALID_ROLES } = require('../auth');

const router = express.Router();
const db = getDb();

router.post('/login', (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });

        const validPassword = bcrypt.compareSync(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = generateToken(user);
        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/register', authenticateToken, (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { username, email, password, role } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Username, email, and password are required' });
        }
        const userRole = role || 'user';
        if (!VALID_ROLES.includes(userRole)) return res.status(400).json({ error: 'Invalid role' });

        const passwordHash = bcrypt.hashSync(password, 10);
        const id = uuidv4();

        db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
            .run(id, username, email, passwordHash, userRole);

        res.status(201).json({ id, username, email, role: userRole });
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Username or email already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

router.get('/me', authenticateToken, (req, res) => {
    try {
        const user = db.prepare('SELECT id, username, email, role, created_at FROM users WHERE id = ?').get(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/change-password', authenticateToken, (req, res) => {
    try {
        const { current_password, new_password } = req.body;

        if (!current_password || !new_password) {
            return res.status(400).json({ error: 'Current and new password are required' });
        }

        const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const validPassword = bcrypt.compareSync(current_password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        const newHash = bcrypt.hashSync(new_password, 10);
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user.id);
        res.json({ message: 'Password changed successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;