const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authenticateToken } = require('../auth');

const router = express.Router();
const db = getDb();

router.use(authenticateToken);

router.get('/', (req, res) => {
    try {
        const { customer_id, start_date, end_date, payment_status, warehouse_id, search, limit = 100, offset = 0 } = req.query;
        let query = `SELECT s.*, c.name as customer_name, w.name as warehouse_name,
            (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) as item_count
            FROM sales s LEFT JOIN customers c ON s.customer_id = c.id LEFT JOIN warehouses w ON s.warehouse_id = w.id WHERE 1=1`;
        const params = [];

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
            params.push(end_date);
        }
        if (payment_status) {
            query += ' AND s.payment_status = ?';
            params.push(payment_status);
        }
        if (warehouse_id) {
            query += ' AND s.warehouse_id = ?';
            params.push(warehouse_id);
        }
        if (search) {
            query += ' AND (c.name LIKE ? OR s.payment_method LIKE ? OR s.notes LIKE ?)';
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        query += ' ORDER BY s.sale_date DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const rows = db.prepare(query).all(...params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.get('/:id', (req, res) => {
    try {
        const sale = db.prepare(
            `SELECT s.*, c.name as customer_name, c.email as customer_email, c.phone as customer_phone,
                    c.address as customer_address, c.city as customer_city, c.state as customer_state,
                    c.postal_code as customer_postal_code, c.country as customer_country, c.tax_id as customer_tax_id,
                    w.name as warehouse_name, w.code as warehouse_code
             FROM sales s
             LEFT JOIN customers c ON s.customer_id = c.id
             LEFT JOIN warehouses w ON s.warehouse_id = w.id
             WHERE s.id = ?`
        ).get(req.params.id);

        if (!sale) return res.status(404).json({ error: 'Sale not found' });

        const items = db.prepare(
            `SELECT si.*, p.name as product_name, p.unit_price, p.carton_price, p.liter20_price
             FROM sale_items si
             JOIN products p ON si.product_id = p.id
             WHERE si.sale_id = ?`
        ).all(req.params.id);

        res.json({ ...sale, items });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/:id/receipt', (req, res) => {
    try {
        const sale = db.prepare(
            `SELECT s.*, c.name as customer_name, c.email as customer_email, c.phone as customer_phone,
                    c.address as customer_address, c.city as customer_city, c.state as customer_state,
                    c.postal_code as customer_postal_code, c.country as customer_country, c.tax_id as customer_tax_id,
                    w.name as warehouse_name, w.code as warehouse_code
             FROM sales s
             LEFT JOIN customers c ON s.customer_id = c.id
             LEFT JOIN warehouses w ON s.warehouse_id = w.id
             WHERE s.id = ?`
        ).get(req.params.id);

        if (!sale) return res.status(404).json({ error: 'Sale not found' });

        const items = db.prepare(
            `SELECT si.*, p.name as product_name
             FROM sale_items si
             JOIN products p ON si.product_id = p.id
             WHERE si.sale_id = ?`
        ).all(req.params.id);

        const settings = db.prepare('SELECT key, value FROM settings').all();
        const settingsObj = {};
        settings.forEach(s => { settingsObj[s.key] = s.value; });

        const receipt = generateReceipt(sale, items, settingsObj);
        res.json(receipt);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function generateReceipt(sale, items, settings) {
    const unitLabels = { unit: 'Unit', carton: 'Carton (12 units)', liter20: '20L Container' };
    
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
        warehouse: {
            name: sale.warehouse_name,
            code: sale.warehouse_code
        },
        customer: {
            name: sale.customer_name || 'Walk-in Customer',
            email: sale.customer_email,
            phone: sale.customer_phone,
            address: [sale.customer_address, sale.customer_city, sale.customer_state, sale.customer_postal_code, sale.customer_country].filter(Boolean).join(', '),
            tax_id: sale.customer_tax_id
        },
        items: items.map(item => ({
            product_name: item.product_name,
            unit_type: unitLabels[item.unit_type] || item.unit_type,
            quantity: item.quantity,
            unit_price: item.unit_price,
            line_total: item.line_total
        })),
        subtotal: sale.subtotal,
        tax: sale.tax,
        discount: sale.discount,
        total: sale.total,
        payment_method: sale.payment_method,
        payment_status: sale.payment_status,
        notes: sale.notes
    };
}

router.post('/', (req, res) => {
    try {
        const { customer_id, warehouse_id, items, payment_method, payment_status, discount, notes } = req.body;

        if (!warehouse_id) {
            return res.status(400).json({ error: 'Warehouse is required' });
        }
        if (!items || items.length === 0) {
            return res.status(400).json({ error: 'At least one item is required' });
        }

        const saleId = uuidv4();
        let subtotal = 0;

        const validatedItems = [];
        for (const item of items) {
            const stockField = `${item.unit_type}_stock`;
            const row = db.prepare(`SELECT ${stockField} as stock, name, ${item.unit_type}_price as price FROM product_stock ps JOIN products p ON ps.product_id = p.id WHERE ps.product_id = ? AND ps.warehouse_id = ?`).get(item.product_id, warehouse_id);
            if (!row) throw new Error(`Product ${item.product_id} not found in warehouse`);
            if (row.stock < item.quantity) {
                throw new Error(`Insufficient stock for ${row.name} (${item.unit_type}) in warehouse: ${row.stock} available, ${item.quantity} requested`);
            }
            const lineTotal = item.quantity * (item.unit_price || row.price);
            subtotal += lineTotal;
            validatedItems.push({ ...item, line_total: lineTotal, unit_price: item.unit_price || row.price });
        }

        const taxRate = parseFloat(process.env.TAX_RATE) || 0.10;
        const tax = subtotal * taxRate;
        const discountAmount = discount || 0;
        const total = subtotal + tax - discountAmount;

        const transaction = db.transaction(() => {
            db.prepare(
                `INSERT INTO sales (id, customer_id, warehouse_id, subtotal, tax, discount, total, payment_method, payment_status, notes, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(saleId, customer_id || null, warehouse_id, subtotal, tax, discountAmount, total, payment_method || 'cash', payment_status || 'completed', notes, req.user.id);

            for (const item of validatedItems) {
                const itemId = uuidv4();
                const stockField = `${item.unit_type}_stock`;
                
                db.prepare(
                    `INSERT INTO sale_items (id, sale_id, product_id, warehouse_id, unit_type, quantity, unit_price, line_total)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                ).run(itemId, saleId, item.product_id, warehouse_id, item.unit_type, item.quantity, item.unit_price, item.line_total);
                
                db.prepare(`UPDATE product_stock SET ${stockField} = ${stockField} - ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND warehouse_id = ?`).run(item.quantity, item.product_id, warehouse_id);
                
                const movementId = uuidv4();
                db.prepare(
                    `INSERT INTO stock_movements (id, product_id, warehouse_id, movement_type, unit_type, quantity, reference_id, reference_type, created_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                ).run(movementId, item.product_id, warehouse_id, 'out', item.unit_type, item.quantity, saleId, 'sale', req.user.id);

                const productRow = db.prepare(`SELECT ${stockField} as stock, low_stock_threshold, name FROM products p JOIN product_stock ps ON p.id = ps.product_id WHERE p.id = ? AND ps.warehouse_id = ?`).get(item.product_id, warehouse_id);
                if (productRow && productRow.stock <= productRow.low_stock_threshold) {
                    const alertId = uuidv4();
                    db.prepare(
                        `INSERT INTO alerts (id, type, product_id, warehouse_id, message, severity)
                         VALUES (?, ?, ?, ?, ?, ?)`
                    ).run(alertId, 'low_stock', item.product_id, warehouse_id, `Low stock alert: ${productRow.name} (${item.unit_type}) has ${productRow.stock} remaining in warehouse`, 'warning');
                }
            }
        });

        transaction();
        res.status(201).json({ id: saleId, total, message: 'Sale completed successfully' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.put('/:id/payment-status', (req, res) => {
    try {
        const { payment_status } = req.body;
        const validStatuses = ['pending', 'completed', 'cancelled', 'refunded'];
        
        if (!validStatuses.includes(payment_status)) {
            return res.status(400).json({ error: 'Invalid payment status' });
        }

        const result = db.prepare('UPDATE sales SET payment_status = ? WHERE id = ?').run(payment_status, req.params.id);
        if (result.changes === 0) return res.status(404).json({ error: 'Sale not found' });
        res.json({ message: 'Payment status updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/:id', (req, res) => {
    try {
        const sale = db.prepare('SELECT warehouse_id FROM sales WHERE id = ?').get(req.params.id);
        if (!sale) return res.status(404).json({ error: 'Sale not found' });

        const items = db.prepare('SELECT product_id, unit_type, quantity FROM sale_items WHERE sale_id = ?').all(req.params.id);

        const transaction = db.transaction(() => {
            for (const item of items) {
                const stockField = `${item.unit_type}_stock`;
                db.prepare(`UPDATE product_stock SET ${stockField} = ${stockField} + ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND warehouse_id = ?`).run(item.quantity, item.product_id, sale.warehouse_id);
                
                const movementId = uuidv4();
                db.prepare(
                    `INSERT INTO stock_movements (id, product_id, warehouse_id, movement_type, unit_type, quantity, reference_id, reference_type, created_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                ).run(movementId, item.product_id, sale.warehouse_id, 'in', item.unit_type, item.quantity, req.params.id, 'sale_return', req.user.id);
            }

            db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(req.params.id);
            const result = db.prepare('DELETE FROM sales WHERE id = ?').run(req.params.id);
            
            if (result.changes === 0) throw new Error('Sale not found');
        });

        transaction();
        res.json({ message: 'Sale deleted and stock restored' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;