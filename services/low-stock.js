const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { notifyLowStock } = require('./notifications');

// Emit a low-stock alert + notification only when stock *crosses into* the
// low-stock state (was above threshold, now at/below). This prevents spamming
// an alert on every movement while already low, and re-alerts after recovery.
function checkLowStock(productId, warehouseId, unitType, newStock, oldStock) {
    const db = getDb();
    const row = db.prepare('SELECT low_stock_threshold, name FROM products WHERE id = ?').get(productId);
    if (!row) return;

    const threshold = row.low_stock_threshold;
    const crossedIntoLow = oldStock == null
        ? newStock <= threshold
        : (oldStock > threshold && newStock <= threshold);

    if (!crossedIntoLow) return;

    db.prepare('INSERT INTO alerts (id, type, product_id, warehouse_id, message, severity) VALUES (?, ?, ?, ?, ?, ?)')
        .run(uuidv4(), 'low_stock', productId, warehouseId,
            `Low stock alert: ${row.name} (${unitType}) has ${newStock} remaining (threshold: ${threshold})`, 'warning');

    const wh = db.prepare('SELECT name FROM warehouses WHERE id = ?').get(warehouseId);
    notifyLowStock({ productName: row.name, warehouseName: wh?.name || 'Warehouse', unitType, current: newStock, threshold });
}

module.exports = { checkLowStock };
