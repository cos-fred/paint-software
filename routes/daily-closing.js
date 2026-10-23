const express = require('express');
const { getDb } = require('../database');
const { authenticateToken, requireAdmin } = require('../auth');
const { report, close } = require('../services/daily-closing');
const { sendSafeError, ClientError } = require('../lib/errors');
const router = express.Router();
router.use(authenticateToken);
router.get('/', (req, res) => {
    try {
        res.json(
            report(
                req.query.date || new Date().toISOString().slice(0, 10),
                req.query.warehouse_id
            )
        );
    } catch (e) {
        sendSafeError(res, e, '[closing]');
    }
});
router.post('/', requireAdmin, (req, res) => {
    try {
        res.json(close(req));
    } catch (e) {
        sendSafeError(res, e, '[closing]');
    }
});
router.get('/:id/history', requireAdmin, (req, res) => {
    try {
        const rows = getDb()
            .prepare(
                `SELECT dcr.*,u.username AS recorded_by FROM daily_closing_revisions dcr LEFT JOIN users u ON u.id=dcr.created_by WHERE closing_id=? ORDER BY revision DESC`
            )
            .all(req.params.id);
        if (!rows.length) throw new ClientError(404, 'Closing not found');
        res.json(
            rows.map((r) => ({ ...r, record: JSON.parse(r.record_json) }))
        );
    } catch (e) {
        sendSafeError(res, e, '[closing]');
    }
});
module.exports = router;
