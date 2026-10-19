const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authenticateToken } = require('../auth');

const router = express.Router();
const db = getDb();

router.use(authenticateToken);

router.get('/', (req, res) => {
    try {
        const { low_stock, search, warehouse_id } = req.query;
        
        let query = `
            SELECT p.*, 
                COALESCE(SUM(ps.unit_stock), 0) as total_unit_stock,
                COALESCE(SUM(ps.carton_stock), 0) as total_carton_stock,
                COALESCE(SUM(ps.liter20_stock), 0) as total_liter20_stock
            FROM products p
            LEFT JOIN product_stock ps ON p.id = ps.product_id
            WHERE p.is_active = 1
        `;
        const params = [];
        const conditions = [];

        if (warehouse_id) {
            conditions.push('ps.warehouse_id = ?');
            params.push(warehouse_id);
        }

        if (low_stock === 'true') {
            conditions.push('(COALESCE(SUM(ps.unit_stock), 0) <= p.low_stock_threshold OR COALESCE(SUM(ps.carton_stock), 0) <= p.low_stock_threshold OR COALESCE(SUM(ps.liter20_stock), 0) <= p.low_stock_threshold)');
        }

        if (search) {
            conditions.push('(p.name LIKE ? OR p.description LIKE ?)');
            params.push(`%${search}%`, `%${search}%`);
        }

        if (conditions.length > 0) {
            query += ' AND ' + conditions.join(' AND ');
        }

        query += ' GROUP BY p.id ORDER BY p.name ASC';

        const stmt = db.prepare(query);
        const rows = stmt.all(...params);
        
        // Add warehouse-specific stock if warehouse_id provided
        if (warehouse_id) {
            for (const row of rows) {
                const stock = db.prepare('SELECT unit_stock, carton_stock, liter20_stock FROM product_stock WHERE product_id = ? AND warehouse_id = ?').get(row.id, warehouse_id);
                if (stock) {
                    row.warehouse_unit_stock = stock.unit_stock;
                    row.warehouse_carton_stock = stock.carton_stock;
                    row.warehouse_liter20_stock = stock.liter20_stock;
                } else {
                    row.warehouse_unit_stock = 0;
                    row.warehouse_carton_stock = 0;
                    row.warehouse_liter20_stock = 0;
                }
            }
        }
        
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/warehouses', (req, res) => {
    try {
        const rows = db.prepare('SELECT id, name, code, address, city, country, is_active FROM warehouses WHERE is_active = 1 ORDER BY name').all();
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/low-stock', (req, res) => {
    try {
        const { warehouse_id } = req.query;
        let query = `
            SELECT p.*, 
                COALESCE(SUM(ps.unit_stock), 0) as total_unit_stock,
                COALESCE(SUM(ps.carton_stock), 0) as total_carton_stock,
                COALESCE(SUM(ps.liter20_stock), 0) as total_liter20_stock
            FROM products p
            LEFT JOIN product_stock ps ON p.id = ps.product_id
            WHERE p.is_active = 1
        `;
        const params = [];
        
        if (warehouse_id) {
            query += ' AND ps.warehouse_id = ?';
            params.push(warehouse_id);
        }
        
        query += ' GROUP BY p.id HAVING COALESCE(SUM(ps.unit_stock), 0) <= p.low_stock_threshold OR COALESCE(SUM(ps.carton_stock), 0) <= p.low_stock_threshold OR COALESCE(SUM(ps.liter20_stock), 0) <= p.low_stock_threshold ORDER BY p.name';
        
        const rows = db.prepare(query).all(...params);
        res.json(rows);
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
            const stock = db.prepare('SELECT unit_stock, carton_stock, liter20_stock FROM product_stock WHERE product_id = ? AND warehouse_id = ?').get(req.params.id, warehouse_id);
            row.warehouse_unit_stock = stock?.unit_stock || 0;
            row.warehouse_carton_stock = stock?.carton_stock || 0;
            row.warehouse_liter20_stock = stock?.liter20_stock || 0;
        } else {
            const totalStock = db.prepare('SELECT COALESCE(SUM(unit_stock),0) as unit_stock, COALESCE(SUM(carton_stock),0) as carton_stock, COALESCE(SUM(liter20_stock),0) as liter20_stock FROM product_stock WHERE product_id = ?').get(req.params.id);
            row.total_unit_stock = totalStock.unit_stock;
            row.total_carton_stock = totalStock.carton_stock;
            row.total_liter20_stock = totalStock.liter20_stock;
            
            // Get per-warehouse breakdown
            const perWarehouse = db.prepare(`
                SELECT ps.*, w.name as warehouse_name, w.code as warehouse_code
                FROM product_stock ps
                JOIN warehouses w ON ps.warehouse_id = w.id
                WHERE ps.product_id = ?
            `).all(req.params.id);
            row.per_warehouse = perWarehouse;
        }
        
        res.json(row);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/', (req, res) => {
    try {
        const { name, description, unit_price, carton_price, liter20_price, low_stock_threshold, unit_stock, carton_stock, liter20_stock } = req.body;

        if (!name || unit_price === undefined) {
            return res.status(400).json({ error: 'Name and unit price are required' });
        }

        const id = uuidv4();
        const calculatedCartonPrice = carton_price !== undefined ? carton_price : unit_price * 12;

        const transaction = db.transaction(() => {
            db.prepare(
                `INSERT INTO products (id, name, description, unit_price, carton_price, liter20_price, low_stock_threshold)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            ).run(id, name, description, unit_price, calculatedCartonPrice, liter20_price || 0, low_stock_threshold || 10);

            // Initialize stock for all warehouses with initial values
            const warehouses = db.prepare('SELECT id FROM warehouses WHERE is_active = 1').all();
            const stockInsert = db.prepare('INSERT OR IGNORE INTO product_stock (id, product_id, warehouse_id, unit_stock, carton_stock, liter20_stock) VALUES (?, ?, ?, ?, ?, ?)');
            for (const w of warehouses) {
                stockInsert.run(uuidv4(), id, w.id, unit_stock || 0, carton_stock || 0, liter20_stock || 0);
            }
        });

        transaction();
        
        res.status(201).json({ id, name, unit_price, carton_price: calculatedCartonPrice, liter20_price: liter20_price || 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/:id', (req, res) => {
    try {
        const { name, description, unit_price, carton_price, liter20_price, low_stock_threshold } = req.body;
        const calculatedCartonPrice = carton_price !== undefined ? carton_price : (unit_price !== undefined ? unit_price * 12 : undefined);

        const updates = [];
        const params = [];

        if (name !== undefined) { updates.push('name = ?'); params.push(name); }
        if (description !== undefined) { updates.push('description = ?'); params.push(description); }
        if (unit_price !== undefined) { updates.push('unit_price = ?'); params.push(unit_price); }
        if (calculatedCartonPrice !== undefined) { updates.push('carton_price = ?'); params.push(calculatedCartonPrice); }
        if (liter20_price !== undefined) { updates.push('liter20_price = ?'); params.push(liter20_price); }
        if (low_stock_threshold !== undefined) { updates.push('low_stock_threshold = ?'); params.push(low_stock_threshold); }

        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(req.params.id);

        if (updates.length === 1) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        const result = db.prepare(`UPDATE products SET ${updates.join(', ')} WHERE id = ? AND is_active = 1`).run(...params);
        if (result.changes === 0) return res.status(404).json({ error: 'Product not found' });
        res.json({ message: 'Product updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/:id', (req, res) => {
    try {
        const productId = req.params.id;
        
        const product = db.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').get(productId);
        if (!product) return res.status(404).json({ error: 'Product not found' });

        const transaction = db.transaction(() => {
            db.prepare('DELETE FROM stock_movements WHERE product_id = ?').run(productId);
            db.prepare('DELETE FROM sale_items WHERE product_id = ?').run(productId);
            db.prepare('DELETE FROM purchase_order_items WHERE product_id = ?').run(productId);
            db.prepare('DELETE FROM alerts WHERE product_id = ?').run(productId);
            db.prepare('DELETE FROM product_stock WHERE product_id = ?').run(productId);
            db.prepare('DELETE FROM products WHERE id = ?').run(productId);
        });

        transaction();
        res.json({ message: 'Product deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/:id/stock-movement', (req, res) => {
    try {
        const { movement_type, unit_type, quantity, warehouse_id, reference_id, reference_type, notes } = req.body;
        const productId = req.params.id;

        if (!movement_type || !unit_type || quantity === undefined || !warehouse_id) {
            return res.status(400).json({ error: 'Movement type, unit type, quantity, and warehouse are required' });
        }

        const validUnitTypes = ['unit', 'carton', 'liter20'];
        if (!validUnitTypes.includes(unit_type)) {
            return res.status(400).json({ error: 'Invalid unit type. Must be unit, carton, or liter20' });
        }

        const stockField = `${unit_type}_stock`;
        const row = db.prepare(`SELECT ${stockField} as current_stock FROM product_stock WHERE product_id = ? AND warehouse_id = ?`).get(productId, warehouse_id);
        if (!row) return res.status(404).json({ error: 'Product stock not found for this warehouse' });

        const currentStock = row.current_stock;
        let newStock;

        if (movement_type === 'in' || movement_type === 'adjustment_positive') {
            newStock = currentStock + quantity;
        } else if (movement_type === 'out' || movement_type === 'adjustment_negative') {
            newStock = currentStock - quantity;
            if (newStock < 0) {
                return res.status(400).json({ error: 'Insufficient stock in this warehouse' });
            }
        } else {
            return res.status(400).json({ error: 'Invalid movement type' });
        }

        const transaction = db.transaction(() => {
            db.prepare(`UPDATE product_stock SET ${stockField} = ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND warehouse_id = ?`).run(newStock, productId, warehouse_id);
            
            const movementId = uuidv4();
            db.prepare(
                `INSERT INTO stock_movements (id, product_id, warehouse_id, movement_type, unit_type, quantity, reference_id, reference_type, notes, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(movementId, productId, warehouse_id, movement_type, unit_type, quantity, reference_id, reference_type, notes, req.user.id);

            checkLowStock(productId, warehouse_id, unit_type, newStock);
        });

        transaction();
        res.json({ message: 'Stock movement recorded', new_stock: newStock });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function checkLowStock(productId, warehouseId, unitType, newStock) {
    const row = db.prepare('SELECT low_stock_threshold, name FROM products WHERE id = ?').get(productId);
    if (!row) return;
    
    if (newStock <= row.low_stock_threshold) {
        const alertId = uuidv4();
        db.prepare(
            `INSERT INTO alerts (id, type, product_id, warehouse_id, message, severity)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).run(alertId, 'low_stock', productId, warehouseId, `Low stock alert: ${row.name} (${unitType}) has ${newStock} remaining (threshold: ${row.low_stock_threshold})`, 'warning');
    }
}

router.get('/:id/movements', (req, res) => {
    try {
        const { warehouse_id, limit = 50, offset = 0 } = req.query;
        let query = `
            SELECT sm.*, u.username as created_by_name, w.name as warehouse_name
            FROM stock_movements sm
            LEFT JOIN users u ON sm.created_by = u.id
            LEFT JOIN warehouses w ON sm.warehouse_id = w.id
            WHERE sm.product_id = ?
        `;
        const params = [req.params.id];
        
        if (warehouse_id) {
            query += ' AND sm.warehouse_id = ?';
            params.push(warehouse_id);
        }
        
        query += ' ORDER BY sm.created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const rows = db.prepare(query).all(...params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/stock/export', (req, res) => {
    try {
        const { warehouse_id, format = 'excel' } = req.query;
        
        // Build query with proper joins to get all products with their stock per warehouse
        let query = `
            SELECT 
                p.id, p.name, p.description,
                p.unit_price, p.carton_price, p.liter20_price, p.low_stock_threshold,
                ps.unit_stock, ps.carton_stock, ps.liter20_stock,
                w.id as warehouse_id, w.name as warehouse_name, w.code as warehouse_code
            FROM products p
            LEFT JOIN product_stock ps ON p.id = ps.product_id
            LEFT JOIN warehouses w ON ps.warehouse_id = w.id
            WHERE p.is_active = 1
        `;
        const params = [];
        
        if (warehouse_id) {
            query += ' AND ps.warehouse_id = ?';
            params.push(warehouse_id);
        } else {
            query += ' AND w.is_active = 1';
        }
        
        query += ' ORDER BY w.name, p.name';
        
        const rows = db.prepare(query).all(...params);
        
        if (format === 'excel') {
            const ExcelJS = require('exceljs');
            const workbook = new ExcelJS.Workbook();
            
            workbook.creator = 'VEEMENZ Inventory System';
            workbook.lastModifiedBy = 'VEEMENZ';
            workbook.created = new Date();
            workbook.modified = new Date();
            
            const worksheet = workbook.addWorksheet('Stock Inventory', {
                pageSetup: {
                    orientation: 'landscape',
                    fitToPage: true,
                    fitToWidth: 1,
                    fitToHeight: 0,
                    paperSize: 9,
                    margins: { left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 }
                },
                views: [{ state: 'normal', xSplit: 0, ySplit: 1, activeCell: 'A1' }]
            });
            
            // Styles
            const titleStyle = { font: { name: 'Calibri', bold: true, size: 22, color: { argb: '1E3A8A' } }, alignment: { horizontal: 'center', vertical: 'middle' } };
            const subtitleStyle = { font: { name: 'Calibri', size: 11, color: { argb: '475569' } }, alignment: { horizontal: 'center', vertical: 'middle' } };
            const sectionHeaderStyle = { font: { name: 'Calibri', bold: true, size: 12, color: { argb: '1E40AF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'DBEAFE' } }, alignment: { horizontal: 'left', vertical: 'middle' }, border: { bottom: { style: 'medium', color: { argb: '1E40AF' } } } };
            const headerStyle = { font: { name: 'Calibri', bold: true, size: 11, color: { argb: 'FFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: '1E40AF' } }, alignment: { horizontal: 'center', vertical: 'middle', wrapText: true }, border: { top: { style: 'thin', color: { argb: 'FFFFFF' } }, bottom: { style: 'medium', color: { argb: 'FFFFFF' } }, left: { style: 'thin', color: { argb: 'FFFFFF' } }, right: { style: 'thin', color: { argb: 'FFFFFF' } } } };
            const dataStyle = { font: { name: 'Calibri', size: 10, color: { argb: '1E293B' } }, alignment: { horizontal: 'left', vertical: 'middle', wrapText: true }, border: { top: { style: 'thin', color: { argb: 'E2E8F0' } }, bottom: { style: 'thin', color: { argb: 'E2E8F0' } }, left: { style: 'thin', color: { argb: 'E2E8F0' } }, right: { style: 'thin', color: { argb: 'E2E8F0' } } } };
            const dataStyleCenter = { ...dataStyle, alignment: { horizontal: 'center', vertical: 'middle', wrapText: true } };
            const dataStyleRight = { ...dataStyle, alignment: { horizontal: 'right', vertical: 'middle' } };
            const lowStockStyle = { ...dataStyle, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEF2F2' } }, font: { name: 'Calibri', size: 10, bold: true, color: { argb: 'DC2626' } } };
            const lowStockStyleCenter = { ...lowStockStyle, alignment: { horizontal: 'center', vertical: 'middle' } };
            const lowStockStyleRight = { ...lowStockStyle, alignment: { horizontal: 'right', vertical: 'middle' } };
            const currencyFormat = '₵#,##0.00';
            const numberFormat = '#,##0';
            const summaryStyle = { font: { name: 'Calibri', bold: true, size: 11, color: { argb: '1E40AF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F0F9FF' } }, border: { top: { style: 'double', color: { argb: '1E40AF' } }, bottom: { style: 'thin', color: { argb: '1E40AF' } } }, alignment: { horizontal: 'left', vertical: 'middle' } };
            const totalStyle = { font: { name: 'Calibri', bold: true, size: 12, color: { argb: '0F172A' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E0E7FF' } }, border: { top: { style: 'double', color: { argb: '3730A3' } }, bottom: { style: 'double', color: { argb: '3730A3' } } }, alignment: { horizontal: 'right', vertical: 'middle' }, numFmt: currencyFormat };
            const totalLabelStyle = { ...totalStyle, alignment: { horizontal: 'left', vertical: 'middle' }, numFmt: '@' };
            
            let currentRow = 1;
            const applyRowStyles = (row, styleMap) => { row.eachCell({ includeEmpty: true }, (cell, colNumber) => { const style = styleMap[colNumber] || styleMap.default; if (style) Object.assign(cell, style); }); };
            
            // Company Header
            worksheet.mergeCells(currentRow, 1, currentRow, 14);
            const titleCell = worksheet.getCell(currentRow, 1);
            titleCell.value = 'VEEMENZ'; Object.assign(titleCell, titleStyle); worksheet.getRow(currentRow).height = 35; currentRow++;
            
            worksheet.mergeCells(currentRow, 1, currentRow, 14);
            const subtitleCell = worksheet.getCell(currentRow, 1);
            subtitleCell.value = 'STOCK INVENTORY REPORT'; Object.assign(subtitleCell, { ...subtitleStyle, font: { ...subtitleStyle.font, size: 14, bold: true, color: { argb: '1E40AF' } } }); worksheet.getRow(currentRow).height = 22; currentRow++;
            
            // Report Metadata
            const metaData = [
                { label: 'Report Date:', value: new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) },
                { label: 'Report Time:', value: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) },
                { label: 'Generated By:', value: 'VEEMENZ Inventory System' },
                { label: 'Scope:', value: warehouse_id ? (() => { const wh = db.prepare('SELECT name FROM warehouses WHERE id = ?').get(warehouse_id); return wh?.name || 'Unknown'; })() : 'All Warehouses (Consolidated)' }
            ];
            metaData.forEach((meta, idx) => {
                const labelCell = worksheet.getCell(currentRow, 1); labelCell.value = meta.label; labelCell.font = { name: 'Calibri', bold: true, size: 10, color: { argb: '475569' } }; labelCell.alignment = { horizontal: 'right', vertical: 'middle' }; labelCell.border = { right: { style: 'thin', color: { argb: 'E2E8F0' } } };
                const valueCell = worksheet.getCell(currentRow, 2); valueCell.value = meta.value; valueCell.font = { name: 'Calibri', size: 10, color: { argb: '1E293B' } }; valueCell.alignment = { horizontal: 'left', vertical: 'middle' }; worksheet.mergeCells(currentRow, 2, currentRow, 4); currentRow++;
            }); currentRow++;
            
            // Column Headers
            const headers = [
                { key: 'product', header: 'PRODUCT NAME', width: 32 },
                { key: 'description', header: 'DESCRIPTION', width: 25 },
                { key: 'warehouse', header: 'WAREHOUSE', width: 20 },
                { key: 'unit_price', header: 'UNIT PRICE (₵)', width: 16, format: 'currencyFormat' },
                { key: 'carton_price', header: 'CARTON PRICE (₵)', width: 18, format: 'currencyFormat' },
                { key: 'liter20_price', header: '20L PRICE (₵)', width: 16, format: 'currencyFormat' },
                { key: 'unit_stock', header: 'UNIT STOCK', width: 14, format: 'numberFormat' },
                { key: 'carton_stock', header: 'CARTON STOCK', width: 14, format: 'numberFormat' },
                { key: 'liter20_stock', header: '20L STOCK', width: 14, format: 'numberFormat' },
                { key: 'threshold', header: 'REORDER LEVEL', width: 14, format: 'numberFormat' },
                { key: 'unit_value', header: 'UNIT VALUE (₵)', width: 16, format: 'currencyFormat' },
                { key: 'carton_value', header: 'CARTON VALUE (₵)', width: 18, format: 'currencyFormat' },
                { key: 'liter20_value', header: '20L VALUE (₵)', width: 16, format: 'currencyFormat' },
                { key: 'total_value', header: 'TOTAL VALUE (₵)', width: 18, format: 'currencyFormat' },
                { key: 'status', header: 'STATUS', width: 14 }
            ];
            
            headers.forEach((h, i) => { const cell = worksheet.getCell(currentRow, i + 1); cell.value = h.header; Object.assign(cell, headerStyle); });
            worksheet.getRow(currentRow).height = 28;
            worksheet.autoFilter = { from: { row: currentRow, column: 1 }, to: { row: currentRow, column: headers.length } };
            currentRow++;
            
            // Data Rows - Grouped by Warehouse
            const warehouseGroups = {};
            rows.forEach(row => {
                const whKey = row.warehouse_id || 'NO_WAREHOUSE';
                if (!warehouseGroups[whKey]) {
                    warehouseGroups[whKey] = { name: row.warehouse_name || 'Unassigned', code: row.warehouse_code || 'N/A', rows: [] };
                }
                warehouseGroups[whKey].rows.push(row);
            });
            
            let grandTotals = { unit_stock: 0, carton_stock: 0, liter20_stock: 0, unit_value: 0, carton_value: 0, liter20_value: 0, total_value: 0, product_count: 0 };
            
            Object.entries(warehouseGroups).forEach(([whKey, whData]) => {
                worksheet.mergeCells(currentRow, 1, currentRow, headers.length);
                const whHeaderCell = worksheet.getCell(currentRow, 1); whHeaderCell.value = `📦 ${whData.name} (${whData.code})`; Object.assign(whHeaderCell, sectionHeaderStyle);
                for (let c = 2; c <= headers.length; c++) { const cell = worksheet.getCell(currentRow, c); Object.assign(cell, { ...sectionHeaderStyle, border: { bottom: { style: 'medium', color: { argb: '1E40AF' } } } }); }
                worksheet.getRow(currentRow).height = 22; currentRow++;
                
                let whTotals = { unit_stock: 0, carton_stock: 0, liter20_stock: 0, unit_value: 0, carton_value: 0, liter20_value: 0, total_value: 0, product_count: 0 };
                
                whData.rows.forEach((row, rowIndex) => {
                    const unitValue = (row.unit_price || 0) * (row.unit_stock || 0);
                    const cartonValue = (row.carton_price || 0) * (row.carton_stock || 0);
                    const liter20Value = (row.liter20_price || 0) * (row.liter20_stock || 0);
                    const totalValue = unitValue + cartonValue + liter20Value;
                    
                    const isLowStock = (row.unit_stock || 0) <= (row.low_stock_threshold || 0) || (row.carton_stock || 0) <= (row.low_stock_threshold || 0) || (row.liter20_stock || 0) <= (row.low_stock_threshold || 0);
                    
                    const cellStyles = {};
                    for (let c = 1; c <= headers.length; c++) {
                        if (c <= 3) cellStyles[c] = isLowStock ? lowStockStyle : dataStyle;
                        else if (c === headers.length) cellStyles[c] = isLowStock ? lowStockStyleCenter : dataStyleCenter;
                        else if (c >= 4 && c <= 9) cellStyles[c] = isLowStock ? lowStockStyleCenter : dataStyleCenter;
                        else cellStyles[c] = isLowStock ? lowStockStyleRight : dataStyleRight;
                    }
                    
                    const dataRow = worksheet.getRow(currentRow);
                    dataRow.values = [ row.name || '', row.description || '—', whData.name, row.unit_price || 0, row.carton_price || 0, row.liter20_price || 0, row.unit_stock || 0, row.carton_stock || 0, row.liter20_stock || 0, row.low_stock_threshold || 0, unitValue, cartonValue, liter20Value, totalValue, isLowStock ? '⚠ LOW STOCK' : '✓ OK' ];
                    
                    dataRow.getCell(4).numFmt = '₵#,##0.00'; dataRow.getCell(5).numFmt = '₵#,##0.00'; dataRow.getCell(6).numFmt = '₵#,##0.00';
                    dataRow.getCell(7).numFmt = '#,##0'; dataRow.getCell(8).numFmt = '#,##0'; dataRow.getCell(9).numFmt = '#,##0'; dataRow.getCell(10).numFmt = '#,##0';
                    dataRow.getCell(11).numFmt = '₵#,##0.00'; dataRow.getCell(12).numFmt = '₵#,##0.00'; dataRow.getCell(13).numFmt = '₵#,##0.00'; dataRow.getCell(14).numFmt = '₵#,##0.00';
                    
                    applyRowStyles(dataRow, cellStyles); dataRow.height = 20;
                    
                    whTotals.unit_stock += row.unit_stock || 0; whTotals.carton_stock += row.carton_stock || 0; whTotals.liter20_stock += row.liter20_stock || 0;
                    whTotals.unit_value += unitValue; whTotals.carton_value += cartonValue; whTotals.liter20_value += liter20Value; whTotals.total_value += totalValue; whTotals.product_count++;
                    grandTotals.unit_stock += row.unit_stock || 0; grandTotals.carton_stock += row.carton_stock || 0; grandTotals.liter20_stock += row.liter20_stock || 0;
                    grandTotals.unit_value += unitValue; grandTotals.carton_value += cartonValue; grandTotals.liter20_value += liter20Value; grandTotals.total_value += totalValue; grandTotals.product_count++;
                    currentRow++;
                });
                
                if (Object.keys(warehouseGroups).length > 1) {
                    const subRow = worksheet.getRow(currentRow);
                    subRow.values = [ '', '', `SUBTOTAL: ${whData.name}`, '', '', '', whTotals.unit_stock, whTotals.carton_stock, whTotals.liter20_stock, '', whTotals.unit_value, whTotals.carton_value, whTotals.liter20_value, whTotals.total_value, `${whTotals.product_count} products` ];
                    for (let c = 1; c <= headers.length; c++) { const cell = subRow.getCell(c); if (c === 3) Object.assign(cell, totalLabelStyle); else if (c >= 4 && c <= 6) Object.assign(cell, { ...totalLabelStyle, numFmt: '@' }); else if (c >= 7 && c <= 10) Object.assign(cell, { ...totalStyle, numFmt: '#,##0' }); else if (c >= 11 && c <= 14) Object.assign(cell, totalStyle); }
                    subRow.height = 22; currentRow++;
                }
            });
            
            currentRow++;
            const grandRow = worksheet.getRow(currentRow);
            grandRow.values = [ '', '', 'GRAND TOTAL (ALL WAREHOUSES)', '', '', '', grandTotals.unit_stock, grandTotals.carton_stock, grandTotals.liter20_stock, '', grandTotals.unit_value, grandTotals.carton_value, grandTotals.liter20_value, grandTotals.total_value, `${grandTotals.product_count} products` ];
            for (let c = 1; c <= headers.length; c++) { const cell = grandRow.getCell(c); if (c === 3) Object.assign(cell, totalLabelStyle); else if (c >= 4 && c <= 6) Object.assign(cell, { ...totalLabelStyle, numFmt: '@' }); else if (c >= 7 && c <= 10) Object.assign(cell, { ...totalStyle, numFmt: '#,##0' }); else if (c >= 11 && c <= 14) Object.assign(cell, totalStyle); }
            grandRow.height = 26; currentRow += 2;
            
            // Summary Section
            worksheet.mergeCells(currentRow, 1, currentRow, headers.length);
            const summaryTitle = worksheet.getCell(currentRow, 1); summaryTitle.value = 'SUMMARY STATISTICS'; Object.assign(summaryTitle, { ...sectionHeaderStyle, font: { ...sectionHeaderStyle.font, size: 14 } }); currentRow++;
            
            const lowStockItems = rows.filter(r => (r.unit_stock || 0) <= (r.low_stock_threshold || 0) || (r.carton_stock || 0) <= (r.low_stock_threshold || 0) || (r.liter20_stock || 0) <= (r.low_stock_threshold || 0)).length;
            const outOfStockItems = rows.filter(r => (r.unit_stock || 0) === 0 && (r.carton_stock || 0) === 0 && (r.liter20_stock || 0) === 0).length;
            
            const summaryData = [
                ['Metric', 'Value'],
                ['Total Unique Products', grandTotals.product_count],
                ['Warehouses Included', Object.keys(warehouseGroups).length],
                ['Total Unit Stock', grandTotals.unit_stock],
                ['Total Carton Stock', grandTotals.carton_stock],
                ['Total 20L Container Stock', grandTotals.liter20_stock],
                ['Total Stock Units (All Types)', grandTotals.unit_stock + grandTotals.carton_stock + grandTotals.liter20_stock],
                ['Total Unit Value', grandTotals.unit_value],
                ['Total Carton Value', grandTotals.carton_value],
                ['Total 20L Value', grandTotals.liter20_value],
                ['TOTAL INVENTORY VALUE', grandTotals.total_value],
                ['Items at Reorder Level', lowStockItems],
                ['Out of Stock Items', outOfStockItems],
                ['Stock Health', `${lowStockItems === 0 ? '✓ HEALTHY' : outOfStockItems > 0 ? '⚠ CRITICAL' : '⚠ ATTENTION NEEDED'}`]
            ];
            
            summaryData.forEach((rowData, idx) => {
                const r = worksheet.getRow(currentRow); r.values = rowData;
                if (idx === 0) { r.getCell(1).font = { name: 'Calibri', bold: true, size: 11, color: { argb: 'FFFFFF' } }; r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1E40AF' } }; r.getCell(2).font = { name: 'Calibri', bold: true, size: 11, color: { argb: 'FFFFFF' } }; r.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1E40AF' } }; [r.getCell(1), r.getCell(2)].forEach(c => { c.alignment = { horizontal: 'center', vertical: 'middle' }; c.border = { top: { style: 'thin' }, bottom: { style: 'medium', color: { argb: 'FFFFFF' } }, left: { style: 'thin' }, right: { style: 'thin' } }; }); }
                else if (idx === summaryData.length - 1) { r.getCell(1).font = { name: 'Calibri', bold: true, size: 12, color: { argb: '0F172A' } }; r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E0E7FF' } }; r.getCell(2).font = { name: 'Calibri', bold: true, size: 12, color: { argb: lowStockItems === 0 ? '059669' : outOfStockItems > 0 ? 'DC2626' : 'D97706' } }; r.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E0E7FF' } }; r.getCell(2).alignment = { horizontal: 'center', vertical: 'middle' }; [r.getCell(1), r.getCell(2)].forEach(c => { c.border = { top: { style: 'thin' }, bottom: { style: 'double', color: { argb: '3730A3' } }, left: { style: 'thin' }, right: { style: 'thin' } }; }); }
                else { r.getCell(1).font = { name: 'Calibri', size: 10, color: { argb: '475569' } }; r.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' }; r.getCell(2).font = { name: 'Calibri', bold: true, size: 10, color: { argb: '1E293B' } }; r.getCell(2).alignment = { horizontal: 'right', vertical: 'middle' }; if (typeof rowData[1] === 'number' && rowData[1] >= 1000) r.getCell(2).numFmt = '₵#,##0.00'; else r.getCell(2).numFmt = '#,##0'; [r.getCell(1), r.getCell(2)].forEach(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: idx % 2 === 0 ? 'F8FAFC' : 'FFFFFF' } }; c.border = { bottom: { style: 'thin', color: { argb: 'E2E8F0' } }, left: { style: 'thin' }, right: { style: 'thin' } }; }); }
                currentRow++;
            });
            
            worksheet.columns = headers.map(h => ({ width: h.width }));
            worksheet.footer = { left: 'VEEMENZ Inventory System', center: `Page &P of &N`, right: `Confidential - Generated ${new Date().toISOString().split('T')[0]}` };
            worksheet.pageSetup.printArea = `A1:${String.fromCharCode(64 + headers.length)}${currentRow}`; worksheet.pageSetup.horizontalCentered = true;
            
            const filename = `VEEMENZ-Stock-Inventory-${new Date().toISOString().split('T')[0]}${warehouse_id ? `-${warehouseGroups[warehouse_id]?.code || 'WH'}` : '-All-Warehouses'}.xlsx`;
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