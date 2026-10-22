const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { authenticateToken, requirePermission } = require('../auth');
const { logAudit } = require('../services/audit');
const { checkLowStock } = require('../services/low-stock');
const {
    stockColumn,
    toUnits,
    splitUnits,
    getProductStockStatus,
    UNIT_TYPES
} = require('../lib/stock');
const { ClientError, sendSafeError } = require('../lib/errors');
const {
    parsePositiveInteger,
    parseNonNegativeInteger,
    parseNonNegativeNumber,
    round2,
    parseLimit,
    parseOffset
} = require('../lib/validation');
const { sanitizeCell } = require('../lib/export');
const money = require('../lib/money');
const parsePrice = (v, l) => money.amount(money.cents(v, l));

const router = express.Router();
const db = getDb();

router.use(authenticateToken);

router.get('/', (req, res) => {
    try {
        const { low_stock, search, warehouse_id } = req.query;

        let query = `
            SELECT p.*,
                (SELECT COALESCE(SUM(unit_stock), 0) FROM product_stock WHERE product_id = p.id) AS total_unit_stock,
                (SELECT COALESCE(SUM(liter20_stock), 0) FROM product_stock WHERE product_id = p.id) AS total_liter20_stock
        `;
        const params = [];

        if (warehouse_id) {
            query += `,
                (SELECT COALESCE(unit_stock, 0) FROM product_stock WHERE product_id = p.id AND warehouse_id = ?) AS warehouse_unit_stock,
                (SELECT COALESCE(liter20_stock, 0) FROM product_stock WHERE product_id = p.id AND warehouse_id = ?) AS warehouse_liter20_stock
            `;
            params.push(warehouse_id, warehouse_id);
        }

        query += ` FROM products p WHERE p.is_active = 1`;

        if (search) {
            query +=
                ' AND (p.name LIKE ? OR p.description LIKE ? OR p.sku LIKE ?)';
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        query += ' ORDER BY p.name ASC';

        let rows = db.prepare(query).all(...params);

        rows.forEach((p) => {
            const units = warehouse_id
                ? p.warehouse_unit_stock
                : p.total_unit_stock;
            const liter20 = warehouse_id
                ? p.warehouse_liter20_stock
                : p.total_liter20_stock;
            const status = getProductStockStatus(p, units, liter20);
            p.is_carton_low = status.isCartonLow;
            p.is_liter20_low = status.isLiter20Low;
            p.is_low_stock = status.isLow;
            p.low_stock_reason = status.lowStockReason;
            p.low_stock_label = status.lowStockLabel;
        });

        if (low_stock === 'true') {
            rows = rows.filter((p) => p.is_low_stock);
        }

        res.json(rows);
    } catch (err) {
        sendSafeError(res, err, '[products]');
    }
});

router.get('/low-stock', (req, res) => {
    try {
        const { warehouse_id } = req.query;
        let query = `
            SELECT p.*,
                COALESCE(SUM(ps.unit_stock), 0) as total_unit_stock,
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
        query += ' GROUP BY p.id ORDER BY p.name';
        const rows = db.prepare(query).all(...params);
        const lowStockRows = rows
            .map((p) => {
                const status = getProductStockStatus(
                    p,
                    p.total_unit_stock,
                    p.total_liter20_stock
                );
                p.is_carton_low = status.isCartonLow;
                p.is_liter20_low = status.isLiter20Low;
                p.is_low_stock = status.isLow;
                p.low_stock_reason = status.lowStockReason;
                p.low_stock_label = status.lowStockLabel;
                return p;
            })
            .filter((p) => p.is_low_stock);
        res.json(lowStockRows);
    } catch (err) {
        sendSafeError(res, err, '[products]');
    }
});

router.get('/:id', (req, res) => {
    try {
        const { warehouse_id } = req.query;
        const row = db
            .prepare('SELECT * FROM products WHERE id = ? AND is_active = 1')
            .get(req.params.id);
        if (!row) return res.status(404).json({ error: 'Product not found' });

        if (warehouse_id) {
            const stock = db
                .prepare(
                    'SELECT unit_stock, liter20_stock FROM product_stock WHERE product_id = ? AND warehouse_id = ?'
                )
                .get(req.params.id, warehouse_id);
            row.warehouse_unit_stock = stock?.unit_stock || 0;
            row.warehouse_liter20_stock = stock?.liter20_stock || 0;
        } else {
            const totalStock = db
                .prepare(
                    'SELECT COALESCE(SUM(unit_stock),0) as unit_stock, COALESCE(SUM(liter20_stock),0) as liter20_stock FROM product_stock WHERE product_id = ?'
                )
                .get(req.params.id);
            row.total_unit_stock = totalStock.unit_stock;
            row.total_liter20_stock = totalStock.liter20_stock;
            row.per_warehouse = db
                .prepare(
                    `
                SELECT ps.*, w.name as warehouse_name, w.code as warehouse_code
                FROM product_stock ps JOIN warehouses w ON ps.warehouse_id = w.id
                WHERE ps.product_id = ?
            `
                )
                .all(req.params.id);
        }
        res.json(row);
    } catch (err) {
        sendSafeError(res, err, '[products]');
    }
});

router.post('/', requirePermission('manage_products'), (req, res) => {
    try {
        const {
            name,
            description,
            sku,
            units_per_carton,
            unit_price,
            carton_price,
            liter20_price,
            low_stock_threshold,
            warehouse_id,
            cartons,
            loose_units,
            liter20_stock
        } = req.body;

        if (!name || unit_price === undefined)
            return res
                .status(400)
                .json({ error: 'Name and unit price are required' });
        if (!warehouse_id)
            return res
                .status(400)
                .json({ error: 'Warehouse is required when adding a product' });

        const warehouse = db
            .prepare('SELECT id FROM warehouses WHERE id = ? AND is_active = 1')
            .get(warehouse_id);
        if (!warehouse)
            return res.status(400).json({ error: 'Invalid warehouse' });

        const validatedUnitsPerCarton = parsePositiveInteger(
            units_per_carton,
            'Units per carton'
        );
        const validatedUnitPrice = parsePrice(unit_price, 'Unit price');
        const validatedLiter20Price = parsePrice(
            liter20_price ?? 0,
            '20L price'
        );
        const validatedThreshold = parseNonNegativeInteger(
            low_stock_threshold ?? 10,
            'Low stock threshold'
        );
        if (
            req.body.carton_price_mode &&
            !['auto', 'manual'].includes(req.body.carton_price_mode)
        )
            throw new ClientError(400, 'Invalid carton price mode');
        const automatic =
            req.body.carton_price_mode === 'auto' ||
            carton_price == null ||
            carton_price === '';
        const validatedCartonPrice = !automatic
            ? parsePrice(carton_price, 'Carton price')
            : round2(validatedUnitPrice * validatedUnitsPerCarton);

        const initialCartons = parseNonNegativeInteger(
            cartons ?? 0,
            'Carton quantity'
        );
        const initialLooseUnits = parseNonNegativeInteger(
            loose_units ?? 0,
            'Loose units'
        );
        const initialLiter20 = parseNonNegativeInteger(
            liter20_stock ?? 0,
            '20L stock'
        );
        const totalUnits =
            toUnits('carton', initialCartons, validatedUnitsPerCarton) +
            initialLooseUnits;
        if (!Number.isSafeInteger(totalUnits))
            throw new ClientError(
                400,
                'Stock quantity is outside the supported range'
            );
        money.cents(validatedCartonPrice, 'Carton price');
        if (typeof name !== 'string' || !name.trim() || name.length > 200)
            throw new ClientError(
                400,
                'Product name must be text of at most 200 characters'
            );
        const targetWarehouseId = String(warehouse_id).trim();

        if (sku) {
            if (db.prepare('SELECT id FROM products WHERE sku = ?').get(sku))
                return res
                    .status(400)
                    .json({ error: 'A product with this SKU already exists' });
        }

        const id = uuidv4();

        const transaction = db.transaction(() => {
            db.prepare(
                `INSERT INTO products (id, name, description, sku, unit_price, carton_price, liter20_price, units_per_carton, low_stock_threshold, carton_price_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
                id,
                name.trim(),
                description,
                sku || null,
                validatedUnitPrice,
                validatedCartonPrice,
                validatedLiter20Price,
                validatedUnitsPerCarton,
                validatedThreshold,
                automatic ? 'auto' : 'manual'
            );

            const warehouses = db
                .prepare('SELECT id FROM warehouses WHERE is_active = 1')
                .all();
            const stockInsert = db.prepare(
                `INSERT INTO product_stock (id, product_id, warehouse_id, unit_stock, carton_stock, liter20_stock) VALUES (?, ?, ?, ?, 0, ?)`
            );
            const movementInsert = db.prepare(
                `INSERT INTO stock_movements (id, product_id, warehouse_id, movement_type, unit_type, quantity, reference_id, reference_type, notes, created_by) VALUES (?, ?, ?, 'in', ?, ?, ?, 'product_create', 'Initial stock when product was created', ?)`
            );

            for (const w of warehouses) {
                const isTarget = String(w.id) === targetWarehouseId;
                stockInsert.run(
                    uuidv4(),
                    id,
                    w.id,
                    isTarget ? totalUnits : 0,
                    isTarget ? initialLiter20 : 0
                );
            }
            if (totalUnits > 0)
                movementInsert.run(
                    uuidv4(),
                    id,
                    targetWarehouseId,
                    'unit',
                    totalUnits,
                    id,
                    req.user.id
                );
            if (initialLiter20 > 0)
                movementInsert.run(
                    uuidv4(),
                    id,
                    targetWarehouseId,
                    'liter20',
                    initialLiter20,
                    id,
                    req.user.id
                );
        });
        transaction();

        logAudit(req.user.id, 'product.create', 'product', id, { name });
        res.status(201).json({
            id,
            name,
            units_per_carton: validatedUnitsPerCarton,
            unit_price: validatedUnitPrice,
            carton_price: validatedCartonPrice,
            liter20_price: validatedLiter20Price,
            warehouse_id: targetWarehouseId,
            unit_stock: totalUnits,
            liter20_stock: initialLiter20
        });
    } catch (err) {
        sendSafeError(res, err, '[products]');
    }
});

router.put('/:id', requirePermission('manage_products'), (req, res) => {
    try {
        const {
            name,
            description,
            sku,
            units_per_carton,
            unit_price,
            carton_price,
            liter20_price,
            low_stock_threshold
        } = req.body;

        if (sku !== undefined && sku) {
            if (
                db
                    .prepare(
                        'SELECT id FROM products WHERE sku = ? AND id != ?'
                    )
                    .get(sku, req.params.id)
            )
                return res
                    .status(400)
                    .json({ error: 'A product with this SKU already exists' });
        }

        const existing = db
            .prepare('SELECT * FROM products WHERE id = ? AND is_active = 1')
            .get(req.params.id);
        if (!existing)
            return res.status(404).json({ error: 'Product not found' });

        const newUnitsPerCarton =
            units_per_carton !== undefined
                ? parsePositiveInteger(units_per_carton, 'Units per carton')
                : existing.units_per_carton;

        const updates = [];
        const params = [];
        if (name !== undefined) {
            if (typeof name !== 'string' || !name.trim() || name.length > 200)
                throw new ClientError(400, 'Invalid product name');
            updates.push('name = ?');
            params.push(name.trim());
        }
        if (description !== undefined) {
            updates.push('description = ?');
            params.push(description);
        }
        if (sku !== undefined) {
            updates.push('sku = ?');
            params.push(sku || null);
        }

        let validatedUnitPrice;
        if (unit_price !== undefined) {
            validatedUnitPrice = parsePrice(unit_price, 'Unit price');
            updates.push('unit_price = ?');
            params.push(validatedUnitPrice);
        }
        const explicitCarton =
            carton_price !== undefined &&
            carton_price !== null &&
            carton_price !== '';
        const mode =
            req.body.carton_price_mode ||
            (explicitCarton ? 'manual' : existing.carton_price_mode);
        if (!['auto', 'manual'].includes(mode))
            throw new ClientError(400, 'Invalid carton price mode');
        if (mode === 'auto') {
            const newPrice = validatedUnitPrice ?? existing.unit_price;
            updates.push('carton_price = ?');
            params.push(
                money.amount(
                    money.multiply(money.cents(newPrice), newUnitsPerCarton)
                )
            );
        } else if (explicitCarton) {
            updates.push('carton_price = ?');
            params.push(parsePrice(carton_price, 'Carton price'));
        }
        updates.push('carton_price_mode = ?');
        params.push(mode);

        if (liter20_price !== undefined) {
            updates.push('liter20_price = ?');
            params.push(parsePrice(liter20_price, '20L price'));
        }
        if (low_stock_threshold !== undefined) {
            updates.push('low_stock_threshold = ?');
            params.push(
                parseNonNegativeInteger(
                    low_stock_threshold,
                    'Low stock threshold'
                )
            );
        }
        if (units_per_carton !== undefined) {
            updates.push('units_per_carton = ?');
            params.push(newUnitsPerCarton);
        }

        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(req.params.id);
        if (updates.length === 1)
            return res.status(400).json({ error: 'No fields to update' });

        const transaction = db.transaction(() => {
            db.prepare(
                `UPDATE products SET ${updates.join(', ')} WHERE id = ? AND is_active = 1`
            ).run(...params);

            // Legacy conversion: a product whose units_per_carton was 0 (pending
            // review) still holds its old carton count in carton_stock. Once the
            // admin sets units_per_carton, convert cartons -> total units.
            if (existing.units_per_carton === 0 && newUnitsPerCarton > 0) {
                const legacy = db
                    .prepare(
                        'SELECT id, carton_stock FROM product_stock WHERE product_id = ? AND carton_stock > 0'
                    )
                    .all(req.params.id);
                const convert = db.prepare(
                    'UPDATE product_stock SET unit_stock = unit_stock + ?, carton_stock = 0 WHERE id = ?'
                );
                for (const row of legacy) {
                    convert.run(row.carton_stock * newUnitsPerCarton, row.id);
                }
                db.prepare(
                    'UPDATE sale_items SET units_per_carton=? WHERE product_id=? AND units_per_carton=0'
                ).run(newUnitsPerCarton, req.params.id);
                db.prepare(
                    "UPDATE alerts SET is_read=1 WHERE product_id=? AND type='system' AND message LIKE 'Inventory review required:%'"
                ).run(req.params.id);
            }
        });
        transaction();

        logAudit(req.user.id, 'product.update', 'product', req.params.id);
        res.json({ message: 'Product updated successfully' });
    } catch (err) {
        sendSafeError(res, err, '[products]');
    }
});

router.delete('/:id', requirePermission('manage_products'), (req, res) => {
    try {
        const productId = req.params.id;
        const product = db
            .prepare('SELECT id, name, is_active FROM products WHERE id = ?')
            .get(productId);
        if (!product || product.is_active === 0)
            return res.status(404).json({ error: 'Product not found' });

        // Archive rather than hard-delete so that sale items, returns, stock
        // movements, transfers, and financial history are preserved.
        const result = db
            .prepare(
                'UPDATE products SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND is_active = 1'
            )
            .run(productId);
        if (result.changes === 0)
            return res.status(404).json({ error: 'Product not found' });

        logAudit(req.user.id, 'product.archive', 'product', productId, {
            name: product.name
        });
        res.json({ message: 'Product archived successfully' });
    } catch (err) {
        sendSafeError(res, err, '[products]');
    }
});

router.post(
    '/:id/stock-movement',
    requirePermission('manage_products'),
    (req, res) => {
        try {
            const {
                movement_type,
                unit_type,
                quantity,
                warehouse_id,
                reference_id,
                reference_type,
                notes
            } = req.body;
            const productId = req.params.id;
            if (
                !movement_type ||
                !unit_type ||
                quantity === undefined ||
                !warehouse_id
            )
                return res.status(400).json({
                    error: 'Movement type, unit type, quantity, and warehouse are required'
                });
            if (!UNIT_TYPES.includes(unit_type))
                return res.status(400).json({ error: 'Invalid unit type' });
            const qty = parsePositiveInteger(quantity, 'Quantity');

            const product = db
                .prepare(
                    'SELECT id, units_per_carton FROM products WHERE id = ? AND is_active = 1'
                )
                .get(productId);
            if (!product)
                return res
                    .status(400)
                    .json({ error: 'Product not found or archived' });
            const warehouse = db
                .prepare(
                    'SELECT id FROM warehouses WHERE id = ? AND is_active = 1'
                )
                .get(warehouse_id);
            if (!warehouse)
                return res
                    .status(400)
                    .json({ error: 'Warehouse not found or inactive' });

            // 'unit' and 'carton' both draw from unit_stock; cartons are converted to units.
            const stockField = stockColumn(unit_type);
            const unitsDelta = toUnits(
                unit_type,
                qty,
                product.units_per_carton
            );

            const row = db
                .prepare(
                    `SELECT ${stockField} as current_stock FROM product_stock WHERE product_id = ? AND warehouse_id = ?`
                )
                .get(productId, warehouse_id);
            if (!row)
                return res.status(404).json({
                    error: 'Product stock not found for this warehouse'
                });

            const currentStock = row.current_stock;
            if (!Number.isSafeInteger(currentStock + unitsDelta))
                throw new ClientError(
                    400,
                    'Stock quantity is outside the supported range'
                );
            let newStock;
            if (
                movement_type === 'in' ||
                movement_type === 'adjustment_positive'
            )
                newStock = currentStock + unitsDelta;
            else if (
                movement_type === 'out' ||
                movement_type === 'adjustment_negative'
            ) {
                newStock = currentStock - unitsDelta;
                if (newStock < 0)
                    return res.status(400).json({
                        error: 'Insufficient stock in this warehouse'
                    });
            } else
                return res.status(400).json({ error: 'Invalid movement type' });

            const transaction = db.transaction(() => {
                const updated = db
                    .prepare(
                        `UPDATE product_stock SET ${stockField} = ?, updated_at = CURRENT_TIMESTAMP WHERE product_id = ? AND warehouse_id = ?`
                    )
                    .run(newStock, productId, warehouse_id);
                if (updated.changes === 0)
                    throw new ClientError(409, 'Stock could not be updated');
                db.prepare(
                    `INSERT INTO stock_movements (id, product_id, warehouse_id, movement_type, unit_type, quantity, reference_id, reference_type, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                ).run(
                    uuidv4(),
                    productId,
                    warehouse_id,
                    movement_type,
                    unit_type,
                    qty,
                    reference_id || null,
                    reference_type || 'stock_adjustment',
                    notes || null,
                    req.user.id
                );
            });
            transaction();

            checkLowStock(
                productId,
                warehouse_id,
                unit_type,
                newStock,
                currentStock
            );
            logAudit(req.user.id, 'stock.adjust', 'product', productId, {
                movement_type,
                unit_type,
                quantity: qty,
                warehouse_id
            });
            res.json({
                message: 'Stock movement recorded',
                new_stock: newStock
            });
        } catch (err) {
            sendSafeError(res, err, '[products]');
        }
    }
);

router.get('/:id/movements', (req, res) => {
    try {
        const { warehouse_id, limit = 50, offset = 0 } = req.query;
        let query = `SELECT sm.*, u.username as created_by_name, w.name as warehouse_name FROM stock_movements sm LEFT JOIN users u ON sm.created_by = u.id LEFT JOIN warehouses w ON sm.warehouse_id = w.id WHERE sm.product_id = ?`;
        const params = [req.params.id];
        if (warehouse_id) {
            query += ' AND sm.warehouse_id = ?';
            params.push(warehouse_id);
        }
        query += ' ORDER BY sm.created_at DESC LIMIT ? OFFSET ?';
        params.push(parseLimit(limit, 50), parseOffset(offset));
        res.json(db.prepare(query).all(...params));
    } catch (err) {
        sendSafeError(res, err, '[products]');
    }
});

function safeSheetName(name, fallback) {
    let base = String(name || fallback || 'Warehouse')
        .replace(/[\\/?*[\]:]/g, ' ')
        .trim();
    if (!base) base = 'Warehouse';
    if (base.length > 31) base = base.slice(0, 31);
    return base;
}

router.get('/stock/export', (req, res) => {
    try {
        const { warehouse_id, format = 'excel' } = req.query;

        const warehouses = warehouse_id
            ? db
                  .prepare(
                      'SELECT id, name, code FROM warehouses WHERE id = ? AND is_active = 1'
                  )
                  .all(warehouse_id)
            : db
                  .prepare(
                      'SELECT id, name, code FROM warehouses WHERE is_active = 1 ORDER BY name'
                  )
                  .all();

        if (warehouse_id && warehouses.length === 0) {
            return res.status(404).json({ error: 'Warehouse not found' });
        }

        const stockQuery = `
            SELECT p.name, p.sku, p.unit_price, p.carton_price, p.liter20_price, p.units_per_carton, p.low_stock_threshold,
                   ps.unit_stock, ps.liter20_stock
            FROM products p JOIN product_stock ps ON p.id = ps.product_id
            WHERE p.is_active = 1 AND ps.warehouse_id = ?
            ORDER BY p.name
        `;

        if (format === 'excel') {
            const ExcelJS = require('exceljs');
            const workbook = new ExcelJS.Workbook();
            const used = new Set();
            const isAdmin = req.user && req.user.role === 'admin';

            for (const wh of warehouses) {
                const rows = db.prepare(stockQuery).all(wh.id);

                let sheetName = safeSheetName(wh.name, wh.code);
                let candidate = sheetName;
                let n = 2;
                while (used.has(candidate.toLowerCase())) {
                    const suffix = ` (${n++})`;
                    candidate = sheetName.slice(0, 31 - suffix.length) + suffix;
                }
                used.add(candidate.toLowerCase());

                const ws = workbook.addWorksheet(candidate);
                const columns = [
                    { header: 'Product', key: 'name', width: 30 },
                    { header: 'SKU', key: 'sku', width: 15 },
                    { header: 'Unit Price (₵)', key: 'unit_price', width: 16 },
                    {
                        header: 'Carton Price (₵)',
                        key: 'carton_price',
                        width: 18
                    },
                    {
                        header: '20L Price (₵)',
                        key: 'liter20_price',
                        width: 16
                    },
                    {
                        header: 'Units/Carton',
                        key: 'units_per_carton',
                        width: 12
                    },
                    { header: 'Cartons', key: 'cartons', width: 12 },
                    { header: 'Loose Units', key: 'loose_units', width: 12 },
                    { header: 'Total Units', key: 'total_units', width: 12 },
                    { header: '20L Stock', key: 'liter20_stock', width: 12 },
                    { header: 'Reorder Level', key: 'threshold', width: 14 }
                ];
                if (isAdmin)
                    columns.push({
                        header: 'Total Value (₵)',
                        key: 'total_value',
                        width: 18
                    });
                ws.columns = columns;

                rows.forEach((r) => {
                    const split = splitUnits(r.unit_stock, r.units_per_carton);
                    const row = {
                        name: sanitizeCell(r.name),
                        sku: sanitizeCell(r.sku || ''),
                        unit_price: r.unit_price,
                        carton_price: r.carton_price,
                        liter20_price: r.liter20_price,
                        units_per_carton: r.units_per_carton,
                        cartons: split.cartons,
                        loose_units: split.units,
                        total_units: r.unit_stock,
                        liter20_stock: r.liter20_stock,
                        threshold: r.low_stock_threshold
                    };
                    if (isAdmin)
                        row.total_value =
                            r.unit_price * r.unit_stock +
                            r.liter20_price * r.liter20_stock;
                    ws.addRow(row);
                });
                ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
                ws.getRow(1).fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: '1E40AF' }
                };
                ['unit_price', 'carton_price', 'liter20_price'].forEach(
                    (k) => (ws.getColumn(k).numFmt = '₵#,##0.00')
                );
                if (isAdmin) ws.getColumn('total_value').numFmt = '₵#,##0.00';
            }

            const filename = `VEEMENZ-Stock-${new Date().toISOString().split('T')[0]}.xlsx`;
            res.setHeader(
                'Content-Type',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            );
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="${filename}"`
            );
            return workbook.xlsx.write(res).then(() => res.end());
        }

        const rows = warehouses.flatMap((wh) =>
            db
                .prepare(stockQuery)
                .all(wh.id)
                .map((r) => ({
                    ...r,
                    warehouse_id: wh.id,
                    warehouse_name: wh.name,
                    warehouse_code: wh.code
                }))
        );
        res.json(rows);
    } catch (err) {
        console.error('Export error:', err);
        sendSafeError(res, err, '[products]');
    }
});

module.exports = router;
