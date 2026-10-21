const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authenticateToken, requireAdmin } = require('../auth');
const { logAudit } = require('../services/audit');
const { checkLowStock } = require('../services/low-stock');
const { stockColumn, priceColumn, UNIT_TYPES } = require('../lib/stock');
const { ClientError, sendSafeError } = require('../lib/errors');

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

function getTaxRate() {
    const enabled = db.prepare("SELECT value FROM settings WHERE key = 'tax_enabled'").get();
    if (enabled && enabled.value === 'false') return 0;
    const row = db.prepare("SELECT value FROM settings WHERE key = 'tax_rate'").get();
    const parsed = parseFloat(row?.value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function restockSale(saleId, warehouseId, userId, referenceType) {
    const items = db.prepare('SELECT product_id, unit_type, quantity FROM sale_items WHERE sale_id = ?').all(saleId);
    for (const item of items) {
        const field = stockColumn(item.unit_type);
        const returned = db.prepare(
            'SELECT COALESCE(SUM(quantity), 0) as q FROM sale_returns WHERE sale_id = ? AND product_id = ? AND unit_type = ?'
        ).get(saleId, item.product_id, item.unit_type).q;
        const qty = item.quantity - returned;
        if (qty <= 0) continue;
        db.prepare(
            `UPDATE product_stock SET ${field} = ${field} + ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND warehouse_id = ?`
        ).run(qty, item.product_id, warehouseId);
        db.prepare(
            `INSERT INTO stock_movements (id, product_id, warehouse_id, movement_type, unit_type, quantity, reference_id, reference_type, created_by)
             VALUES (?, ?, ?, 'in', ?, ?, ?, ?, ?)`
        ).run(uuidv4(), item.product_id, warehouseId, item.unit_type, qty, saleId, referenceType, userId);
    }
}

router.get('/', (req, res) => {
    try {
        const { customer_id, start_date, end_date, payment_status, warehouse_id, search, limit = 100, offset = 0 } = req.query;
        let query = `SELECT s.*, c.name as customer_name, w.name as warehouse_name,
            (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) as item_count
            FROM sales s LEFT JOIN customers c ON s.customer_id = c.id LEFT JOIN warehouses w ON s.warehouse_id = w.id WHERE 1=1`;
        const params = [];
        if (customer_id) { query += ' AND s.customer_id = ?'; params.push(customer_id); }
        if (start_date) { query += ' AND s.sale_date >= ?'; params.push(start_date); }
        if (end_date) { query += ' AND s.sale_date <= ?'; params.push(end_date + ' 23:59:59'); }
        if (payment_status) {
            if (!PAYMENT_STATUSES.includes(payment_status)) return res.status(400).json({ error: 'Invalid payment status' });
            query += ' AND s.payment_status = ?';
            params.push(payment_status);
        }
        if (warehouse_id) { query += ' AND s.warehouse_id = ?'; params.push(warehouse_id); }
        if (search) { query += ' AND (c.name LIKE ? OR s.payment_method LIKE ? OR s.notes LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
        query += ' ORDER BY s.sale_date DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit, 10) || 100, parseInt(offset, 10) || 0);
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
        if (start_date) { query += ' AND s.sale_date >= ?'; params.push(start_date); }
        if (end_date) { query += ' AND s.sale_date <= ?'; params.push(end_date + ' 23:59:59'); }
        if (warehouse_id) { query += ' AND s.warehouse_id = ?'; params.push(warehouse_id); }
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
            { header: 'Tax (₵)', key: 'tax', width: 12 },
            { header: 'Discount (₵)', key: 'discount', width: 15 },
            { header: 'Total (₵)', key: 'total', width: 15 },
            { header: 'Payment', key: 'payment_method', width: 15 },
            { header: 'Status', key: 'payment_status', width: 15 }
        ];
        rows.forEach(s => ws.addRow({ date: new Date(s.sale_date).toLocaleString(), customer: s.customer_name || 'Walk-in', warehouse: s.warehouse_name, subtotal: s.subtotal, tax: s.tax, discount: s.discount, total: s.total, payment_method: s.payment_method, payment_status: s.payment_status }));
        ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
        ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1E40AF' } };
        ['subtotal', 'tax', 'discount', 'total'].forEach(k => ws.getColumn(k).numFmt = '₵#,##0.00');
        const filename = `VEEMENZ-Sales-${new Date().toISOString().split('T')[0]}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return workbook.xlsx.write(res).then(() => res.end());
    } catch (err) {
        sendSafeError(res, err, '[sales]');
    }
});

router.get('/:id', (req, res) => {
    try {
        const sale = db.prepare(
            `SELECT s.*, c.name as customer_name, c.email as customer_email, c.phone as customer_phone,
                    c.address as customer_address, c.city as customer_city, c.state as customer_state,
                    c.postal_code as customer_postal_code, c.country as customer_country, c.tax_id as customer_tax_id,
                    w.name as warehouse_name, w.code as warehouse_code
             FROM sales s LEFT JOIN customers c ON s.customer_id = c.id LEFT JOIN warehouses w ON s.warehouse_id = w.id
             WHERE s.id = ?`
        ).get(req.params.id);
        if (!sale) return res.status(404).json({ error: 'Sale not found' });
        const items = db.prepare(`SELECT si.*, p.name as product_name FROM sale_items si JOIN products p ON si.product_id = p.id WHERE si.sale_id = ?`).all(req.params.id);
        res.json({ ...sale, items });
    } catch (err) {
        sendSafeError(res, err, '[sales]');
    }
});

router.get('/:id/receipt', (req, res) => {
    try {
        const sale = db.prepare(
            `SELECT s.*, c.name as customer_name, c.email as customer_email, c.phone as customer_phone,
                    c.address as customer_address, c.city as customer_city, c.state as customer_state,
                    c.postal_code as customer_postal_code, c.country as customer_country, c.tax_id as customer_tax_id,
                    w.name as warehouse_name, w.code as warehouse_code
             FROM sales s LEFT JOIN customers c ON s.customer_id = c.id LEFT JOIN warehouses w ON s.warehouse_id = w.id
             WHERE s.id = ?`
        ).get(req.params.id);
        if (!sale) return res.status(404).json({ error: 'Sale not found' });
        const items = db.prepare(`SELECT si.*, p.name as product_name FROM sale_items si JOIN products p ON si.product_id = p.id WHERE si.sale_id = ?`).all(req.params.id);
        const settings = db.prepare('SELECT key, value FROM settings').all();
        const settingsObj = {};
        settings.forEach(s => { settingsObj[s.key] = s.value; });
        res.json(generateReceipt(sale, items, settingsObj));
    } catch (err) {
        sendSafeError(res, err, '[sales]');
    }
});

function generateReceipt(sale, items, settings) {
    const unitLabels = { unit: 'Unit', carton: 'Carton (12 units)', liter20: '20L Container' };
    return {
        receipt_number: sale.id.slice(0, 8).toUpperCase(),
        date: new Date(sale.sale_date).toLocaleDateString(),
        time: new Date(sale.sale_date).toLocaleTimeString(),
        company: { name: settings.company_name || 'VEEMENZ', address: settings.company_address || '', phone: settings.company_phone || '', email: settings.company_email || '' },
        warehouse: { name: sale.warehouse_name, code: sale.warehouse_code },
        customer: {
            name: sale.customer_name || 'Walk-in Customer', email: sale.customer_email, phone: sale.customer_phone,
            address: [sale.customer_address, sale.customer_city, sale.customer_state, sale.customer_postal_code, sale.customer_country].filter(Boolean).join(', '),
            tax_id: sale.customer_tax_id
        },
        items: items.map(i => ({ product_name: i.product_name, unit_type: unitLabels[i.unit_type] || i.unit_type, quantity: i.quantity, unit_price: i.unit_price, discount: i.discount, line_total: i.line_total })),
        subtotal: sale.subtotal, tax: sale.tax, discount: sale.discount, discount_type: sale.discount_type,
        total: sale.total, payment_method: sale.payment_method, payment_status: sale.payment_status, notes: sale.notes
    };
}

router.post('/', (req, res) => {
    try {
        const { customer_id, warehouse_id, items, payment_method, payment_status, discount, discount_type, notes } = req.body;
        if (!warehouse_id) return res.status(400).json({ error: 'Warehouse is required' });
        if (!items || items.length === 0) return res.status(400).json({ error: 'At least one item is required' });

        const method = payment_method || 'cash';
        const status = payment_status || 'completed';
        if (!PAYMENT_METHODS.includes(method)) return res.status(400).json({ error: 'Invalid payment method' });
        if (!PAYMENT_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid payment status' });
        if (status === 'cancelled' || status === 'refunded') {
            return res.status(400).json({ error: 'New sales cannot start as cancelled or refunded' });
        }

        const saleId = uuidv4();
        let subtotal = 0;
        const validatedItems = [];

        for (const item of items) {
            if (!UNIT_TYPES.includes(item.unit_type)) throw new ClientError(400, 'Invalid unit type');
            const quantity = Number.parseInt(item.quantity, 10);
            if (!Number.isInteger(quantity) || quantity <= 0) throw new ClientError(400, 'Quantity must be a positive integer');

            const stockField = stockColumn(item.unit_type);
            const priceField = priceColumn(item.unit_type);
            const row = db.prepare(
                `SELECT ps.${stockField} as stock, p.name, p.${priceField} as price
                 FROM product_stock ps JOIN products p ON ps.product_id = p.id
                 WHERE ps.product_id = ? AND ps.warehouse_id = ?`
            ).get(item.product_id, warehouse_id);
            if (!row) throw new ClientError(400, 'Product not found in warehouse');
            if (row.stock < quantity) throw new ClientError(400, `Insufficient stock for ${row.name}`);

            const unitPrice = item.unit_price != null ? Number(item.unit_price) : row.price;
            if (!(unitPrice >= 0)) throw new ClientError(400, 'Invalid unit price');
            const gross = quantity * unitPrice;
            const lineDiscount = item.discount || 0;
            const lineTotal = Math.max(0, gross - lineDiscount);
            subtotal += lineTotal;
            validatedItems.push({ ...item, quantity, unit_price: unitPrice, discount: lineDiscount, line_total: lineTotal, oldStock: row.stock });
        }

        const taxRate = getTaxRate();
        const tax = subtotal * taxRate;
        const discountAmount = computeDiscount(discount || 0, discount_type || 'amount', subtotal);
        const total = Math.max(0, subtotal + tax - discountAmount);

        const transaction = db.transaction(() => {
            db.prepare(
                `INSERT INTO sales (id, customer_id, warehouse_id, subtotal, tax, discount, discount_type, total, payment_method, payment_status, notes, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(saleId, customer_id || null, warehouse_id, subtotal, tax, discountAmount, discount_type || 'amount', total, method, status, notes || null, req.user.id);

            for (const item of validatedItems) {
                const itemId = uuidv4();
                const stockField = stockColumn(item.unit_type);
                db.prepare(`INSERT INTO sale_items (id, sale_id, product_id, warehouse_id, unit_type, quantity, unit_price, discount, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(itemId, saleId, item.product_id, warehouse_id, item.unit_type, item.quantity, item.unit_price, item.discount, item.line_total);
                const deducted = db.prepare(
                    `UPDATE product_stock SET ${stockField} = ${stockField} - ?, updated_at = CURRENT_TIMESTAMP
                     WHERE product_id = ? AND warehouse_id = ? AND ${stockField} >= ?`
                ).run(item.quantity, item.product_id, warehouse_id, item.quantity);
                if (deducted.changes === 0) throw new ClientError(400, 'Insufficient stock');
                db.prepare(`INSERT INTO stock_movements (id, product_id, warehouse_id, movement_type, unit_type, quantity, reference_id, reference_type, created_by) VALUES (?, ?, ?, 'out', ?, ?, ?, 'sale', ?)`)
                    .run(uuidv4(), item.product_id, warehouse_id, item.unit_type, item.quantity, saleId, req.user.id);
            }
        });
        transaction();

        for (const item of validatedItems) {
            checkLowStock(item.product_id, warehouse_id, item.unit_type, item.oldStock - item.quantity, item.oldStock);
        }

        logAudit(req.user.id, 'sale.create', 'sale', saleId, { total, payment_method: method });
        res.status(201).json({ id: saleId, total, message: 'Sale completed successfully' });
    } catch (err) {
        sendSafeError(res, err, '[sales] create');
    }
});

function computeDiscount(discount, type, subtotal) {
    if (type === 'percent') return Math.min(subtotal, subtotal * (discount / 100));
    return discount;
}

function applyStatusChange(saleId, nextStatus, userId) {
    const sale = db.prepare('SELECT id, warehouse_id, payment_status FROM sales WHERE id = ?').get(saleId);
    if (!sale) throw new ClientError(404, 'Sale not found');
    if (sale.payment_status === nextStatus) throw new ClientError(400, 'Payment status is already set');
    const allowed = ALLOWED_STATUS_TRANSITIONS[sale.payment_status] || [];
    if (!allowed.includes(nextStatus)) {
        throw new ClientError(400, 'Invalid payment status transition');
    }

    const shouldRestock = nextStatus === 'cancelled' || nextStatus === 'refunded';
    const transaction = db.transaction(() => {
        const result = db.prepare(
            'UPDATE sales SET payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND payment_status = ?'
        ).run(nextStatus, saleId, sale.payment_status);
        if (result.changes === 0) throw new ClientError(409, 'Sale was updated by another request');
        if (shouldRestock) restockSale(saleId, sale.warehouse_id, userId, nextStatus === 'refunded' ? 'sale_return' : 'sale_return');
    });
    transaction();
    return sale;
}

router.put('/:id/payment-status', authenticateToken, (req, res) => {
    try {
        const { payment_status } = req.body;
        if (!PAYMENT_STATUSES.includes(payment_status)) return res.status(400).json({ error: 'Invalid payment status' });

        const sale = db.prepare('SELECT id, payment_status FROM sales WHERE id = ?').get(req.params.id);
        if (!sale) return res.status(404).json({ error: 'Sale not found' });

        const isMarkPaid = sale.payment_status === 'pending' && payment_status === 'completed';
        if (!isMarkPaid && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        applyStatusChange(req.params.id, payment_status, req.user.id);
        logAudit(req.user.id, 'sale.status', 'sale', req.params.id, { payment_status });
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
