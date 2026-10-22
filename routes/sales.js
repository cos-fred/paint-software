const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authenticateToken, requireAdmin } = require('../auth');
const { logAudit } = require('../services/audit');
const { publishStockChanges } = require('../services/low-stock');
const {
    stockColumn,
    priceColumn,
    toUnits,
    UNIT_TYPES
} = require('../lib/stock');
const { ClientError, sendSafeError } = require('../lib/errors');
const {
    parsePositiveInteger,
    parseFiniteNumber,
    parseLimit,
    parseOffset
} = require('../lib/validation');
const { sanitizeCell } = require('../lib/export');
const { createSale } = require('../services/sales');
const { returnableItems, creditItem } = require('../services/sale-returns');

const router = express.Router();
const db = getDb();

router.use(authenticateToken);

const PAYMENT_METHODS = ['cash', 'card', 'transfer', 'momo'];
const PAYMENT_STATUSES = ['pending', 'completed', 'cancelled', 'refunded'];
const ALLOWED_STATUS_TRANSITIONS = {
    pending: ['completed', 'cancelled'],
    completed: ['refunded', 'cancelled'],
    cancelled: [],
    refunded: []
};

function restockSale(
    saleId,
    warehouseId,
    userId,
    referenceType,
    kind = 'refund',
    stockChanges
) {
    for (const item of returnableItems(saleId)) {
        if (item.remaining_quantity > 0)
            creditItem(
                item,
                item.remaining_quantity,
                userId,
                kind === 'cancellation' ? 'Sale cancelled' : 'Sale refunded',
                kind,
                stockChanges
            );
    }
}

router.get('/', (req, res) => {
    try {
        const {
            customer_id,
            start_date,
            end_date,
            payment_status,
            warehouse_id,
            search,
            limit = 100,
            offset = 0
        } = req.query;
        let query = `SELECT s.*, c.name as customer_name, w.name as warehouse_name,
            (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) as item_count
            FROM sales s LEFT JOIN customers c ON s.customer_id = c.id LEFT JOIN warehouses w ON s.warehouse_id = w.id WHERE 1=1`;
        const params = [];
        if (req.query.returnable === 'true')
            query += ` AND s.payment_status IN ('pending','completed') AND EXISTS (SELECT 1 FROM sale_items ri WHERE ri.sale_id=s.id AND ri.quantity>(SELECT COALESCE(SUM(quantity),0) FROM sale_returns WHERE sale_item_id=ri.id))`;
        if (customer_id) {
            query += ' AND s.customer_id = ?';
            params.push(customer_id);
        }
        if (start_date) {
            query += ' AND s.sale_date >= ?';
            params.push(start_date);
        }
        if (end_date) {
            query += ' AND s.sale_date <= ?';
            params.push(end_date + ' 23:59:59');
        }
        if (payment_status) {
            if (!PAYMENT_STATUSES.includes(payment_status))
                return res
                    .status(400)
                    .json({ error: 'Invalid payment status' });
            query += ' AND s.payment_status = ?';
            params.push(payment_status);
        }
        if (warehouse_id) {
            query += ' AND s.warehouse_id = ?';
            params.push(warehouse_id);
        }
        if (search) {
            query +=
                ' AND (c.name LIKE ? OR s.payment_method LIKE ? OR s.notes LIKE ? OR s.id LIKE ?)';
            params.push(
                `%${search}%`,
                `%${search}%`,
                `%${search}%`,
                `%${search}%`
            );
        }
        query += ' ORDER BY s.sale_date DESC, s.rowid DESC LIMIT ? OFFSET ?';
        params.push(parseLimit(limit, 100), parseOffset(offset));
        res.json(db.prepare(query).all(...params));
    } catch (err) {
        sendSafeError(res, err, '[sales]');
    }
});

router.get('/export', (req, res) => {
    try {
        const { start_date, end_date, warehouse_id } = req.query;
        let query = `SELECT s.*, c.name as customer_name, w.name as warehouse_name
            FROM sales s LEFT JOIN customers c ON s.customer_id = c.id LEFT JOIN warehouses w ON s.warehouse_id = w.id WHERE 1=1`;
        const params = [];
        if (start_date) {
            query += ' AND s.sale_date >= ?';
            params.push(start_date);
        }
        if (end_date) {
            query += ' AND s.sale_date <= ?';
            params.push(end_date + ' 23:59:59');
        }
        if (warehouse_id) {
            query += ' AND s.warehouse_id = ?';
            params.push(warehouse_id);
        }
        query += ' ORDER BY s.sale_date ASC';
        const rows = db.prepare(query).all(...params);

        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Sales');
        ws.columns = [
            { header: 'Date', key: 'date', width: 20 },
            { header: 'Customer', key: 'customer', width: 25 },
            { header: 'Warehouse', key: 'warehouse', width: 20 },
            { header: 'Subtotal (₵)', key: 'subtotal', width: 15 },
            { header: 'Discount (₵)', key: 'discount', width: 15 },
            { header: 'Markup (₵)', key: 'markup', width: 15 },
            { header: 'Total (₵)', key: 'total', width: 15 },
            { header: 'Payment', key: 'payment_method', width: 15 },
            { header: 'Status', key: 'payment_status', width: 15 }
        ];
        rows.forEach((s) =>
            ws.addRow({
                date: new Date(s.sale_date).toLocaleString(),
                customer: sanitizeCell(s.customer_name || 'Walk-in'),
                warehouse: sanitizeCell(s.warehouse_name),
                subtotal: s.subtotal,
                discount: s.discount,
                markup: s.markup,
                total: s.total,
                payment_method: s.payment_method,
                payment_status: s.payment_status
            })
        );
        ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
        ws.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: '1E40AF' }
        };
        ['subtotal', 'discount', 'markup', 'total'].forEach(
            (k) => (ws.getColumn(k).numFmt = '₵#,##0.00')
        );
        const filename = `VEEMENZ-Sales-${new Date().toISOString().split('T')[0]}.xlsx`;
        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${filename}"`
        );
        return workbook.xlsx.write(res).then(() => res.end());
    } catch (err) {
        sendSafeError(res, err, '[sales]');
    }
});

router.get('/:id', (req, res) => {
    try {
        const sale = db
            .prepare(
                `SELECT s.*, c.name as customer_name, c.email as customer_email, c.phone as customer_phone,
                    c.address as customer_address, c.city as customer_city, c.state as customer_state,
                    c.postal_code as customer_postal_code, c.country as customer_country, c.tax_id as customer_tax_id,
                    w.name as warehouse_name, w.code as warehouse_code
             FROM sales s LEFT JOIN customers c ON s.customer_id = c.id LEFT JOIN warehouses w ON s.warehouse_id = w.id
             WHERE s.id = ?`
            )
            .get(req.params.id);
        if (!sale) return res.status(404).json({ error: 'Sale not found' });
        const items = returnableItems(req.params.id);
        res.json({ ...sale, items });
    } catch (err) {
        sendSafeError(res, err, '[sales]');
    }
});

router.get('/:id/receipt', (req, res) => {
    try {
        const sale = db
            .prepare(
                `SELECT s.*, c.name as customer_name, c.email as customer_email, c.phone as customer_phone,
                    c.address as customer_address, c.city as customer_city, c.state as customer_state,
                    c.postal_code as customer_postal_code, c.country as customer_country, c.tax_id as customer_tax_id,
                    w.name as warehouse_name, w.code as warehouse_code
             FROM sales s LEFT JOIN customers c ON s.customer_id = c.id LEFT JOIN warehouses w ON s.warehouse_id = w.id
             WHERE s.id = ?`
            )
            .get(req.params.id);
        if (!sale) return res.status(404).json({ error: 'Sale not found' });
        const items = db
            .prepare(
                `SELECT si.*, p.name as product_name FROM sale_items si JOIN products p ON si.product_id = p.id WHERE si.sale_id = ?`
            )
            .all(req.params.id);
        const settings = db.prepare('SELECT key, value FROM settings').all();
        const settingsObj = {};
        settings.forEach((s) => {
            settingsObj[s.key] = s.value;
        });
        res.json(generateReceipt(sale, items, settingsObj));
    } catch (err) {
        sendSafeError(res, err, '[sales]');
    }
});

function generateReceipt(sale, items, settings) {
    const formatItemType = (item) => {
        if (item.unit_type === 'carton') {
            const upc =
                item.units_per_carton ||
                items.find(
                    (i) =>
                        i.product_id === item.product_id && i.units_per_carton
                )?.units_per_carton ||
                0;
            return upc > 0
                ? `Carton (${upc} units)`
                : 'Carton (size not recorded)';
        }
        if (item.unit_type === 'liter20') return '20L Container';
        return 'Unit';
    };
    return {
        receipt_number: sale.id.slice(0, 8).toUpperCase(),
        date: new Date(sale.sale_date).toLocaleDateString(),
        time: new Date(sale.sale_date).toLocaleTimeString(),
        company: {
            name: settings.company_name || 'VEEMENZ',
            address: settings.company_address || '',
            phone: settings.company_phone || '',
            email: settings.company_email || ''
        },
        warehouse: { name: sale.warehouse_name, code: sale.warehouse_code },
        customer: {
            name: sale.customer_name || 'Walk-in Customer',
            email: sale.customer_email,
            phone: sale.customer_phone,
            address: [
                sale.customer_address,
                sale.customer_city,
                sale.customer_state,
                sale.customer_postal_code,
                sale.customer_country
            ]
                .filter(Boolean)
                .join(', '),
            tax_id: sale.customer_tax_id
        },
        items: items.map((i) => ({
            product_name: i.product_name,
            unit_type: formatItemType(i),
            quantity: i.quantity,
            unit_price: i.unit_price,
            extra: i.extra,
            discount: i.discount,
            line_total: i.line_total,
            net_total: i.net_total_cents / 100
        })),
        subtotal: sale.subtotal,
        markup: sale.markup,
        discount: sale.discount,
        discount_type: sale.discount_type,
        total: sale.total,
        payment_method: sale.payment_method,
        payment_status: sale.payment_status,
        notes: sale.notes
    };
}

router.post('/', (req, res) => {
    try {
        const result = createSale(req);
        res.status(result.replay ? 200 : 201).json(result.body);
    } catch (err) {
        sendSafeError(res, err, '[sales] create');
    }
});

function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
}

function applyStatusChange(saleId, nextStatus, userId) {
    const sale = db
        .prepare(
            'SELECT id, warehouse_id, payment_status FROM sales WHERE id = ?'
        )
        .get(saleId);
    if (!sale) throw new ClientError(404, 'Sale not found');
    if (sale.payment_status === nextStatus)
        throw new ClientError(400, 'Payment status is already set');
    const allowed = ALLOWED_STATUS_TRANSITIONS[sale.payment_status] || [];
    if (!allowed.includes(nextStatus)) {
        throw new ClientError(400, 'Invalid payment status transition');
    }

    const stockChanges = new Map();
    const shouldRestock =
        nextStatus === 'cancelled' || nextStatus === 'refunded';
    const transaction = db.transaction(() => {
        const result = db
            .prepare(
                'UPDATE sales SET payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND payment_status = ?'
            )
            .run(nextStatus, saleId, sale.payment_status);
        if (result.changes === 0)
            throw new ClientError(409, 'Sale was updated by another request');
        if (shouldRestock)
            restockSale(
                saleId,
                sale.warehouse_id,
                userId,
                'sale_return',
                nextStatus === 'cancelled' ? 'cancellation' : 'refund',
                stockChanges
            );
    });
    transaction();
    publishStockChanges(stockChanges);
    return sale;
}

router.put('/:id/payment-status', authenticateToken, (req, res) => {
    try {
        const { payment_status } = req.body;
        if (!PAYMENT_STATUSES.includes(payment_status))
            return res.status(400).json({ error: 'Invalid payment status' });

        const sale = db
            .prepare('SELECT id, payment_status FROM sales WHERE id = ?')
            .get(req.params.id);
        if (!sale) return res.status(404).json({ error: 'Sale not found' });

        const isMarkPaid =
            sale.payment_status === 'pending' && payment_status === 'completed';
        if (!isMarkPaid && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        applyStatusChange(req.params.id, payment_status, req.user.id);
        logAudit(req.user.id, 'sale.status', 'sale', req.params.id, {
            payment_status
        });
        res.json({ message: 'Payment status updated' });
    } catch (err) {
        sendSafeError(res, err, '[sales]');
    }
});

router.delete('/:id', requireAdmin, (req, res) => {
    try {
        applyStatusChange(req.params.id, 'cancelled', req.user.id);
        logAudit(req.user.id, 'sale.cancel', 'sale', req.params.id);
        res.json({ message: 'Sale cancelled and stock restored' });
    } catch (err) {
        sendSafeError(res, err, '[sales]');
    }
});

module.exports = router;
