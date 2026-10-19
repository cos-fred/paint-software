const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { generateToken, authenticateToken, requireAdmin, VALID_ROLES } = require('../auth');

const router = express.Router();
const db = getDb();

// Stricter, dedicated limiter for login (only failed attempts count).
const loginLimiter = rateLimit({
    windowMs: parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX) || 10,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts, please try again later' }
});

router.post('/login', loginLimiter, (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username));
        // Generic message whether the user exists or the password is wrong.
        if (!user || !user.is_active) return res.status(401).json({ error: 'Invalid credentials' });

        const validPassword = bcrypt.compareSync(String(password), user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = generateToken(user);
        res.json({
            token,
            user: { id: user.id, username: user.username, email: user.email, role: user.role }
        });
    } catch (err) {
        console.error('[auth] login error:', err.message);
        res.status(500).json({ error: 'Something went wrong' });
    }
});

router.post('/register', authenticateToken, requireAdmin, (req, res) => {
    try {
        const { username, email, password, role } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Username, email, and password are required' });
        }
        const userRole = role || 'user';
        if (!VALID_ROLES.includes(userRole)) return res.status(400).json({ error: 'Invalid role' });

        const passwordHash = bcrypt.hashSync(String(password), 10);
        const id = uuidv4();

        db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
            .run(id, username, email, passwordHash, userRole);

        res.status(201).json({ id, username, email, role: userRole });
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Username or email already exists' });
        }
        console.error('[auth] register error:', err.message);
        res.status(500).json({ error: 'Something went wrong' });
    }
});

router.get('/me', authenticateToken, (req, res) => {
    try {
        const user = db.prepare('SELECT id, username, email, role, created_at FROM users WHERE id = ?').get(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json(user);
    } catch (err) {
        console.error('[auth] me error:', err.message);
        res.status(500).json({ error: 'Something went wrong' });
    }
});

router.put('/change-password', authenticateToken, (req, res) => {
    try {
        const { current_password, new_password } = req.body;

        if (!current_password || !new_password) {
            return res.status(400).json({ error: 'Current and new password are required' });
        }
        if (String(new_password).length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters' });
        }

        const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const validPassword = bcrypt.compareSync(String(current_password), user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        const newHash = bcrypt.hashSync(String(new_password), 10);
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user.id);
        res.json({ message: 'Password changed successfully' });
    } catch (err) {
        console.error('[auth] change-password error:', err.message);
        res.status(500).json({ error: 'Something went wrong' });
    }
});

module.exports = router;