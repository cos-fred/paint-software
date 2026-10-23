const { randomUUID } = require('node:crypto');
const { getDb } = require('../database');
const { stockColumn, toUnits } = require('../lib/stock');
const { recordStockChange } = require('./low-stock');
const { ClientError } = require('../lib/errors');
const { cumulativeCredit, amount } = require('../lib/money');

function returnableItems(saleId) {
    return getDb()
        .prepare(
            `SELECT si.*, p.name AS product_name,
        COALESCE((SELECT SUM(sr.quantity) FROM sale_returns sr WHERE sr.sale_item_id=si.id),0) AS returned_quantity,
        COALESCE((SELECT SUM(sr.amount_cents) FROM sale_returns sr WHERE sr.sale_item_id=si.id),0) AS returned_cents
        FROM sale_items si JOIN products p ON p.id=si.product_id WHERE si.sale_id=? ORDER BY si.rowid`
        )
        .all(saleId)
        .map((item) => ({
            ...item,
            remaining_quantity: item.quantity - item.returned_quantity
        }));
}

// Must be called inside the caller's transaction. All reversals use this path.
function creditItem(
    item,
    quantity,
    userId,
    reason,
    kind = 'return',
    stockChanges
) {
    if (quantity <= 0 || quantity > item.remaining_quantity)
        throw new ClientError(
            400,
            'Return quantity exceeds the remaining returnable quantity for this item'
        );
    const db = getDb();
    const newReturned = item.returned_quantity + quantity;
    const credit =
        cumulativeCredit(item.net_total_cents, newReturned, item.quantity) -
        item.returned_cents;
    if (credit < 0)
        throw new ClientError(409, 'Return history needs reconciliation');
    const id = randomUUID();
    db.prepare(
        `INSERT INTO sale_returns (id,sale_id,sale_item_id,product_id,warehouse_id,unit_type,quantity,unit_price,line_total,amount_cents,reason,kind,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
        id,
        item.sale_id,
        item.id,
        item.product_id,
        item.warehouse_id,
        item.unit_type,
        quantity,
        item.unit_price,
        amount(credit),
        credit,
        reason || null,
        kind,
        userId
    );
    const units = toUnits(item.unit_type, quantity, item.units_per_carton);
    const column = stockColumn(item.unit_type);
    const before = db
        .prepare(
            `SELECT ${column} AS stock FROM product_stock WHERE product_id=? AND warehouse_id=?`
        )
        .get(item.product_id, item.warehouse_id);
    if (!before)
        throw new ClientError(
            409,
            'Product stock row not found for this warehouse'
        );
    const restored = db
        .prepare(
            `UPDATE product_stock SET ${column}=${column}+?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND warehouse_id=?`
        )
        .run(units, item.product_id, item.warehouse_id);
    if (!restored.changes)
        throw new ClientError(
            409,
            'Product stock row not found for this warehouse'
        );
    if (stockChanges)
        recordStockChange(
            stockChanges,
            item.product_id,
            item.warehouse_id,
            item.unit_type,
            before.stock,
            before.stock + units
        );
    db.prepare(
        `INSERT INTO stock_movements (id,product_id,warehouse_id,movement_type,unit_type,quantity,reference_id,reference_type,notes,created_by)
        VALUES (?,?,?,'return_in',?,?,?,'return',?,?)`
    ).run(
        randomUUID(),
        item.product_id,
        item.warehouse_id,
        item.unit_type,
        quantity,
        id,
        reason || null,
        userId
    );
    item.returned_quantity = newReturned;
    item.returned_cents += credit;
    item.remaining_quantity -= quantity;
    require('./payments').refreshPaymentStatus(item.sale_id);
    return credit;
}

module.exports = { returnableItems, creditItem };
