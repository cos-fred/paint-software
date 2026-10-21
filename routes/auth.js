const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { generateToken, authenticateToken, requireAdmin, bumpTokenVersion, VALID_ROLES, PERMISSIONS, DEFAULT_USER_PERMISSIONS } = require('../auth');
const { isWeakPassword } = require('../lib/passwords');
const { sendSafeError } = require('../lib/errors');

const router = express.Router();
const db = getDb();

const loginLimiter = rateLimit({
    windowMs: parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
    max: parseInt(process.env.LOGIN_RATE_LIMIT_MAX, 10) || 10,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const username = req.body && req.body.username ? String(req.body.username).toLowerCase() : '';
        return `${rateLimit.ipKeyGenerator(req.ip)}:${username}`;
    },
    message: { error: 'Too many login attempts, please try again later' }
});

function logAuthEvent(userId, action, username) {
    try {
        db.prepare('INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)')
            .run(uuidv4(), userId || null, action, 'user', userId || null, username ? JSON.stringify({ username }) : null);
    } catch (e) { /* ignore */ }
}

router.post('/login', loginLimiter, (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username));
        if (!user || !user.is_active) {
            logAuthEvent(user ? user.id : null, 'auth.login_failed', String(username));
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const validPassword = bcrypt.compareSync(String(password), user.password_hash);
        if (!validPassword) {
            logAuthEvent(user.id, 'auth.login_failed', String(username));
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        logAuthEvent(user.id, 'auth.login', String(username));
        const token = generateToken(user);
        res.json({
            token,
            user: { id: user.id, username: user.username, email: user.email, role: user.role, must_change_password: !!user.must_change_password }
        });
    } catch (err) {
        sendSafeError(res, err, '[auth] login error:');
    }
});

router.post('/register', authenticateToken, requireAdmin, (req, res) => {
    try {
        const { username, email, password, role, permissions } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Username, email, and password are required' });
        }
        if (isWeakPassword(password)) {
            return res.status(400).json({ error: 'Password is too weak. Use at least 8 characters and avoid common passwords.' });
        }
        const userRole = role || 'user';
        if (!VALID_ROLES.includes(userRole)) return res.status(400).json({ error: 'Invalid role' });

        let userPermissions = userRole === 'admin' ? [] : DEFAULT_USER_PERMISSIONS.slice();
        if (Array.isArray(permissions)) {
            userPermissions = permissions.filter(p => PERMISSIONS.includes(p));
        }

        const passwordHash = bcrypt.hashSync(String(password), 12);
        const id = uuidv4();

        db.prepare('INSERT INTO users (id, username, email, password_hash, role, permissions, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1)')
            .run(id, username, email, passwordHash, userRole, JSON.stringify(userPermissions));

        res.status(201).json({ id, username, email, role: userRole, permissions: userPermissions });
    } catch (err) {
        sendSafeError(res, err, '[auth] register error:');
    }
});

router.get('/me', authenticateToken, (req, res) => {
    try {
        const user = db.prepare('SELECT id, username, email, role, must_change_password, created_at FROM users WHERE id = ?').get(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json(user);
    } catch (err) {
        sendSafeError(res, err, '[auth] me error:');
    }
});

router.put('/change-password', authenticateToken, (req, res) => {
    try {
        const { current_password, new_password } = req.body;

        if (!current_password || !new_password) {
            return res.status(400).json({ error: 'Current and new password are required' });
        }
        if (isWeakPassword(new_password)) {
            return res.status(400).json({ error: 'New password is too weak. Use at least 8 characters and avoid common passwords.' });
        }

        const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const validPassword = bcrypt.compareSync(String(current_password), user.password_hash);
        if (!validPassword) {
            return res.status(400).json({ error: 'Current password is incorrect' });
        }

        const newHash = bcrypt.hashSync(String(new_password), 12);
        db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(newHash, req.user.id);
        bumpTokenVersion(req.user.id);
        res.json({ message: 'Password changed successfully' });
    } catch (err) {
        sendSafeError(res, err, '[auth] change-password error:');
    }
});

module.exports = router;
