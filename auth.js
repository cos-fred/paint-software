const jwt = require('jsonwebtoken');
const { getDb } = require('./database');
const { isWeakSecret, loadJwtSecret } = require('./lib/jwt-secret');

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';
const JWT_SECRET = loadJwtSecret();

function generateToken(user) {
    return jwt.sign(
        {
            id: user.id,
            username: user.username,
            token_version: user.token_version || 0
        },
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

function bumpTokenVersion(userId) {
    getDb().prepare(
        'UPDATE users SET token_version = token_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(userId);
}

function loadCurrentUser(userId) {
    return getDb().prepare(
        'SELECT id, username, email, role, is_active, token_version FROM users WHERE id = ?'
    ).get(userId);
}

// Always re-load role, active flag, and token_version from the database.
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    const decoded = verifyToken(token);
    if (!decoded || !decoded.id) {
        return res.status(403).json({ error: 'Invalid or expired token' });
    }

    let current;
    try {
        current = loadCurrentUser(decoded.id);
    } catch (e) {
        return res.status(500).json({ error: 'Something went wrong' });
    }

    if (!current || !current.is_active) {
        return res.status(403).json({ error: 'Account is disabled' });
    }

    const tokenVersion = decoded.token_version || 0;
    if (tokenVersion !== (current.token_version || 0)) {
        return res.status(403).json({ error: 'Invalid or expired token' });
    }

    req.user = {
        id: current.id,
        username: current.username,
        email: current.email,
        role: current.role,
        token_version: current.token_version || 0
    };
    next();
}

function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
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
    bumpTokenVersion,
    VALID_ROLES,
    isWeakSecret,
    loadJwtSecret
};
