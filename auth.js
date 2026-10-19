const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDb } = require('./database');

const JWT_EXPIRES_IN = '7d';
const MIN_SECRET_LENGTH = 32;

const WEAK_MARKERS = [
    'change-me', 'change-this', 'changeme', 'your-super-secret', 'secret-key',
    'secretkey', 'admin123', 'password', 'example', 'placeholder', 'default',
    'your_secret', 'super-secret'
];

function isWeakSecret(secret) {
    if (!secret) return true;
    if (secret.length < MIN_SECRET_LENGTH) return true;
    const lower = secret.toLowerCase();
    return WEAK_MARKERS.some(m => lower.includes(m));
}

function loadJwtSecret() {
    const envSecret = process.env.JWT_SECRET;

    if (envSecret) {
        if (isWeakSecret(envSecret)) {
            const msg = 'JWT_SECRET is missing, too short, or a known placeholder. Set a strong random secret (at least 32 chars).';
            if (process.env.NODE_ENV === 'production') throw new Error(msg);
            console.warn('[warn] ' + msg + ' (using it anyway in development)');
            return envSecret;
        }
        return envSecret;
    }

    // No JWT_SECRET provided.
    if (process.env.NODE_ENV === 'production') {
        throw new Error('JWT_SECRET is required in production. Set a strong random secret.');
    }

    // Development only: generate and persist a random secret for convenience.
    const secretPath = path.join(__dirname, '.jwt-secret');
    try {
        if (fs.existsSync(secretPath)) {
            const existing = fs.readFileSync(secretPath, 'utf8').trim();
            if (existing && !isWeakSecret(existing)) return existing;
        }
    } catch (e) { /* ignore */ }
    const generated = crypto.randomBytes(48).toString('hex');
    try { fs.writeFileSync(secretPath, generated, { mode: 0o600 }); } catch (e) { /* ignore */ }
    return generated;
}

const JWT_SECRET = loadJwtSecret();

function generateToken(user) {
    return jwt.sign(
        { id: user.id, username: user.username },
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

// requireAdmin re-checks the CURRENT role/status from the database so a demoted
// or disabled user cannot keep using stale privileges from an old token.
function requireAdmin(req, res, next) {
    let current;
    try {
        current = getDb().prepare('SELECT role, is_active FROM users WHERE id = ?').get(req.user.id);
    } catch (e) {
        return res.status(500).json({ error: 'Something went wrong' });
    }
    if (!current || !current.is_active) {
        return res.status(403).json({ error: 'Account is disabled' });
    }
    if (current.role !== 'admin') {
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
    VALID_ROLES,
    isWeakSecret
};