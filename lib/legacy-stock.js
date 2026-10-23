function columns(db, table) {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function ambiguousLegacyStock(db) {
    const stockColumns = columns(db, 'product_stock');
    if (!['unit_stock', 'carton_stock'].every((name) => stockColumns.includes(name)))
        return [];
    const productColumns = columns(db, 'products');
    const warehouseColumns = columns(db, 'warehouses');
    const productFields = ['name', 'units_per_carton'].filter((name) => productColumns.includes(name));
    const productInfo = productFields.length
        ? db.prepare(`SELECT ${productFields.join(',')} FROM products WHERE id=?`) : null;
    const warehouseName = warehouseColumns.includes('name')
        ? db.prepare('SELECT name FROM warehouses WHERE id=?') : null;
    return db.prepare(`SELECT id,product_id,warehouse_id,unit_stock,carton_stock
        FROM product_stock WHERE unit_stock>0 AND carton_stock>0 ORDER BY product_id,warehouse_id`)
        .all().map((row) => {
            const product = productInfo?.get(row.product_id);
            return {
                ...row,
                product_name: product?.name || row.product_id,
                units_per_carton: product?.units_per_carton || null,
                warehouse_name: warehouseName?.get(row.warehouse_id)?.name || row.warehouse_id
            };
        });
}

function assertLegacyStockUnambiguous(db, backupPath) {
    const rows = ambiguousLegacyStock(db);
    if (!rows.length) return;
    const details = rows.map((row) =>
        `${row.product_name} (${row.warehouse_name}; stock ID ${row.id}): ${row.unit_stock} units and ${row.carton_stock} legacy cartons`
    ).join('; ');
    throw new Error(`Legacy stock review required. Both quantities have been preserved: ${details}. ` +
        'Stop the server and use scripts/reconcile-legacy-stock.js to inspect and enter a confirmed total; see docs/RECOVERY.md.' +
        (backupPath ? ` Pre-upgrade snapshot: ${backupPath}` : ''));
}

module.exports = { ambiguousLegacyStock, assertLegacyStockUnambiguous };
