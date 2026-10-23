const { randomUUID } = require('node:crypto');
const { getDb } = require('../database');
const { ClientError } = require('../lib/errors');
const { parseNonNegativeInteger } = require('../lib/validation');
const { logAudit } = require('./audit');
const { recordStockChange, publishStockChanges } = require('./low-stock');
function detail(id) {
    const db = getDb();
    const row = db
        .prepare(
            'SELECT st.*,w.name AS warehouse_name,u.username AS created_by_name,a.username AS approved_by_name FROM stocktakes st JOIN warehouses w ON w.id=st.warehouse_id LEFT JOIN users u ON u.id=st.created_by LEFT JOIN users a ON a.id=st.approved_by WHERE st.id=?'
        )
        .get(id);
    if (!row) throw new ClientError(404, 'Stocktake not found');
    return {
        ...row,
        items: db
            .prepare(
                `SELECT si.*,ps.unit_stock AS current_units,ps.liter20_stock AS current_liter20,p.units_per_carton AS current_carton_size,p.is_active
        FROM stocktake_items si LEFT JOIN product_stock ps ON ps.product_id=si.product_id AND ps.warehouse_id=? LEFT JOIN products p ON p.id=si.product_id WHERE stocktake_id=? ORDER BY product_name,si.id`
            )
            .all(row.warehouse_id, id)
    };
}
function capture(db, id, warehouseId) {
    const products = db
        .prepare(
            `SELECT p.id,p.name,p.sku,p.units_per_carton,ps.unit_stock,ps.liter20_stock,ps.carton_stock FROM products p JOIN product_stock ps ON ps.product_id=p.id WHERE p.is_active=1 AND ps.warehouse_id=? ORDER BY p.name,p.id`
        )
        .all(warehouseId);
    if (!products.length)
        throw new ClientError(
            400,
            'This warehouse has no active products to count'
        );
    if (products.some((p) => p.carton_stock > 0))
        throw new ClientError(
            409,
            'Resolve legacy carton quantities before starting a stocktake'
        );
    const insert = db.prepare(
        'INSERT INTO stocktake_items(id,stocktake_id,product_id,product_name,sku,units_per_carton,expected_units,expected_liter20) VALUES(?,?,?,?,?,?,?,?)'
    );
    for (const p of products)
        insert.run(
            randomUUID(),
            id,
            p.id,
            p.name,
            p.sku,
            p.units_per_carton,
            p.unit_stock,
            p.liter20_stock
        );
}
function revision(row, value) {
    if (!Number.isInteger(value) || value !== row.revision)
        throw new ClientError(
            409,
            'This stocktake changed. Reload it before continuing.'
        );
    if (['approved', 'cancelled'].includes(row.status))
        throw new ClientError(409, 'This stocktake is already final');
}
function create(req) {
    const db = getDb(),
        id = randomUUID(),
        warehouse = req.body.warehouse_id;
    if (
        !db
            .prepare('SELECT 1 FROM warehouses WHERE id=? AND is_active=1')
            .get(warehouse)
    )
        throw new ClientError(400, 'Select an active warehouse');
    db.transaction(() => {
        db.prepare(
            'INSERT INTO stocktakes(id,warehouse_id,created_by) VALUES(?,?,?)'
        ).run(id, warehouse, req.user.id);
        capture(db, id, warehouse);
        logAudit(req.user.id, 'stocktake.create', 'stocktake', id, {
            warehouse_id: warehouse
        });
    }).immediate();
    return detail(id);
}
function update(req, id, action) {
    const db = getDb(),
        changes = new Map();
    db.transaction(() => {
        const row = detail(id);
        revision(row, req.body.revision);
        if (
            action !== 'cancel' &&
            !db
                .prepare('SELECT 1 FROM warehouses WHERE id=? AND is_active=1')
                .get(row.warehouse_id)
        )
            throw new ClientError(409, 'Warehouse is inactive');
        if (action === 'approve') {
            if (req.user.role !== 'admin')
                throw new ClientError(
                    403,
                    'Only the owner can approve a stocktake'
                );
            if (row.status !== 'submitted')
                throw new ClientError(409, 'Submit the count before approval');
            const currentCount = db
                .prepare(
                    'SELECT COUNT(*) AS n FROM product_stock ps JOIN products p ON p.id=ps.product_id WHERE ps.warehouse_id=? AND p.is_active=1'
                )
                .get(row.warehouse_id).n;
            if (currentCount !== row.items.length)
                throw new ClientError(
                    409,
                    'The product list changed during counting. Refresh and recount before approval.'
                );
            for (const item of row.items) {
                if (
                    !item.is_active ||
                    item.current_units !== item.expected_units ||
                    item.current_liter20 !== item.expected_liter20 ||
                    item.current_carton_size !== item.units_per_carton
                )
                    throw new ClientError(
                        409,
                        'Stock or product details changed during counting. Refresh the stocktake and recount before approval.'
                    );
                if (item.counted_units == null || item.counted_liter20 == null)
                    throw new ClientError(400, 'Every product must be counted');
                for (const [column, type, counted, expected] of [
                    [
                        'unit_stock',
                        'unit',
                        item.counted_units,
                        item.expected_units
                    ],
                    [
                        'liter20_stock',
                        'liter20',
                        item.counted_liter20,
                        item.expected_liter20
                    ]
                ]) {
                    const delta = counted - expected;
                    if (!delta) continue;
                    db.prepare(
                        `UPDATE product_stock SET ${column}=?,updated_at=CURRENT_TIMESTAMP WHERE product_id=? AND warehouse_id=?`
                    ).run(counted, item.product_id, row.warehouse_id);
                    db.prepare(
                        "INSERT INTO stock_movements(id,product_id,warehouse_id,movement_type,unit_type,quantity,reference_id,reference_type,notes,created_by) VALUES(?,?,?,?,?,?,?,'stock_adjustment',?,?)"
                    ).run(
                        randomUUID(),
                        item.product_id,
                        row.warehouse_id,
                        delta > 0
                            ? 'adjustment_positive'
                            : 'adjustment_negative',
                        type,
                        Math.abs(delta),
                        id,
                        'Stocktake ' + id.slice(0, 8) + ': ' + row.notes,
                        req.user.id
                    );
                    recordStockChange(
                        changes,
                        item.product_id,
                        row.warehouse_id,
                        type,
                        expected,
                        counted
                    );
                }
            }
            db.prepare(
                "UPDATE stocktakes SET status='approved',approved_by=?,approved_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,revision=revision+1 WHERE id=?"
            ).run(req.user.id, id);
        } else if (action === 'recount') {
            db.prepare('DELETE FROM stocktake_items WHERE stocktake_id=?').run(
                id
            );
            capture(db, id, row.warehouse_id);
            db.prepare(
                "UPDATE stocktakes SET status='draft',revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?"
            ).run(id);
        } else if (action === 'cancel') {
            db.prepare(
                "UPDATE stocktakes SET status='cancelled',revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?"
            ).run(id);
        } else {
            if (row.status !== 'draft')
                throw new ClientError(
                    409,
                    'Request a recount to edit a submitted stocktake'
                );
            const notes = req.body.notes ?? row.notes;
            if (typeof notes !== 'string' || notes.length > 2000)
                throw new ClientError(400, 'Invalid stocktake notes');
            const items = req.body.items;
            if (!Array.isArray(items) || items.length > 5000)
                throw new ClientError(400, 'Invalid stocktake counts');
            const allowed = new Set(row.items.map((i) => i.id)),
                seen = new Set();
            for (const item of items) {
                if (!item || !allowed.has(item.id) || seen.has(item.id))
                    throw new ClientError(
                        400,
                        'Invalid or duplicate count row'
                    );
                seen.add(item.id);
                const units =
                    item.counted_units == null
                        ? null
                        : parseNonNegativeInteger(
                              item.counted_units,
                              'Counted units'
                          );
                const liters =
                    item.counted_liter20 == null
                        ? null
                        : parseNonNegativeInteger(
                              item.counted_liter20,
                              'Counted 20L containers'
                          );
                db.prepare(
                    'UPDATE stocktake_items SET counted_units=?,counted_liter20=? WHERE id=? AND stocktake_id=?'
                ).run(units, liters, item.id, id);
            }
            const missing = db
                .prepare(
                    'SELECT COUNT(*) AS n FROM stocktake_items WHERE stocktake_id=? AND (counted_units IS NULL OR counted_liter20 IS NULL)'
                )
                .get(id).n;
            if (action === 'submit' && missing)
                throw new ClientError(
                    400,
                    'Count every product before submitting'
                );
            if (
                action === 'submit' &&
                row.items.some((i) => {
                    const updated = db
                        .prepare(
                            'SELECT counted_units,counted_liter20 FROM stocktake_items WHERE id=?'
                        )
                        .get(i.id);
                    return (
                        updated.counted_units !== i.expected_units ||
                        updated.counted_liter20 !== i.expected_liter20
                    );
                }) &&
                !notes.trim()
            )
                throw new ClientError(
                    400,
                    'Explain stock differences in the notes before submitting'
                );
            db.prepare(
                'UPDATE stocktakes SET notes=?,status=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?'
            ).run(
                notes.trim(),
                action === 'submit' ? 'submitted' : 'draft',
                id
            );
        }
        logAudit(req.user.id, `stocktake.${action}`, 'stocktake', id);
    }).immediate();
    publishStockChanges(changes);
    return detail(id);
}
module.exports = { detail, create, update };
