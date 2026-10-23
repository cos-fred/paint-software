const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function hasUpgrade(db, version = 2) {
    const exists = db
        .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
        )
        .get();
    return (
        !!exists &&
        !!db
            .prepare('SELECT 1 FROM schema_migrations WHERE version=?')
            .get(version)
    );
}

// VACUUM INTO produces a consistent snapshot, including committed WAL contents.
// Take it before any schema changes, so recovery also covers older migrations.
function snapshotBeforeUpgrade(db, dbPath, version = 2) {
    if (
        hasUpgrade(db, version) ||
        !db
            .prepare(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sale_items'"
            )
            .get()
    )
        return null;
    const directory = path.join(
        path.dirname(path.resolve(dbPath)),
        'migration-backups'
    );
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const destination = path.join(
        directory,
        `${path.basename(dbPath)}.before-v${version}-${randomUUID()}.db`
    );
    db.prepare('VACUUM INTO ?').run(destination);
    fs.chmodSync(destination, 0o600);
    return destination;
}

function runUpgradeSafeguards(db, backupPath) {
    require('./legacy-stock').assertLegacyStockUnambiguous(db, backupPath);
    if (hasUpgrade(db)) return;
    db.transaction(() => {
        const columns = (table) =>
            db
                .prepare(`PRAGMA table_info(${table})`)
                .all()
                .map((c) => c.name);
        if (!columns('sale_items').includes('discount')) {
            db.exec(
                'ALTER TABLE sale_items ADD COLUMN discount REAL NOT NULL DEFAULT 0 CHECK(discount>=0)'
            );
        }
        // Preserve historical totals and allocated credits; remove the obsolete
        // tax field itself rather than changing the value of completed sales.
        if (columns('sales').includes('tax'))
            db.exec('ALTER TABLE sales DROP COLUMN tax');
        db.prepare(
            "DELETE FROM settings WHERE key IN ('tax_rate','tax_enabled')"
        ).run();
        db.exec(`UPDATE sale_items SET units_per_carton=COALESCE(
            (SELECT units_per_carton FROM products WHERE products.id=sale_items.product_id),0)
            WHERE units_per_carton=0 AND (SELECT units_per_carton FROM products WHERE products.id=sale_items.product_id)>0`);
        // Mixed positive balances require explicit review, never an assumption
        // that cartons were already included or should be added a second time.
        db.exec(`UPDATE product_stock SET unit_stock=
            carton_stock*(SELECT units_per_carton FROM products WHERE products.id=product_stock.product_id),
            carton_stock=0,updated_at=CURRENT_TIMESTAMP
            WHERE unit_stock=0 AND carton_stock>0 AND (SELECT units_per_carton FROM products WHERE products.id=product_stock.product_id)>0`);
        if (!columns('alerts').includes('stock_pool')) {
            db.exec(
                "ALTER TABLE alerts ADD COLUMN stock_pool TEXT CHECK(stock_pool IN ('unit_stock','liter20_stock'))"
            );
        }
        db.exec(`UPDATE alerts SET stock_pool=CASE WHEN message LIKE '% 20L container remaining (threshold:%)' OR message LIKE '% 20L containers remaining (threshold:%)' THEN 'liter20_stock' ELSE 'unit_stock' END
            WHERE type IN ('low_stock','out_of_stock') AND stock_pool IS NULL;
            CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id)`);
        for (const row of db
            .prepare(
                `SELECT ps.product_id,ps.warehouse_id,ps.carton_stock,p.name,w.name AS warehouse
            FROM product_stock ps JOIN products p ON p.id=ps.product_id LEFT JOIN warehouses w ON w.id=ps.warehouse_id
            WHERE ps.carton_stock>0 AND p.units_per_carton<=0 AND p.is_active=1`
            )
            .all()) {
            db.prepare(
                "INSERT INTO alerts(id,type,product_id,warehouse_id,message,severity) VALUES(?,'system',?,?,?,'warning')"
            ).run(
                randomUUID(),
                row.product_id,
                row.warehouse_id,
                `Inventory review required: ${row.name} (${row.warehouse || 'Warehouse'}) has ${row.carton_stock} legacy cartons. Edit the product and set its units per carton before selling cartons.`
            );
        }
        if (!columns('schema_migrations').includes('backup_path'))
            db.exec(
                'ALTER TABLE schema_migrations ADD COLUMN backup_path TEXT'
            );
        db.prepare(
            'INSERT INTO schema_migrations(version,backup_path) VALUES(2,?)'
        ).run(backupPath || null);
    }).immediate();
}

module.exports = { snapshotBeforeUpgrade, runUpgradeSafeguards };
