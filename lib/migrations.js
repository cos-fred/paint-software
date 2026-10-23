const { randomUUID } = require('node:crypto');
const { allocate, cumulativeCredit } = require('./money');

function runLaunchMigrations(db) {
    db.exec(
        `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`
    );
    const add = (table, name, definition) => {
        if (
            !db
                .prepare(`PRAGMA table_info(${table})`)
                .all()
                .some((column) => column.name === name)
        )
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    };
    db.transaction(() => {
        if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=1').get())
            return;
        add(
            'products',
            'carton_price_mode',
            "TEXT NOT NULL DEFAULT 'auto' CHECK(carton_price_mode IN ('auto','manual'))"
        );
        const productCols = db
            .prepare('PRAGMA table_info(products)')
            .all()
            .map((c) => c.name);
        if (productCols.includes('carton_price'))
            db.exec(
                `UPDATE products SET carton_price_mode=CASE WHEN ABS(carton_price-unit_price*units_per_carton)<0.005 THEN 'auto' ELSE 'manual' END`
            );
        add(
            'sale_items',
            'net_total_cents',
            'INTEGER NOT NULL DEFAULT 0 CHECK(net_total_cents>=0)'
        );
        add('sale_returns', 'sale_item_id', 'TEXT REFERENCES sale_items(id)');
        add(
            'sale_returns',
            'amount_cents',
            'INTEGER NOT NULL DEFAULT 0 CHECK(amount_cents>=0)'
        );
        add(
            'sale_returns',
            'kind',
            "TEXT NOT NULL DEFAULT 'return' CHECK(kind IN ('return','refund','cancellation'))"
        );
        const saleCols = db
            .prepare('PRAGMA table_info(sales)')
            .all()
            .map((c) => c.name);
        const itemCols = db
            .prepare('PRAGMA table_info(sale_items)')
            .all()
            .map((c) => c.name);
        if (
            saleCols.includes('total') &&
            itemCols.includes('line_total') &&
            itemCols.includes('extra')
        ) {
            for (const sale of db.prepare('SELECT id,total FROM sales').all()) {
                const items = db
                    .prepare(
                        'SELECT * FROM sale_items WHERE sale_id=? ORDER BY rowid'
                    )
                    .all(sale.id);
                if (!items.length) continue;
                const weights = items.map((item) =>
                    Math.max(
                        0,
                        Math.round(
                            (item.line_total + item.extra * item.quantity) * 100
                        )
                    )
                );
                const totals = allocate(
                    Math.round(sale.total * 100),
                    weights.some(Boolean)
                        ? weights
                        : items.map((i) => i.quantity)
                );
                items.forEach((item, index) =>
                    db
                        .prepare(
                            'UPDATE sale_items SET net_total_cents=? WHERE id=?'
                        )
                        .run(totals[index], item.id)
                );
            }
            // Old credits identified a product, not a sale line. Split them across
            // original lines once, retaining the old ID on the first split.
            for (const old of db
                .prepare(
                    'SELECT * FROM sale_returns WHERE sale_item_id IS NULL ORDER BY created_at,rowid'
                )
                .all()) {
                const lines = db
                    .prepare(
                        `SELECT si.*,COALESCE((SELECT SUM(quantity) FROM sale_returns WHERE sale_item_id=si.id),0) AS used,
                    COALESCE((SELECT SUM(amount_cents) FROM sale_returns WHERE sale_item_id=si.id),0) AS credited
                    FROM sale_items si WHERE sale_id=? AND product_id=? AND unit_type=? ORDER BY rowid`
                    )
                    .all(old.sale_id, old.product_id, old.unit_type);
                let remaining = old.quantity;
                let first = true;
                for (const line of lines) {
                    const quantity = Math.min(
                        remaining,
                        line.quantity - line.used
                    );
                    if (quantity <= 0) continue;
                    const minor =
                        cumulativeCredit(
                            line.net_total_cents,
                            line.used + quantity,
                            line.quantity
                        ) - line.credited;
                    if (first) {
                        db.prepare(
                            'UPDATE sale_returns SET sale_item_id=?,quantity=?,amount_cents=?,line_total=? WHERE id=?'
                        ).run(line.id, quantity, minor, minor / 100, old.id);
                        first = false;
                    } else {
                        db.prepare(
                            `INSERT INTO sale_returns (id,sale_id,sale_item_id,product_id,warehouse_id,unit_type,quantity,unit_price,line_total,amount_cents,reason,created_by,created_at)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
                        ).run(
                            randomUUID(),
                            old.sale_id,
                            line.id,
                            old.product_id,
                            old.warehouse_id,
                            old.unit_type,
                            quantity,
                            old.unit_price,
                            minor / 100,
                            minor,
                            old.reason,
                            old.created_by,
                            old.created_at
                        );
                    }
                    remaining -= quantity;
                    if (!remaining) break;
                }
                if (remaining)
                    throw new Error(
                        `Cannot migrate return ${old.id}: returned quantity exceeds original sale`
                    );
            }
            // Legacy terminal status changes already restored physical stock but
            // did not record credits. Reconcile their ledger without restocking.
            for (const sale of db
                .prepare(
                    "SELECT * FROM sales WHERE payment_status IN ('refunded','cancelled')"
                )
                .all()) {
                const lines = db
                    .prepare(
                        `SELECT si.*,COALESCE((SELECT SUM(quantity) FROM sale_returns WHERE sale_item_id=si.id),0) AS used,
                    COALESCE((SELECT SUM(amount_cents) FROM sale_returns WHERE sale_item_id=si.id),0) AS credited FROM sale_items si WHERE sale_id=?`
                    )
                    .all(sale.id);
                for (const line of lines) {
                    const remaining = line.quantity - line.used;
                    if (remaining <= 0) continue;
                    const credit = line.net_total_cents - line.credited;
                    db.prepare(
                        `INSERT INTO sale_returns(id,sale_id,sale_item_id,product_id,warehouse_id,unit_type,quantity,unit_price,line_total,amount_cents,reason,kind,created_by,created_at)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
                    ).run(
                        randomUUID(),
                        sale.id,
                        line.id,
                        line.product_id,
                        line.warehouse_id,
                        line.unit_type,
                        remaining,
                        line.unit_price,
                        credit / 100,
                        credit,
                        'Legacy terminal sale reconciliation',
                        sale.payment_status === 'refunded'
                            ? 'refund'
                            : 'cancellation',
                        sale.created_by,
                        sale.updated_at || new Date().toISOString()
                    );
                }
            }
        }
        db.exec(`CREATE INDEX IF NOT EXISTS idx_returns_item ON sale_returns(sale_item_id);
            CREATE TABLE IF NOT EXISTS request_keys (
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                operation TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,response TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(user_id,operation,key));
            INSERT INTO schema_migrations(version) VALUES(1)`);
    }).immediate();
}

module.exports = { runLaunchMigrations };
