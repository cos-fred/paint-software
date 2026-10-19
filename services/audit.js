const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { broadcast } = require('./realtime');

function logAudit(userId, action, entityType = null, entityId = null, details = null) {
    try {
        const db = getDb();
        db.prepare(
            `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, details)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).run(uuidv4(), userId || null, action, entityType, entityId, details ? JSON.stringify(details) : null);
    } catch (err) {
        console.error('Audit log error:', err.message);
    }
    // Notify all connected clients that data changed.
    broadcast('change', { action, entityType });
}

module.exports = { logAudit };