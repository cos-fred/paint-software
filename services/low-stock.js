const { randomUUID } = require('node:crypto');
const { getDb } = require('../database');
const { notifyLowStock } = require('./notifications');
const { stockColumn } = require('../lib/stock');

// Aggregate returns by pool, then publish only after the stock transaction.
function recordStockChange(
    changes,
    productId,
    warehouseId,
    unitType,
    oldStock,
    newStock
) {
    const key = `${productId}:${warehouseId}:${stockColumn(unitType)}`;
    const existing = changes.get(key);
    if (existing) existing.newStock = newStock;
    else
        changes.set(key, {
            productId,
            warehouseId,
            unitType,
            oldStock,
            newStock
        });
}

function publishStockChanges(changes) {
    for (const change of changes.values()) {
        try {
            checkLowStock(
                change.productId,
                change.warehouseId,
                change.unitType,
                change.newStock,
                change.oldStock
            );
        } catch (error) {
            console.error('[stock] alert update failed:', error.message);
        }
    }
}

function checkLowStock(productId, warehouseId, unitType, newStock, oldStock) {
    const db = getDb();
    const product = db
        .prepare(
            'SELECT low_stock_threshold,name,units_per_carton FROM products WHERE id=?'
        )
        .get(productId);
    if (!product) return;
    const pool = stockColumn(unitType);
    const threshold = product.low_stock_threshold ?? 10;
    const cartonPool = pool === 'unit_stock' && product.units_per_carton > 0;
    const quantity = (value) =>
        cartonPool ? Math.floor(value / product.units_per_carton) : value;
    const current = quantity(newStock);
    const previous = oldStock == null ? null : quantity(oldStock);
    const enteredLow =
        current <= threshold && (previous == null || previous > threshold);
    const recovered =
        current > threshold && previous != null && previous <= threshold;
    if (!enteredLow && !recovered) return;
    const warehouse = db
        .prepare('SELECT name FROM warehouses WHERE id=?')
        .get(warehouseId);
    const unit =
        pool === 'liter20_stock'
            ? '20L container'
            : cartonPool
              ? 'carton'
              : 'unit';
    const label = `${unit}${current === 1 ? '' : 's'}`;
    const message = `${recovered ? 'Stock recovered' : 'Low stock alert'}: ${product.name}${warehouse ? ` (${warehouse.name})` : ''} has ${current} ${label} remaining (threshold: ${threshold})`;
    db.transaction(() => {
        if (recovered) {
            db.prepare(
                "UPDATE alerts SET is_read=1 WHERE product_id=? AND warehouse_id=? AND stock_pool=? AND type IN ('low_stock','out_of_stock') AND is_read=0"
            ).run(productId, warehouseId, pool);
        }
        db.prepare(
            'INSERT INTO alerts(id,type,product_id,warehouse_id,message,severity,stock_pool) VALUES(?,?,?,?,?,?,?)'
        ).run(
            randomUUID(),
            recovered ? 'system' : 'low_stock',
            productId,
            warehouseId,
            message,
            recovered ? 'info' : 'warning',
            pool
        );
    })();
    const notificationUnit =
        pool === 'liter20_stock' ? 'liter20' : cartonPool ? 'carton' : 'unit';
    void notifyLowStock({
        productName: product.name,
        warehouseName: warehouse?.name || 'Warehouse',
        unitType: notificationUnit,
        current,
        threshold,
        recovered
    });
}

module.exports = { checkLowStock, recordStockChange, publishStockChanges };
