const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'paint_inventory.db');
if (process.env.DB_PATH) {
    const dir = path.dirname(dbPath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
const db = new Database(dbPath);
const { validateAdminPassword } = require('./lib/passwords');

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

function migrateSchema() {
    const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    if (!userCols.includes('token_version')) {
        db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
    }
    if (!userCols.includes('permissions')) {
        db.exec("ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '[]'");
    }
    if (!userCols.includes('must_change_password')) {
        db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
    }
}

function initializeDatabase() {
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
            low_stock_threshold INTEGER NOT NULL DEFAULT 10 CHECK (low_stock_threshold >= 0),
            is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS product_stock (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            warehouse_id TEXT NOT NULL,
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
            tax REAL NOT NULL DEFAULT 0 CHECK (tax >= 0),
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
            unit_type TEXT NOT NULL CHECK (unit_type IN ('carton', 'liter20')),
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            unit_price REAL NOT NULL CHECK (unit_price >= 0),
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
            unit_type TEXT NOT NULL CHECK (unit_type IN ('carton', 'liter20')),
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
            unit_type TEXT NOT NULL CHECK (unit_type IN ('carton', 'liter20')),
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
            unit_type TEXT NOT NULL CHECK (unit_type IN ('carton', 'liter20')),
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

    const warehouseCount = db.prepare('SELECT COUNT(*) as count FROM warehouses').get().count;
    if (warehouseCount === 0) {
        seedDefaultWarehouses();
    }

    // Initial admin account — no hardcoded default password, and never reset
    // an existing administrator on later startups.
    const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
    if (!existingAdmin) {
        const adminPassword = validateAdminPassword(process.env.ADMIN_PASSWORD);
        db.prepare('INSERT INTO users (id, username, email, password_hash, role, is_active, token_version) VALUES (?, ?, ?, ?, ?, 1, 0)')
            .run(uuidv4(), 'admin', 'admin@veemenz.com', bcrypt.hashSync(adminPassword, 12), 'admin');
    }

    insertDefaultSettings();
}

function insertDefaultSettings() {
    const settings = [
        { key: 'company_name', value: 'VEEMENZ', description: 'Company name for receipts' },
        { key: 'company_address', value: '123 Industrial Ave, Accra, Ghana', description: 'Company address for receipts' },
        { key: 'company_phone', value: '+233-XX-XXX-XXXX', description: 'Company phone for receipts' },
        { key: 'company_email', value: 'info@veemenz.com', description: 'Company email for receipts' },
        { key: 'tax_rate', value: '0.10', description: 'Tax rate applied to sales (0.10 = 10%)' },
        { key: 'tax_enabled', value: 'true', description: 'Whether tax is applied to sales' },
        { key: 'show_total_value', value: 'true', description: 'Show total inventory value (admin only)' },
        { key: 'currency', value: 'GHS', description: 'Currency code' },
        { key: 'low_stock_threshold_default', value: '10', description: 'Default low stock threshold' },
        { key: 'notifications_enabled', value: 'false', description: 'Enable low-stock notifications' },
        { key: 'notifications_webhook_url', value: '', description: 'Webhook URL for low-stock notifications' }
    ];
    const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value, description) VALUES (?, ?, ?)');
    for (const s of settings) insert.run(s.key, s.value, s.description);
}

function seedDefaultWarehouses() {
    const warehouses = [
        { id: uuidv4(), name: 'Main Warehouse', code: 'WH001', address: '123 Industrial Ave', city: 'Accra', country: 'Ghana' },
        { id: uuidv4(), name: 'Secondary Warehouse', code: 'WH002', address: '456 Commerce Rd', city: 'Tema', country: 'Ghana' }
    ];
    const insert = db.prepare('INSERT INTO warehouses (id, name, code, address, city, country) VALUES (?, ?, ?, ?, ?, ?)');
    for (const w of warehouses) insert.run(w.id, w.name, w.code, w.address, w.city, w.country);
}

// Completely wipe business data and reset to a fresh state, preserving only the
// given admin account. Re-seeds default warehouses and settings.
function resetDatabase(adminId) {
    const transaction = db.transaction(() => {
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
    });
    transaction();

    seedDefaultWarehouses();
    insertDefaultSettings();
}

function getDb() {
    return db;
}

module.exports = { initializeDatabase, getDb, resetDatabase };