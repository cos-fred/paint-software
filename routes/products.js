const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authenticateToken } = require('../auth');
const { logAudit } = require('../services/audit');
const { notifyLowStock } = require('../services/notifications');

const router = express.Router();
const db = getDb();

router.use(authenticateToken);

router.get('/', (req, res) => {
    try {
        const { low_stock, search, warehouse_id } = req.query;

        let query = `
            SELECT p.*,
                (SELECT COALESCE(SUM(carton_stock), 0) FROM product_stock WHERE product_id = p.id) AS total_carton_stock,
                (SELECT COALESCE(SUM(liter20_stock), 0) FROM product_stock WHERE product_id = p.id) AS total_liter20_stock
        `;
        const params = [];

        if (warehouse_id) {
            query += `,
                (SELECT COALESCE(carton_stock, 0) FROM product_stock WHERE product_id = p.id AND warehouse_id = ?) AS warehouse_carton_stock,
                (SELECT COALESCE(liter20_stock, 0) FROM product_stock WHERE product_id = p.id AND warehouse_id = ?) AS warehouse_liter20_stock
            `;
            params.push(warehouse_id, warehouse_id);
        }

        query += ` FROM products p WHERE p.is_active = 1`;

        if (search) {
            query += ' AND (p.name LIKE ? OR p.description LIKE ? OR p.sku LIKE ?)';
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        query += ' ORDER BY p.name ASC';

        let rows = db.prepare(query).all(...params);

        if (low_stock === 'true') {
            rows = rows.filter((p) => {
                const cartons = warehouse_id ? p.warehouse_carton_stock : p.total_carton_stock;
                const liter20 = warehouse_id ? p.warehouse_liter20_stock : p.total_liter20_stock;
                return cartons <= p.low_stock_threshold || liter20 <= p.low_stock_threshold;
            });
        }

        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/warehouses', (req, res) => {
    try {
        res.json(db.prepare('SELECT id, name, code, address, city, country, is_active FROM warehouses WHERE is_active = 1 ORDER BY name').all());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/low-stock', (req, res) => {
    try {
        const { warehouse_id } = req.query;
        let query = `
            SELECT p.*,
                COALESCE(SUM(ps.carton_stock), 0) as total_carton_stock,
                COALESCE(SUM(ps.liter20_stock), 0) as total_liter20_stock
            FROM products p
            LEFT JOIN product_stock ps ON p.id = ps.product_id
            WHERE p.is_active = 1
        `;
        const params = [];
        if (warehouse_id) { query += ' AND ps.warehouse_id = ?'; params.push(warehouse_id); }
        query += ' GROUP BY p.id HAVING COALESCE(SUM(ps.carton_stock), 0) <= p.low_stock_threshold OR COALESCE(SUM(ps.liter20_stock), 0) <= p.low_stock_threshold ORDER BY p.name';
        res.json(db.prepare(query).all(...params));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/:id', (req, res) => {
    try {
        const { warehouse_id } = req.query;
        const row = db.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').get(req.params.id);
        if (!row) return res.status(404).json({ error: 'Product not found' });

        if (warehouse_id) {
            const stock = db.prepare('SELECT carton_stock, liter20_stock FROM product_stock WHERE product_id = ? AND warehouse_id = ?').get(req.params.id, warehouse_id);
            row.warehouse_carton_stock = stock?.carton_stock || 0;
            row.warehouse_liter20_stock = stock?.liter20_stock || 0;
        } else {
            const totalStock = db.prepare('SELECT COALESCE(SUM(carton_stock),0) as carton_stock, COALESCE(SUM(liter20_stock),0) as liter20_stock FROM product_stock WHERE product_id = ?').get(req.params.id);
            row.total_carton_stock = totalStock.carton_stock;
            row.total_liter20_stock = totalStock.liter20_stock;
            row.per_warehouse = db.prepare(`
                SELECT ps.*, w.name as warehouse_name, w.code as warehouse_code
                FROM product_stock ps JOIN warehouses w ON ps.warehouse_id = w.id
                WHERE ps.product_id = ?
            `).all(req.params.id);
        }
        res.json(row);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/', (req, res) => {
    try {
        const { name, description, sku, unit_price, carton_price, liter20_price, low_stock_threshold, warehouse_id, carton_stock, liter20_stock } = req.body;

        if (!name || unit_price === undefined) return res.status(400).json({ error: 'Name and unit price are required' });
        if (!warehouse_id) return res.status(400).json({ error: 'Warehouse is required when adding a product' });

        const warehouse = db.prepare('SELECT id FROM warehouses WHERE id = ? AND is_active = 1').get(warehouse_id);
        if (!warehouse) return res.status(400).json({ error: 'Invalid warehouse' });

        const initialCartons = Math.max(0, Number.parseInt(carton_stock, 10) || 0);
        const initialLiter20 = Math.max(0, Number.parseInt(liter20_stock, 10) || 0);
        const targetWarehouseId = String(warehouse_id).trim();

        if (sku) {
            if (db.prepare('SELECT id FROM products WHERE sku = ?').get(sku)) return res.status(400).json({ error: 'A product with this SKU already exists' });
        }

        const id = uuidv4();
        const calculatedCartonPrice = carton_price !== undefined && carton_price !== null ? carton_price : unit_price * 12;

        const transaction = db.transaction(() => {
            db.prepare(`INSERT INTO products (id, name, description, sku, unit_price, carton_price, liter20_price, low_stock_threshold) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(id, name, description, sku || null, unit_price, calculatedCartonPrice, liter20_price || 0, low_stock_threshold || 10);

            const warehouses = db.prepare('SELECT id FROM warehouses WHERE is_active = 1').all();
            const stockInsert = db.prepare(`INSERT INTO product_stock (id, product_id, warehouse_id, carton_stock, liter20_stock) VALUES (?, ?, ?, ?, ?)`);
            const movementInsert = db.prepare(`INSERT INTO stock_movements (id, product_id, warehouse_id, movement_type, unit_type, quantity, reference_id, reference_type, notes, created_by) VALUES (?, ?, ?, 'in', ?, ?, ?, 'product_create', 'Initial stock when product was created', ?)`);

            for (const w of warehouses) {
                const isTarget = String(w.id) === targetWarehouseId;
                stockInsert.run(uuidv4(), id, w.id, isTarget ? initialCartons : 0, isTarget ? initialLiter20 : 0);
            }
            if (initialCartons > 0) movementInsert.run(uuidv4(), id, targetWarehouseId, 'carton', initialCartons, id, req.user.id);
            if (initialLiter20 > 0) movementInsert.run(uuidv4(), id, targetWarehouseId, 'liter20', initialLiter20, id, req.user.id);
        });
        transaction();

        logAudit(req.user.id, 'product.create', 'product', id, { name });
        res.status(201).json({ id, name, unit_price, carton_price: calculatedCartonPrice, liter20_price: liter20_price || 0, warehouse_id: targetWarehouseId, carton_stock: initialCartons, liter20_stock: initialLiter20 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/:id', (req, res) => {
    try {
        const { name, description, sku, unit_price, carton_price, liter20_price, low_stock_threshold } = req.body;
        const calculatedCartonPrice = carton_price !== undefined ? carton_price : (unit_price !== undefined ? unit_price * 12 : undefined);

        if (sku !== undefined && sku) {
            if (db.prepare('SELECT id FROM products WHERE sku = ? AND id != ?').get(sku, req.params.id)) return res.status(400).json({ error: 'A product with this SKU already exists' });
        }

        const updates = [];
        const params = [];
        if (name !== undefined) { updates.push('name = ?'); params.push(name); }
        if (description !== undefined) { updates.push('description = ?'); params.push(description); }
        if (sku !== undefined) { updates.push('sku = ?'); params.push(sku || null); }
        if (unit_price !== undefined) { updates.push('unit_price = ?'); params.push(unit_price); }
        if (calculatedCartonPrice !== undefined) { updates.push('carton_price = ?'); params.push(calculatedCartonPrice); }
        if (liter20_price !== undefined) { updates.push('liter20_price = ?'); params.push(liter20_price); }
        if (low_stock_threshold !== undefined) { updates.push('low_stock_threshold = ?'); params.push(low_stock_threshold); }
        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(req.params.id);
        if (updates.length === 1) return res.status(400).json({ error: 'No fields to update' });

        const result = db.prepare(`UPDATE products SET ${updates.join(', ')} WHERE id = ? AND is_active = 1`).run(...params);
        if (result.changes === 0) return res.status(404).json({ error: 'Product not found' });
        logAudit(req.user.id, 'product.update', 'product', req.params.id);
        res.json({ message: 'Product updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/:id', (req, res) => {
    try {
        const productId = req.params.id;
        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
        if (!product) return res.status(404).json({ error: 'Product not found' });

        const transaction = db.transaction(() => {
            db.prepare('DELETE FROM sale_returns WHERE product_id = ?').run(productId);
            db.prepare('DELETE FROM sale_items WHERE product_id = ?').run(productId);
            db.prepare('DELETE FROM stock_movements WHERE product_id = ?').run(productId);
            db.prepare('DELETE FROM stock_transfers WHERE product_id = ?').run(productId);
            db.prepare('DELETE FROM alerts WHERE product_id = ?').run(productId);
            db.prepare('DELETE FROM product_stock WHERE product_id = ?').run(productId);
            db.prepare('DELETE FROM products WHERE id = ?').run(productId);
        });
        transaction();

        logAudit(req.user.id, 'product.delete', 'product', productId, { name: product.name });
        res.json({ message: 'Product deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/:id/stock-movement', (req, res) => {
    try {
        const { movement_type, unit_type, quantity, warehouse_id, reference_id, reference_type, notes } = req.body;
        const productId = req.params.id;
        if (!movement_type || !unit_type || quantity === undefined || !warehouse_id) return res.status(400).json({ error: 'Movement type, unit type, quantity, and warehouse are required' });
        if (!['carton', 'liter20'].includes(unit_type)) return res.status(400).json({ error: 'Invalid unit type' });
        if (quantity <= 0) return res.status(400).json({ error: 'Quantity must be positive' });

        const stockField = `${unit_type}_stock`;
        const row = db.prepare(`SELECT ${stockField} as current_stock FROM product_stock WHERE product_id = ? AND warehouse_id = ?`).get(productId, warehouse_id);
        if (!row) return res.status(404).json({ error: 'Product stock not found for this warehouse' });

        const currentStock = row.current_stock;
        let newStock;
        if (movement_type === 'in' || movement_type === 'adjustment_positive') newStock = currentStock + quantity;
        else if (movement_type === 'out' || movement_type === 'adjustment_negative') {
            newStock = currentStock - quantity;
            if (newStock < 0) return res.status(400).json({ error: 'Insufficient stock in this warehouse' });
        } else return res.status(400).json({ error: 'Invalid movement type' });

        const transaction = db.transaction(() => {
            db.prepare(`UPDATE product_stock SET ${stockField} = ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND warehouse_id = ?`).run(newStock, productId, warehouse_id);
            db.prepare(`INSERT INTO stock_movements (id, product_id, warehouse_id, movement_type, unit_type, quantity, reference_id, reference_type, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(uuidv4(), productId, warehouse_id, movement_type, unit_type, quantity, reference_id || null, reference_type || 'stock_adjustment', notes || null, req.user.id);
        });
        transaction();

        checkLowStock(productId, warehouse_id, unit_type, newStock);
        logAudit(req.user.id, 'stock.adjust', 'product', productId, { movement_type, unit_type, quantity, warehouse_id });
        res.json({ message: 'Stock movement recorded', new_stock: newStock });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function checkLowStock(productId, warehouseId, unitType, newStock) {
    const row = db.prepare('SELECT low_stock_threshold, name FROM products WHERE id = ?').get(productId);
    if (!row) return;
    if (newStock <= row.low_stock_threshold) {
        db.prepare(`INSERT INTO alerts (id, type, product_id, warehouse_id, message, severity) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(uuidv4(), 'low_stock', productId, warehouseId, `Low stock alert: ${row.name} (${unitType}) has ${newStock} remaining (threshold: ${row.low_stock_threshold})`, 'warning');
        const wh = db.prepare('SELECT name FROM warehouses WHERE id = ?').get(warehouseId);
        notifyLowStock({ productName: row.name, warehouseName: wh?.name || 'Warehouse', unitType, current: newStock, threshold: row.low_stock_threshold });
    }
}

router.get('/:id/movements', (req, res) => {
    try {
        const { warehouse_id, limit = 50, offset = 0 } = req.query;
        let query = `SELECT sm.*, u.username as created_by_name, w.name as warehouse_name FROM stock_movements sm LEFT JOIN users u ON sm.created_by = u.id LEFT JOIN warehouses w ON sm.warehouse_id = w.id WHERE sm.product_id = ?`;
        const params = [req.params.id];
        if (warehouse_id) { query += ' AND sm.warehouse_id = ?'; params.push(warehouse_id); }
        query += ' ORDER BY sm.created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));
        res.json(db.prepare(query).all(...params));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/stock/export', (req, res) => {
    try {
        const { warehouse_id, format = 'excel' } = req.query;
        const params = [];
        let query = `SELECT p.name, p.sku, p.carton_price, p.liter20_price, p.low_stock_threshold, ps.carton_stock, ps.liter20_stock, w.name as warehouse_name, w.code as warehouse_code
            FROM products p LEFT JOIN product_stock ps ON p.id = ps.product_id LEFT JOIN warehouses w ON ps.warehouse_id = w.id WHERE p.is_active = 1`;
        if (warehouse_id) { query += ' AND ps.warehouse_id = ?'; params.push(warehouse_id); }
        else { query += ' AND w.is_active = 1'; }
        query += ' ORDER BY w.name, p.name';
        const rows = db.prepare(query).all(...params);

        if (format === 'excel') {
            const ExcelJS = require('exceljs');
            const workbook = new ExcelJS.Workbook();
            const ws = workbook.addWorksheet('Stock Inventory');
            ws.columns = [
                { header: 'Product', key: 'name', width: 30 },
                { header: 'SKU', key: 'sku', width: 15 },
                { header: 'Warehouse', key: 'warehouse', width: 20 },
                { header: 'Carton Price (₵)', key: 'carton_price', width: 18 },
                { header: '20L Price (₵)', key: 'liter20_price', width: 16 },
                { header: 'Carton Stock', key: 'carton_stock', width: 14 },
                { header: '20L Stock', key: 'liter20_stock', width: 12 },
                { header: 'Reorder Level', key: 'threshold', width: 14 },
                { header: 'Total Value (₵)', key: 'total_value', width: 18 }
            ];
            rows.forEach(r => {
                const total = (r.carton_price * r.carton_stock) + (r.liter20_price * r.liter20_stock);
                ws.addRow({ name: r.name, sku: r.sku || '', warehouse: r.warehouse_name, carton_price: r.carton_price, liter20_price: r.liter20_price, carton_stock: r.carton_stock, liter20_stock: r.liter20_stock, threshold: r.low_stock_threshold, total_value: total });
            });
            ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
            ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1E40AF' } };
            ['carton_price', 'liter20_price', 'total_value'].forEach(k => ws.getColumn(k).numFmt = '₵#,##0.00');
            const filename = `VEEMENZ-Stock-${new Date().toISOString().split('T')[0]}.xlsx`;
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            return workbook.xlsx.write(res).then(() => res.end());
        }
        res.json(rows);
    } catch (err) {
        console.error('Export error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;