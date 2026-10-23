const express = require('express');
const { getDb } = require('../database');
const { authenticateToken, requirePermission } = require('../auth');
const { parseLimit, parseOffset } = require('../lib/validation');
const { sendSafeError, ClientError } = require('../lib/errors');
const service = require('../services/stocktakes');
const router = express.Router();
router.use(authenticateToken, requirePermission('manage_products'));
router.get('/', (req, res) => {
    try {
        let query =
            'SELECT st.*,w.name AS warehouse_name,u.username AS created_by_name FROM stocktakes st JOIN warehouses w ON w.id=st.warehouse_id LEFT JOIN users u ON u.id=st.created_by WHERE 1=1';
        const params = [];
        if (req.query.warehouse_id) {
            query += ' AND st.warehouse_id=?';
            params.push(req.query.warehouse_id);
        }
        query += ' ORDER BY st.created_at DESC,st.rowid DESC LIMIT ? OFFSET ?';
        params.push(
            parseLimit(req.query.limit, 50),
            parseOffset(req.query.offset)
        );
        res.json(
            getDb()
                .prepare(query)
                .all(...params)
        );
    } catch (e) {
        sendSafeError(res, e, '[stocktakes]');
    }
});
router.post('/', (req, res) => {
    try {
        res.status(201).json(service.create(req));
    } catch (e) {
        sendSafeError(res, e, '[stocktakes]');
    }
});
router.get('/:id', (req, res) => {
    try {
        res.json(service.detail(req.params.id));
    } catch (e) {
        sendSafeError(res, e, '[stocktakes]');
    }
});
router.post('/:id/:action', (req, res) => {
    try {
        if (
            !['save', 'submit', 'approve', 'recount', 'cancel'].includes(
                req.params.action
            )
        )
            throw new ClientError(404, 'Action not found');
        res.json(service.update(req, req.params.id, req.params.action));
    } catch (e) {
        sendSafeError(res, e, '[stocktakes]');
    }
});
module.exports = router;
