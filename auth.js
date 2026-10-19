const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { getDb } = require('./database');

const JWT_EXPIRES_IN = '7d';

function loadJwtSecret() {
    if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
    const secretPath = path.join(__dirname, '.jwt-secret');
    try {
        if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, 'utf8').trim();
    } catch (e) { /* ignore */ }
    const generated = require('crypto').randomBytes(48).toString('hex');
    try { fs.writeFileSync(secretPath, generated, { mode: 0o600 }); } catch (e) { /* ignore */ }
    return generated;
}

const JWT_SECRET = loadJwtSecret();

function generateToken(user) {
    return jwt.sign(
        { id: user.id, username: user.username, role: user.role },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );
}

function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (err) {
        return null;
    }
}

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    const decoded = verifyToken(token);
    if (!decoded) {
        return res.status(403).json({ error: 'Invalid or expired token' });
    }

    req.user = decoded;
    next();
}

function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

const VALID_ROLES = ['admin', 'user'];

module.exports = {
    generateToken,
    verifyToken,
    authenticateToken,
    requireAdmin,
    VALID_ROLES
};