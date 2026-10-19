const jwt = require('jsonwebtoken');
const { getDb } = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'paint-software-secret-key-change-in-production';
const JWT_EXPIRES_IN = '7d';

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

function getUserById(userId) {
    const db = getDb();
    return db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(userId);
}

module.exports = {
    generateToken,
    verifyToken,
    authenticateToken,
    requireAdmin,
    getUserById,
    JWT_SECRET
};