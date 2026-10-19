const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const dbPath = path.join(__dirname, 'paint_inventory.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

function initializeDatabase() {
    // Enable foreign keys
    db.exec('PRAGMA foreign_keys = ON');
    
    db.exec(`
        -- ============================================
        -- USERS & AUTHENTICATION
        -- ============================================
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- ============================================
        -- WAREHOUSES
        -- ============================================
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

        -- ============================================
        -- PRODUCTS
        -- ============================================
        CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            unit_price REAL NOT NULL CHECK (unit_price >= 0),
            carton_price REAL NOT NULL CHECK (carton_price >= 0),
            liter20_price REAL NOT NULL CHECK (liter20_price >= 0),
            low_stock_threshold INTEGER NOT NULL DEFAULT 10 CHECK (low_stock_threshold >= 0),
            is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- ============================================
        -- PRODUCT STOCK (per warehouse)
        -- ============================================
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

        -- ============================================
        -- CUSTOMERS
        -- ============================================
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

        -- ============================================
        -- SALES
        -- ============================================
        CREATE TABLE IF NOT EXISTS sales (
            id TEXT PRIMARY KEY,
            customer_id TEXT,
            warehouse_id TEXT NOT NULL,
            sale_date DATETIME DEFAULT CURRENT_TIMESTAMP,
            subtotal REAL NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
            tax REAL NOT NULL DEFAULT 0 CHECK (tax >= 0),
            discount REAL NOT NULL DEFAULT 0 CHECK (discount >= 0),
            total REAL NOT NULL DEFAULT 0 CHECK (total >= 0),
            payment_method TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'card', 'transfer', 'momo', 'credit')),
            payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'completed', 'cancelled', 'refunded')),
            notes TEXT,
            created_by TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
            FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
        );

        -- ============================================
        -- SALE ITEMS
        -- ============================================
        CREATE TABLE IF NOT EXISTS sale_items (
            id TEXT PRIMARY KEY,
            sale_id TEXT NOT NULL,
            product_id TEXT NOT NULL,
            warehouse_id TEXT NOT NULL,
            unit_type TEXT NOT NULL CHECK (unit_type IN ('unit', 'carton', 'liter20')),
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            unit_price REAL NOT NULL CHECK (unit_price >= 0),
            line_total REAL NOT NULL CHECK (line_total >= 0),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
            FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT
        );

        -- ============================================
        -- PURCHASE ORDERS
        -- ============================================
        CREATE TABLE IF NOT EXISTS purchase_orders (
            id TEXT PRIMARY KEY,
            supplier_name TEXT NOT NULL,
            supplier_contact TEXT,
            warehouse_id TEXT NOT NULL,
            order_date DATETIME DEFAULT CURRENT_TIMESTAMP,
            expected_date DATETIME,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ordered', 'partial', 'received', 'cancelled')),
            total_cost REAL NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
            notes TEXT,
            created_by TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
        );

        -- ============================================
        -- PURCHASE ORDER ITEMS
        -- ============================================
        CREATE TABLE IF NOT EXISTS purchase_order_items (
            id TEXT PRIMARY KEY,
            purchase_order_id TEXT NOT NULL,
            product_id TEXT NOT NULL,
            warehouse_id TEXT NOT NULL,
            unit_type TEXT NOT NULL CHECK (unit_type IN ('unit', 'carton', 'liter20')),
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            unit_cost REAL NOT NULL CHECK (unit_cost >= 0),
            line_total REAL NOT NULL CHECK (line_total >= 0),
            received_quantity INTEGER NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
            FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT
        );

        -- ============================================
        -- STOCK MOVEMENTS (Audit Trail)
        -- ============================================
        CREATE TABLE IF NOT EXISTS stock_movements (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            warehouse_id TEXT NOT NULL,
            movement_type TEXT NOT NULL CHECK (movement_type IN ('in', 'out', 'adjustment_positive', 'adjustment_negative')),
            unit_type TEXT NOT NULL CHECK (unit_type IN ('unit', 'carton', 'liter20')),
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            reference_id TEXT,
            reference_type TEXT CHECK (reference_type IN ('sale', 'purchase_order', 'stock_adjustment', 'sale_return', 'purchase_return')),
            notes TEXT,
            created_by TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
            FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
        );

        -- ============================================
        -- ALERTS
        -- ============================================
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

        -- ============================================
        -- SETTINGS
        -- ============================================
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            description TEXT
        );

        -- ============================================
        -- INDEXES FOR PERFORMANCE
        -- ============================================
        CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
        CREATE INDEX IF NOT EXISTS idx_products_is_active ON products(is_active);
        CREATE INDEX IF NOT EXISTS idx_product_stock_product ON product_stock(product_id);
        CREATE INDEX IF NOT EXISTS idx_product_stock_warehouse ON product_stock(warehouse_id);
        CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);
        CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
        CREATE INDEX IF NOT EXISTS idx_sales_warehouse_date ON sales(warehouse_id, sale_date);
        CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
        CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(payment_status);
        CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
        CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);
        CREATE INDEX IF NOT EXISTS idx_purchase_orders_warehouse ON purchase_orders(warehouse_id);
        CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status);
        CREATE INDEX IF NOT EXISTS idx_purchase_order_items_po ON purchase_order_items(purchase_order_id);
        CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);
        CREATE INDEX IF NOT EXISTS idx_stock_movements_warehouse ON stock_movements(warehouse_id);
        CREATE INDEX IF NOT EXISTS idx_stock_movements_date ON stock_movements(created_at);
        CREATE INDEX IF NOT EXISTS idx_alerts_product ON alerts(product_id);
        CREATE INDEX IF NOT EXISTS idx_alerts_warehouse ON alerts(warehouse_id);
        CREATE INDEX IF NOT EXISTS idx_alerts_unread ON alerts(is_read);
    `);

    // Insert default warehouses
    const warehouseCount = db.prepare('SELECT COUNT(*) as count FROM warehouses').get().count;
    if (warehouseCount === 0) {
        const warehouses = [
            { id: uuidv4(), name: 'Main Warehouse', code: 'WH001', address: '123 Industrial Ave', city: 'Accra', country: 'Ghana' },
            { id: uuidv4(), name: 'Secondary Warehouse', code: 'WH002', address: '456 Commerce Rd', city: 'Tema', country: 'Ghana' }
        ];
        const insert = db.prepare('INSERT INTO warehouses (id, name, code, address, city, country) VALUES (?, ?, ?, ?, ?, ?)');
        for (const w of warehouses) {
            insert.run(w.id, w.name, w.code, w.address, w.city, w.country);
        }
    }

    // Insert default admin user
    const defaultAdmin = {
        id: uuidv4(),
        username: 'admin',
        email: 'admin@veemenz.com',
        password_hash: bcrypt.hashSync('admin123', 12),
        role: 'admin'
    };

    const existingAdmin = db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
    if (!existingAdmin) {
        db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
            .run(defaultAdmin.id, defaultAdmin.username, defaultAdmin.email, defaultAdmin.password_hash, defaultAdmin.role);
    }

    // Insert default settings
    insertDefaultSettings();
}

function insertDefaultSettings() {
    const settings = [
        { key: 'company_name', value: 'VEEMENZ', description: 'Company name for receipts' },
        { key: 'company_address', value: '123 Industrial Ave, Accra, Ghana', description: 'Company address for receipts' },
        { key: 'company_phone', value: '+233-XX-XXX-XXXX', description: 'Company phone for receipts' },
        { key: 'company_email', value: 'info@veemenz.com', description: 'Company email for receipts' },
        { key: 'tax_rate', value: '0.10', description: 'Default tax rate (10%)' },
        { key: 'currency', value: 'GHS', description: 'Currency code' },
        { key: 'low_stock_threshold_default', value: '10', description: 'Default low stock threshold' },
    ];

    const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value, description) VALUES (?, ?, ?)');
    for (const setting of settings) {
        insert.run(setting.key, setting.value, setting.description);
    }
}

function getDb() {
    return db;
}

module.exports = { initializeDatabase, getDb };