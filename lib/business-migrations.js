const { randomUUID } = require('node:crypto');

function runBusinessMigrations(db, backupPath) {
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=3').get())
        return;
    db.transaction(() => {
        const columns = (table) =>
            db
                .prepare(`PRAGMA table_info(${table})`)
                .all()
                .map((c) => c.name);
        for (const name of [
            'brand',
            'colour_name',
            'colour_code',
            'finish',
            'container_size'
        ]) {
            if (!columns('products').includes(name))
                db.exec(
                    `ALTER TABLE products ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`
                );
        }
        if (!columns('sales').includes('due_date'))
            db.exec('ALTER TABLE sales ADD COLUMN due_date TEXT');
        db.exec(`
            CREATE TABLE IF NOT EXISTS sale_payments (
                id TEXT PRIMARY KEY,sale_id TEXT NOT NULL REFERENCES sales(id),
                kind TEXT NOT NULL CHECK(kind IN ('payment','refund')),
                amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
                method TEXT NOT NULL CHECK(method IN ('cash','card','transfer','momo')),
                reference TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',
                origin TEXT NOT NULL DEFAULT 'recorded' CHECK(origin IN ('recorded','legacy')),
                received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                created_by TEXT NOT NULL REFERENCES users(id)
            );
            CREATE INDEX IF NOT EXISTS idx_sale_payments_sale ON sale_payments(sale_id);
            CREATE INDEX IF NOT EXISTS idx_sale_payments_received ON sale_payments(received_at);
            CREATE VIEW IF NOT EXISTS sale_accounts AS
            SELECT account.*,MAX(net_total_cents-net_paid_cents,0) AS balance_due_cents,
                MAX(net_paid_cents-net_total_cents,0) AS refund_due_cents FROM (
                SELECT s.id,s.customer_id,s.warehouse_id,s.payment_status,s.payment_method,s.sale_date,s.due_date,s.total,
                    CAST(ROUND(s.total*100) AS INTEGER)-(SELECT COALESCE(SUM(amount_cents),0) FROM sale_returns WHERE sale_id=s.id) AS net_total_cents,
                    (SELECT COALESCE(SUM(CASE WHEN kind='payment' THEN amount_cents ELSE -amount_cents END),0) FROM sale_payments WHERE sale_id=s.id) AS net_paid_cents,
                    (SELECT COALESCE(SUM(amount_cents),0) FROM sale_payments WHERE sale_id=s.id AND kind='payment') AS received_cents,
                    (SELECT COALESCE(SUM(amount_cents),0) FROM sale_payments WHERE sale_id=s.id AND kind='refund') AS refunded_cents
                FROM sales s
            ) account;
            CREATE TABLE IF NOT EXISTS stocktakes (
                id TEXT PRIMARY KEY,warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
                status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','cancelled')),
                revision INTEGER NOT NULL DEFAULT 0,notes TEXT NOT NULL DEFAULT '',
                created_by TEXT NOT NULL REFERENCES users(id),approved_by TEXT REFERENCES users(id),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,approved_at TEXT
            );
            CREATE TABLE IF NOT EXISTS stocktake_items (
                id TEXT PRIMARY KEY,stocktake_id TEXT NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
                product_id TEXT NOT NULL REFERENCES products(id),product_name TEXT NOT NULL,sku TEXT,
                units_per_carton INTEGER NOT NULL,expected_units INTEGER NOT NULL,expected_liter20 INTEGER NOT NULL,
                counted_units INTEGER CHECK(counted_units>=0),counted_liter20 INTEGER CHECK(counted_liter20>=0),
                UNIQUE(stocktake_id,product_id)
            );
            CREATE INDEX IF NOT EXISTS idx_stocktakes_warehouse ON stocktakes(warehouse_id,created_at);
            CREATE INDEX IF NOT EXISTS idx_stocktake_items_parent ON stocktake_items(stocktake_id);
            CREATE TABLE IF NOT EXISTS daily_closings (
                id TEXT PRIMARY KEY,business_date TEXT NOT NULL,warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
                revision INTEGER NOT NULL DEFAULT 1,snapshot_json TEXT NOT NULL,
                opening_cash_cents INTEGER NOT NULL,cash_added_cents INTEGER NOT NULL,cash_removed_cents INTEGER NOT NULL,
                counted_cash_cents INTEGER NOT NULL,expected_cash_cents INTEGER NOT NULL,difference_cents INTEGER NOT NULL,
                notes TEXT NOT NULL,closed_by TEXT NOT NULL REFERENCES users(id),closed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(business_date,warehouse_id)
            );
            CREATE TABLE IF NOT EXISTS daily_closing_revisions (
                closing_id TEXT NOT NULL REFERENCES daily_closings(id),revision INTEGER NOT NULL,
                record_json TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(closing_id,revision)
            );
        `);
        // Previous versions stored a status, not a payment ledger. Preserve its
        // meaning explicitly as imported history, separate from new receipts.
        const saleColumns = columns('sales');
        if (
            [
                'total',
                'created_by',
                'payment_method',
                'payment_status',
                'sale_date'
            ].every((c) => saleColumns.includes(c))
        ) {
            const insert =
                db.prepare(`INSERT INTO sale_payments(id,sale_id,kind,amount_cents,method,origin,received_at,created_by,notes)
                VALUES(?,?,?,?,?,'legacy',?,?, 'Imported from previous payment status')`);
            for (const sale of db
                .prepare(
                    "SELECT * FROM sales WHERE payment_status IN ('completed','refunded')"
                )
                .all()) {
                const amount = Math.round(sale.total * 100);
                if (amount > 0)
                    insert.run(
                        randomUUID(),
                        sale.id,
                        'payment',
                        amount,
                        sale.payment_method,
                        sale.sale_date,
                        sale.created_by
                    );
                for (const credit of db
                    .prepare(
                        'SELECT amount_cents,created_at,created_by FROM sale_returns WHERE sale_id=? AND amount_cents>0'
                    )
                    .all(sale.id)) {
                    insert.run(
                        randomUUID(),
                        sale.id,
                        'refund',
                        credit.amount_cents,
                        sale.payment_method,
                        credit.created_at,
                        credit.created_by || sale.created_by
                    );
                }
            }
        }
        db.prepare(
            'INSERT INTO schema_migrations(version,backup_path) VALUES(3,?)'
        ).run(backupPath || null);
    }).immediate();
}

module.exports = { runBusinessMigrations };
