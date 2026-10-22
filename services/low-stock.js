const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { notifyLowStock } = require('./notifications');
const { splitUnits } = require('../lib/stock');

// Emit a low-stock alert + notification only when stock *crosses into* the
// low-stock state (was above threshold, now at/below). This prevents spamming
// an alert on every movement while already low, and re-alerts after recovery.
function checkLowStock(productId, warehouseId, unitType, newStock, oldStock) {
    const db = getDb();
    const product = db.prepare('SELECT low_stock_threshold, name, units_per_carton, liter20_price FROM products WHERE id = ?').get(productId);
    if (!product) return;

    const threshold = product.low_stock_threshold ?? 10;
    const unitsPerCarton = product.units_per_carton || 0;

    let crossedIntoLow = false;
    let currentQty = 0;
    let label = '';
    let notificationUnitType = unitType;

    if (unitType === 'carton' || unitType === 'unit') {
        const oldCartons = oldStock != null ? (unitsPerCarton > 0 ? Math.floor(oldStock / unitsPerCarton) : oldStock) : null;
        const newCartons = unitsPerCarton > 0 ? Math.floor(newStock / unitsPerCarton) : newStock;
        crossedIntoLow = oldCartons == null
            ? newCartons <= threshold
            : (oldCartons > threshold && newCartons <= threshold);
        currentQty = newCartons;
        label = unitsPerCarton > 0 ? `carton${newCartons === 1 ? '' : 's'}` : `unit${newCartons === 1 ? '' : 's'}`;
        notificationUnitType = unitsPerCarton > 0 ? 'carton' : 'unit';
    } else if (unitType === 'liter20') {
        crossedIntoLow = oldStock == null
            ? newStock <= threshold
            : (oldStock > threshold && newStock <= threshold);
        currentQty = newStock;
        label = `20L container${newStock === 1 ? '' : 's'}`;
        notificationUnitType = 'liter20';
    }

    if (!crossedIntoLow) return;

    const wh = db.prepare('SELECT name FROM warehouses WHERE id = ?').get(warehouseId);
    const whLabel = wh ? ` (${wh.name})` : '';
    const message = `Low stock alert: ${product.name}${whLabel} has ${currentQty} ${label} remaining (threshold: ${threshold})`;
    db.prepare('INSERT INTO alerts (id, type, product_id, warehouse_id, message, severity) VALUES (?, ?, ?, ?, ?, ?)')
        .run(uuidv4(), 'low_stock', productId, warehouseId, message, 'warning');

    notifyLowStock({ productName: product.name, warehouseName: wh?.name || 'Warehouse', unitType: notificationUnitType, current: currentQty, threshold });
}

module.exports = { checkLowStock };
