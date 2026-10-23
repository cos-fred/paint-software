const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const dbPath =
    process.env.DB_PATH || path.join(__dirname, 'paint_inventory.db');
if (process.env.DB_PATH) {
    const dir = path.dirname(dbPath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
const db = new Database(dbPath);
const { validateAdminPassword } = require('./lib/passwords');

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = FULL');
db.pragma('busy_timeout = 5000');

function migrateSchema() {
    const userCols = db
        .prepare('PRAGMA table_info(users)')
        .all()
        .map((c) => c.name);
    if (!userCols.includes('token_version')) {
        db.exec(
            'ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0'
        );
    }
    if (!userCols.includes('permissions')) {
        db.exec(
            "ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '[]'"
        );
    }
    if (!userCols.includes('must_change_password')) {
        db.exec(
            'ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0'
        );
    }

    const productCols = db
        .prepare('PRAGMA table_info(products)')
        .all()
        .map((c) => c.name);
    if (!productCols.includes('units_per_carton')) {
        db.exec(
            'ALTER TABLE products ADD COLUMN units_per_carton INTEGER NOT NULL DEFAULT 0'
        );
    }

    const stockCols = db
        .prepare('PRAGMA table_info(product_stock)')
        .all()
        .map((c) => c.name);
    if (!stockCols.includes('unit_stock')) {
        db.exec(
            'ALTER TABLE product_stock ADD COLUMN unit_stock INTEGER NOT NULL DEFAULT 0'
        );
    }

    const salesCols = db
        .prepare('PRAGMA table_info(sales)')
        .all()
        .map((c) => c.name);
    if (!salesCols.includes('markup')) {
        db.exec('ALTER TABLE sales ADD COLUMN markup REAL NOT NULL DEFAULT 0');
    }

    const siCols = db
        .prepare('PRAGMA table_info(sale_items)')
        .all()
        .map((c) => c.name);
    if (!siCols.includes('units_per_carton')) {
        db.exec(
            'ALTER TABLE sale_items ADD COLUMN units_per_carton INTEGER NOT NULL DEFAULT 0'
        );
    }
    if (!siCols.includes('extra')) {
        db.exec(
            'ALTER TABLE sale_items ADD COLUMN extra REAL NOT NULL DEFAULT 0'
        );
    }
}

// Existing databases store only 'carton'/'liter20' unit types; the single-pool
// model introduces 'unit'. Recreate the unit_type CHECK constraints so 'unit'
// is accepted, preserving all existing rows and foreign keys with explicit column mappings.
function migrateUnitTypeCheck() {
    const tables = [
        {
            name: 'sale_items',
            sql: `CREATE TABLE sale_items (
            id TEXT PRIMARY KEY,
            sale_id TEXT NOT NULL,
            product_id TEXT NOT NULL,
            warehouse_id TEXT NOT NULL,
            unit_type TEXT NOT NULL CHECK (unit_type IN ('unit', 'carton', 'liter20')),
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            unit_price REAL NOT NULL CHECK (unit_price >= 0),
            units_per_carton INTEGER NOT NULL DEFAULT 0 CHECK (units_per_carton >= 0),
            extra REAL NOT NULL DEFAULT 0 CHECK (extra >= 0),
            discount REAL NOT NULL DEFAULT 0 CHECK (discount >= 0),
            line_total REAL NOT NULL CHECK (line_total >= 0),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
            FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT
        )`
        },
        {
            name: 'sale_returns',
            sql: `CREATE TABLE sale_returns (
            id TEXT PRIMARY KEY,
            sale_id TEXT NOT NULL,
            product_id TEXT NOT NULL,
            warehouse_id TEXT NOT NULL,
            unit_type TEXT NOT NULL CHECK (unit_type IN ('unit', 'carton', 'liter20')),
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            unit_price REAL NOT NULL CHECK (unit_price >= 0),
            line_total REAL NOT NULL CHECK (line_total >= 0),
            reason TEXT,
            created_by TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
            FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
        )`
        },
        {
            name: 'stock_transfers',
            sql: `CREATE TABLE stock_transfers (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            from_warehouse_id TEXT NOT NULL,
            to_warehouse_id TEXT NOT NULL,
            unit_type TEXT NOT NULL CHECK (unit_type IN ('unit', 'carton', 'liter20')),
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            notes TEXT,
            created_by TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
            FOREIGN KEY (from_warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE,
            FOREIGN KEY (to_warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
        )`
        },
        {
            name: 'stock_movements',
            sql: `CREATE TABLE stock_movements (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            warehouse_id TEXT NOT NULL,
            movement_type TEXT NOT NULL CHECK (movement_type IN ('in', 'out', 'adjustment_positive', 'adjustment_negative', 'transfer_in', 'transfer_out', 'return_in')),
            unit_type TEXT NOT NULL CHECK (unit_type IN ('unit', 'carton', 'liter20')),
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            reference_id TEXT,
            reference_type TEXT CHECK (reference_type IN ('sale', 'stock_adjustment', 'sale_return', 'product_create', 'transfer', 'return')),
            notes TEXT,
            created_by TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
            FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
        )`
        }
    ];

    const needs = tables.filter((t) => {
        const row = db
            .prepare(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?"
            )
            .get(t.name);
        return (
            row &&
            row.sql &&
            (!row.sql.includes("'unit'") ||
                (t.name === 'sale_items' &&
                    !row.sql.includes('units_per_carton')))
        );
    });
    if (needs.length === 0) return;

    db.exec('PRAGMA foreign_keys = OFF');
    try {
        const run = db.transaction(() => {
            for (const t of needs) {
                db.exec(`ALTER TABLE ${t.name} RENAME TO ${t.name}_old`);
                db.exec(t.sql);
                const oldCols = db
                    .prepare(`PRAGMA table_info(${t.name}_old)`)
                    .all()
                    .map((c) => c.name);
                const newCols = db
                    .prepare(`PRAGMA table_info(${t.name})`)
                    .all()
                    .map((c) => c.name);
                const targetCols = [];
                const selectExprs = [];
                for (const col of newCols) {
                    if (oldCols.includes(col)) {
                        targetCols.push(col);
                        selectExprs.push(col);
                    } else if (col === 'extra') {
                        targetCols.push(col);
                        selectExprs.push('0 AS extra');
                    } else if (col === 'discount') {
                        targetCols.push(col);
                        selectExprs.push('0 AS discount');
                    } else if (col === 'units_per_carton') {
                        targetCols.push(col);
                        selectExprs.push(
                            `COALESCE((SELECT units_per_carton FROM products WHERE products.id = ${t.name}_old.product_id), 0) AS units_per_carton`
                        );
                    }
                }
                db.exec(
                    `INSERT INTO ${t.name} (${targetCols.join(', ')}) SELECT ${selectExprs.join(', ')} FROM ${t.name}_old`
                );
                db.exec(`DROP TABLE ${t.name}_old`);
            }
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
                CREATE INDEX IF NOT EXISTS idx_sale_returns_sale ON sale_returns(sale_id);
                CREATE INDEX IF NOT EXISTS idx_stock_transfers_product ON stock_transfers(product_id);
                CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);
                CREATE INDEX IF NOT EXISTS idx_stock_movements_date ON stock_movements(created_at);
            `);

            // Validate before the transaction commits so a failed migration is
            // rolled back instead of leaving the database migrated but unusable.
            const fkErrors = db.prepare('PRAGMA foreign_key_check').all();
            if (fkErrors.length > 0) {
                throw new Error(
                    'Foreign key constraint violation after migration: ' +
                        JSON.stringify(fkErrors)
                );
            }
        });
        run();
    } finally {
        db.exec('PRAGMA foreign_keys = ON');
    }
}

function initializeDatabase() {
    const {
        snapshotBeforeUpgrade,
        runUpgradeSafeguards
    } = require('./lib/upgrade-safeguards');
    const migrationBackup = snapshotBeforeUpgrade(db, dbPath, 3);
    db.exec('PRAGMA foreign_keys = ON');

    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
            is_active INTEGER NOT NULL DEFAULT 1,
            token_version INTEGER NOT NULL DEFAULT 0,
            permissions TEXT NOT NULL DEFAULT '[]',
            must_change_password INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS warehouses (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            code TEXT UNIQUE NOT NULL,
            address TEXT,
            city TEXT,
            country TEXT DEFAULT 'Ghana',
            is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            sku TEXT UNIQUE,
            unit_price REAL NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
            carton_price REAL NOT NULL DEFAULT 0 CHECK (carton_price >= 0),
            liter20_price REAL NOT NULL DEFAULT 0 CHECK (liter20_price >= 0),
            units_per_carton INTEGER NOT NULL DEFAULT 0 CHECK (units_per_carton >= 0),
            low_stock_threshold INTEGER NOT NULL DEFAULT 10 CHECK (low_stock_threshold >= 0),
            is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS product_stock (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            warehouse_id TEXT NOT NULL,
            unit_stock INTEGER NOT NULL DEFAULT 0 CHECK (unit_stock >= 0),
            carton_stock INTEGER NOT NULL DEFAULT 0 CHECK (carton_stock >= 0),
            liter20_stock INTEGER NOT NULL DEFAULT 0 CHECK (liter20_stock >= 0),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
            FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE,
            UNIQUE(product_id, warehouse_id)
        );

        CREATE TABLE IF NOT EXISTS customers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT,
            phone TEXT,
            address TEXT,
            city TEXT,
            state TEXT,
            postal_code TEXT,
            country TEXT DEFAULT 'Ghana',
            tax_id TEXT,
            notes TEXT,
            is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS sales (
            id TEXT PRIMARY KEY,
            customer_id TEXT,
            warehouse_id TEXT NOT NULL,
            sale_date DATETIME DEFAULT CURRENT_TIMESTAMP,
            subtotal REAL NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
            markup REAL NOT NULL DEFAULT 0 CHECK (markup >= 0),
            discount REAL NOT NULL DEFAULT 0 CHECK (discount >= 0),
            discount_type TEXT NOT NULL DEFAULT 'amount' CHECK (discount_type IN ('amount', 'percent')),
            total REAL NOT NULL DEFAULT 0 CHECK (total >= 0),
            payment_method TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'card', 'transfer', 'momo')),
            payment_status TEXT NOT NULL DEFAULT 'completed' CHECK (payment_status IN ('pending', 'completed', 'cancelled', 'refunded')),
            notes TEXT,
            created_by TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
            FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS sale_items (
            id TEXT PRIMARY KEY,
            sale_id TEXT NOT NULL,
            product_id TEXT NOT NULL,
            warehouse_id TEXT NOT NULL,
            unit_type TEXT NOT NULL CHECK (unit_type IN ('unit', 'carton', 'liter20')),
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            unit_price REAL NOT NULL CHECK (unit_price >= 0),
            units_per_carton INTEGER NOT NULL DEFAULT 0 CHECK (units_per_carton >= 0),
            extra REAL NOT NULL DEFAULT 0 CHECK (extra >= 0),
            discount REAL NOT NULL DEFAULT 0 CHECK (discount >= 0),
            line_total REAL NOT NULL CHECK (line_total >= 0),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
            FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS sale_returns (
            id TEXT PRIMARY KEY,
            sale_id TEXT NOT NULL,
            product_id TEXT NOT NULL,
            warehouse_id TEXT NOT NULL,
            unit_type TEXT NOT NULL CHECK (unit_type IN ('unit', 'carton', 'liter20')),
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            unit_price REAL NOT NULL CHECK (unit_price >= 0),
            line_total REAL NOT NULL CHECK (line_total >= 0),
            reason TEXT,
            created_by TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
            FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS stock_transfers (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            from_warehouse_id TEXT NOT NULL,
            to_warehouse_id TEXT NOT NULL,
            unit_type TEXT NOT NULL CHECK (unit_type IN ('unit', 'carton', 'liter20')),
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            notes TEXT,
            created_by TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
            FOREIGN KEY (from_warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE,
            FOREIGN KEY (to_warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS stock_movements (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            warehouse_id TEXT NOT NULL,
            movement_type TEXT NOT NULL CHECK (movement_type IN ('in', 'out', 'adjustment_positive', 'adjustment_negative', 'transfer_in', 'transfer_out', 'return_in')),
            unit_type TEXT NOT NULL CHECK (unit_type IN ('unit', 'carton', 'liter20')),
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            reference_id TEXT,
            reference_type TEXT CHECK (reference_type IN ('sale', 'stock_adjustment', 'sale_return', 'product_create', 'transfer', 'return')),
            notes TEXT,
            created_by TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
            FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS alerts (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL CHECK (type IN ('low_stock', 'out_of_stock', 'system')),
            product_id TEXT,
            warehouse_id TEXT,
            message TEXT NOT NULL,
            severity TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'danger')),
            is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
            FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            action TEXT NOT NULL,
            entity_type TEXT,
            entity_id TEXT,
            details TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            description TEXT
        );
    `);

    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
        CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku_unique ON products(sku) WHERE sku IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_product_stock_product ON product_stock(product_id);
        CREATE INDEX IF NOT EXISTS idx_product_stock_warehouse ON product_stock(warehouse_id);
        CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);
        CREATE INDEX IF NOT EXISTS idx_sales_warehouse_date ON sales(warehouse_id, sale_date);
        CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
        CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
        CREATE INDEX IF NOT EXISTS idx_sale_returns_sale ON sale_returns(sale_id);
        CREATE INDEX IF NOT EXISTS idx_stock_transfers_product ON stock_transfers(product_id);
        CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);
        CREATE INDEX IF NOT EXISTS idx_stock_movements_date ON stock_movements(created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_alerts_unread ON alerts(is_read);
    `);

    migrateSchema();
    migrateUnitTypeCheck();
    require('./lib/migrations').runLaunchMigrations(db);
    runUpgradeSafeguards(db, migrationBackup);
    require('./lib/business-migrations').runBusinessMigrations(
        db,
        migrationBackup
    );

    const warehouseCount = db
        .prepare('SELECT COUNT(*) as count FROM warehouses')
        .get().count;
    if (warehouseCount === 0) {
        seedDefaultWarehouses();
    }

    // Initial admin account — no hardcoded default password, and never reset
    // an existing administrator on later startups.
    const existingAdmin = db
        .prepare('SELECT id FROM users WHERE username = ?')
        .get('admin');
    if (!existingAdmin) {
        const adminPassword = validateAdminPassword(process.env.ADMIN_PASSWORD);
        db.prepare(
            'INSERT INTO users (id, username, email, password_hash, role, is_active, token_version) VALUES (?, ?, ?, ?, ?, 1, 0)'
        ).run(
            uuidv4(),
            'admin',
            'admin@veemenz.com',
            bcrypt.hashSync(adminPassword, 12),
            'admin'
        );
    }

    insertDefaultSettings();
}

function insertDefaultSettings() {
    const settings = [
        {
            key: 'company_name',
            value: 'VEEMENZ',
            description: 'Company name for receipts'
        },
        {
            key: 'company_address',
            value: '123 Industrial Ave, Accra, Ghana',
            description: 'Company address for receipts'
        },
        {
            key: 'company_phone',
            value: '+233-XX-XXX-XXXX',
            description: 'Company phone for receipts'
        },
        {
            key: 'company_email',
            value: 'info@veemenz.com',
            description: 'Company email for receipts'
        },
        {
            key: 'show_total_value',
            value: 'true',
            description: 'Show total inventory value (admin only)'
        },
        { key: 'currency', value: 'GHS', description: 'Currency code' },
        {
            key: 'low_stock_threshold_default',
            value: '10',
            description: 'Default low stock threshold'
        },
        {
            key: 'notifications_enabled',
            value: 'false',
            description: 'Enable low-stock notifications'
        },
        {
            key: 'notifications_webhook_url',
            value: '',
            description: 'Webhook URL for low-stock notifications'
        }
    ];
    const insert = db.prepare(
        'INSERT OR IGNORE INTO settings (key, value, description) VALUES (?, ?, ?)'
    );
    for (const s of settings) insert.run(s.key, s.value, s.description);
}

function seedDefaultWarehouses() {
    const warehouses = [
        {
            id: uuidv4(),
            name: 'Main Warehouse',
            code: 'WH001',
            address: '123 Industrial Ave',
            city: 'Accra',
            country: 'Ghana'
        },
        {
            id: uuidv4(),
            name: 'Secondary Warehouse',
            code: 'WH002',
            address: '456 Commerce Rd',
            city: 'Tema',
            country: 'Ghana'
        }
    ];
    const insert = db.prepare(
        'INSERT INTO warehouses (id, name, code, address, city, country) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const w of warehouses)
        insert.run(w.id, w.name, w.code, w.address, w.city, w.country);
}

// Completely wipe business data and reset to a fresh state, preserving only the
// given admin account. Re-seeds default warehouses and settings.
function resetDatabase(adminId) {
    const transaction = db.transaction(() => {
        db.prepare('DELETE FROM request_keys').run();
        db.prepare('DELETE FROM daily_closing_revisions').run();
        db.prepare('DELETE FROM daily_closings').run();
        db.prepare('DELETE FROM stocktake_items').run();
        db.prepare('DELETE FROM stocktakes').run();
        db.prepare('DELETE FROM sale_payments').run();
        db.prepare('DELETE FROM sale_returns').run();
        db.prepare('DELETE FROM sale_items').run();
        db.prepare('DELETE FROM stock_movements').run();
        db.prepare('DELETE FROM stock_transfers').run();
        db.prepare('DELETE FROM sales').run();
        db.prepare('DELETE FROM alerts').run();
        db.prepare('DELETE FROM product_stock').run();
        db.prepare('DELETE FROM products').run();
        db.prepare('DELETE FROM customers').run();
        db.prepare('DELETE FROM audit_logs').run();
        db.prepare('DELETE FROM users WHERE id != ?').run(adminId);
        db.prepare('DELETE FROM warehouses').run();
        db.prepare('DELETE FROM settings').run();
        seedDefaultWarehouses();
        insertDefaultSettings();
    });
    transaction();
}

function getDb() {
    return db;
}

module.exports = { initializeDatabase, getDb, resetDatabase };
