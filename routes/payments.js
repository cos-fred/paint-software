const express = require('express');
const { getDb } = require('../database');
const { authenticateToken } = require('../auth');
const { account, recordPayment } = require('../services/payments');
const { sendSafeError } = require('../lib/errors');
const router = express.Router({ mergeParams: true });
router.use(authenticateToken);
router.get('/', (req, res) => {
    try {
        res.json({
            account: account(req.params.saleId),
            payments: getDb()
                .prepare(
                    `SELECT sp.*,u.username AS recorded_by FROM sale_payments sp LEFT JOIN users u ON u.id=sp.created_by WHERE sp.sale_id=? ORDER BY sp.received_at,sp.rowid`
                )
                .all(req.params.saleId)
        });
    } catch (e) {
        sendSafeError(res, e, '[payments]');
    }
});
router.post('/', (req, res) => {
    try {
        const result = recordPayment(req, req.params.saleId);
        res.status(result.replay ? 200 : 201).json(result.body);
    } catch (e) {
        sendSafeError(res, e, '[payments]');
    }
});
module.exports = router;
