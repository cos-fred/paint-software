const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authenticateToken, requireAdmin } = require('../auth');
const { logAudit } = require('../services/audit');

const router = express.Router();
const db = getDb();

router.use(authenticateToken);

function getTaxRate() {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'tax_rate'").get();
    return parseFloat(row?.value) || 0.10;
}

function getCustomerBalance(customerId) {
    if (!customerId) return 0;
    const credit = db.prepare("SELECT COALESCE(SUM(total), 0) as total FROM sales WHERE customer_id = ? AND payment_method = 'credit' AND payment_status != 'cancelled'").get(customerId).total;
    const paid = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE customer_id = ?").get(customerId).total;
    return credit - paid;
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
        if (payment_status) { query += ' AND s.payment_status = ?'; params.push(payment_status); }
        if (warehouse_id) { query += ' AND s.warehouse_id = ?'; params.push(warehouse_id); }
        if (search) { query += ' AND (c.name LIKE ? OR s.payment_method LIKE ? OR s.notes LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
        query += ' ORDER BY s.sale_date DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));
        res.json(db.prepare(query).all(...params));
    } catch (err) {
        console.error(err); res.status(500).json({ error: 'Something went wrong' });
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
        console.error(err); res.status(500).json({ error: 'Something went wrong' });
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
        console.error(err); res.status(500).json({ error: 'Something went wrong' });
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
        console.error(err); res.status(500).json({ error: 'Something went wrong' });
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

        const saleId = uuidv4();
        let subtotal = 0;
        const validatedItems = [];

        for (const item of items) {
            const stockField = `${item.unit_type}_stock`;
            const row = db.prepare(`SELECT ${stockField} as stock, name, ${item.unit_type}_price as price FROM product_stock ps JOIN products p ON ps.product_id = p.id WHERE ps.product_id = ? AND ps.warehouse_id = ?`).get(item.product_id, warehouse_id);
            if (!row) throw new Error(`Product ${item.product_id} not found in warehouse`);
            if (row.stock < item.quantity) throw new Error(`Insufficient stock for ${row.name} (${item.unit_type}): ${row.stock} available, ${item.quantity} requested`);

            const unitPrice = item.unit_price != null ? item.unit_price : row.price;
            const gross = item.quantity * unitPrice;
            const lineDiscount = item.discount || 0;
            const lineTotal = Math.max(0, gross - lineDiscount);
            subtotal += lineTotal;
            validatedItems.push({ ...item, unit_price: unitPrice, discount: lineDiscount, line_total: lineTotal });
        }

        const taxRate = getTaxRate();
        const tax = subtotal * taxRate;
        const discountAmount = computeDiscount(discount || 0, discount_type || 'amount', subtotal);
        const total = Math.max(0, subtotal + tax - discountAmount);

        const transaction = db.transaction(() => {
            db.prepare(
                `INSERT INTO sales (id, customer_id, warehouse_id, subtotal, tax, discount, discount_type, total, payment_method, payment_status, notes, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(saleId, customer_id || null, warehouse_id, subtotal, tax, discountAmount, discount_type || 'amount', total, payment_method || 'cash', payment_status || 'completed', notes || null, req.user.id);

            for (const item of validatedItems) {
                const itemId = uuidv4();
                const stockField = `${item.unit_type}_stock`;
                db.prepare(`INSERT INTO sale_items (id, sale_id, product_id, warehouse_id, unit_type, quantity, unit_price, discount, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(itemId, saleId, item.product_id, warehouse_id, item.unit_type, item.quantity, item.unit_price, item.discount, item.line_total);
                db.prepare(`UPDATE product_stock SET ${stockField} = ${stockField} - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND warehouse_id = ?`).run(item.quantity, item.product_id, warehouse_id);
                db.prepare(`INSERT INTO stock_movements (id, product_id, warehouse_id, movement_type, unit_type, quantity, reference_id, reference_type, created_by) VALUES (?, ?, ?, 'out', ?, ?, ?, 'sale', ?)`)
                    .run(uuidv4(), item.product_id, warehouse_id, item.unit_type, item.quantity, saleId, req.user.id);

                const productRow = db.prepare(`SELECT ${stockField} as stock, low_stock_threshold, name FROM products p JOIN product_stock ps ON p.id = ps.product_id WHERE p.id = ? AND ps.warehouse_id = ?`).get(item.product_id, warehouse_id);
                if (productRow && productRow.stock <= productRow.low_stock_threshold) {
                    db.prepare(`INSERT INTO alerts (id, type, product_id, warehouse_id, message, severity) VALUES (?, ?, ?, ?, ?, ?)`)
                        .run(uuidv4(), 'low_stock', item.product_id, warehouse_id, `Low stock alert: ${productRow.name} (${item.unit_type}) has ${productRow.stock} remaining`, 'warning');
                }
            }
        });
        transaction();

        logAudit(req.user.id, 'sale.create', 'sale', saleId, { total, payment_method: payment_method || 'cash' });
        res.status(201).json({ id: saleId, total, message: 'Sale completed successfully' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

function computeDiscount(discount, type, subtotal) {
    if (type === 'percent') return Math.min(subtotal, subtotal * (discount / 100));
    return discount;
}

router.put('/:id/payment-status', requireAdmin, (req, res) => {
    try {
        const { payment_status } = req.body;
        const valid = ['pending', 'completed', 'cancelled', 'refunded'];
        if (!valid.includes(payment_status)) return res.status(400).json({ error: 'Invalid payment status' });
        const result = db.prepare('UPDATE sales SET payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(payment_status, req.params.id);
        if (result.changes === 0) return res.status(404).json({ error: 'Sale not found' });
        logAudit(req.user.id, 'sale.status', 'sale', req.params.id, { payment_status });
        res.json({ message: 'Payment status updated' });
    } catch (err) {
        console.error(err); res.status(500).json({ error: 'Something went wrong' });
    }
});

router.delete('/:id', requireAdmin, (req, res) => {
    try {
        const sale = db.prepare('SELECT warehouse_id FROM sales WHERE id = ?').get(req.params.id);
        if (!sale) return res.status(404).json({ error: 'Sale not found' });
        const items = db.prepare('SELECT product_id, unit_type, quantity FROM sale_items WHERE sale_id = ?').all(req.params.id);

        const transaction = db.transaction(() => {
            for (const item of items) {
                const stockField = `${item.unit_type}_stock`;
                db.prepare(`UPDATE product_stock SET ${stockField} = ${stockField} + ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND warehouse_id = ?`).run(item.quantity, item.product_id, sale.warehouse_id);
                db.prepare(`INSERT INTO stock_movements (id, product_id, warehouse_id, movement_type, unit_type, quantity, reference_id, reference_type, created_by) VALUES (?, ?, ?, 'in', ?, ?, ?, 'sale_return', ?)`)
                    .run(uuidv4(), item.product_id, sale.warehouse_id, item.unit_type, item.quantity, req.params.id, req.user.id);
            }
            db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(req.params.id);
            db.prepare('DELETE FROM sales WHERE id = ?').run(req.params.id);
        });
        transaction();
        logAudit(req.user.id, 'sale.delete', 'sale', req.params.id);
        res.json({ message: 'Sale deleted and stock restored' });
    } catch (err) {
        console.error(err); res.status(500).json({ error: 'Something went wrong' });
    }
});

module.exports = router;