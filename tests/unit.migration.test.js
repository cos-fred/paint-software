const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');

function run(source) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-migration-'));
    const result = spawnSync(process.execPath, ['-e', source], {
        cwd: root,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            DB_PATH: path.join(dir, 'test.db'),
            JWT_SECRET: 'm'.repeat(48),
            ADMIN_PASSWORD: 'MigrationAdminPass12'
        },
        encoding: 'utf8'
    });
    return result;
}

describe('Database migrations', () => {
    it('preserves sale item columns when migrating a pre-unit database', () => {
        const result = run(`
            const Database = require('better-sqlite3');
            const db = new Database(process.env.DB_PATH);
            db.exec("CREATE TABLE warehouses (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT);");
            db.exec("CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, sku TEXT, unit_price REAL NOT NULL DEFAULT 0, carton_price REAL NOT NULL DEFAULT 0, liter20_price REAL NOT NULL DEFAULT 0, low_stock_threshold INTEGER NOT NULL DEFAULT 10, is_active INTEGER NOT NULL DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);");
            db.exec("CREATE TABLE product_stock (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, warehouse_id TEXT NOT NULL, carton_stock INTEGER NOT NULL DEFAULT 0, liter20_stock INTEGER NOT NULL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);");
            db.exec("CREATE TABLE sales (id TEXT PRIMARY KEY, customer_id TEXT, warehouse_id TEXT, sale_date DATETIME DEFAULT CURRENT_TIMESTAMP);");
            db.exec("CREATE TABLE sale_items (id TEXT PRIMARY KEY, sale_id TEXT NOT NULL, product_id TEXT NOT NULL, warehouse_id TEXT NOT NULL, unit_type TEXT NOT NULL CHECK (unit_type IN ('carton', 'liter20')), quantity INTEGER NOT NULL, unit_price REAL NOT NULL, discount REAL NOT NULL DEFAULT 0, line_total REAL NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);");
            db.exec("INSERT INTO warehouses (id, name, code) VALUES ('w1', 'Main', 'WH001');");
            db.exec("INSERT INTO products (id, name, unit_price) VALUES ('p1', 'Paint', 100);");
            db.exec("INSERT INTO product_stock (id, product_id, warehouse_id, carton_stock) VALUES ('ps1', 'p1', 'w1', 5);");
            db.exec("INSERT INTO sales (id) VALUES ('s1');");
            db.exec("INSERT INTO sale_items (id, sale_id, product_id, warehouse_id, unit_type, quantity, unit_price, discount, line_total, created_at) VALUES ('si1', 's1', 'p1', 'w1', 'carton', 1, 100, 5, 115, '2026-10-01 10:00:00');");
            db.close();

            const { initializeDatabase, getDb } = require('./database');
            initializeDatabase();
            const row = getDb().prepare('SELECT * FROM sale_items WHERE id = ?').get('si1');
            const stock = getDb().prepare('SELECT unit_stock, carton_stock FROM product_stock WHERE id = ?').get('ps1');
            process.stdout.write(JSON.stringify({ row, stock }));
        `);

        assert.equal(result.status, 0, result.stderr);
        const { row, stock } = JSON.parse(result.stdout);
        assert.equal(row.discount, 5);
        assert.equal(row.line_total, 115);
        assert.equal(row.extra, 0);
        assert.equal(row.units_per_carton, 0);
        assert.equal(row.created_at, '2026-10-01 10:00:00');
        // No units-per-carton is known yet, so legacy cartons are untouched and
        // the startup warning asks an admin to configure it.
        assert.equal(stock.unit_stock, 0);
        assert.equal(stock.carton_stock, 5);
    });

    it('converts legacy cartons once and does not resurrect sold stock on restart', () => {
        const result = run(`
            const Database = require('better-sqlite3');
            const db = new Database(process.env.DB_PATH);
            db.exec("CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, sku TEXT, unit_price REAL NOT NULL DEFAULT 0, units_per_carton INTEGER NOT NULL DEFAULT 0, low_stock_threshold INTEGER NOT NULL DEFAULT 10, is_active INTEGER NOT NULL DEFAULT 1);");
            db.exec("CREATE TABLE product_stock (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, warehouse_id TEXT NOT NULL, unit_stock INTEGER NOT NULL DEFAULT 0, carton_stock INTEGER NOT NULL DEFAULT 0, liter20_stock INTEGER NOT NULL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);");
            db.exec("INSERT INTO products (id, name, unit_price, units_per_carton) VALUES ('p1', 'Paint', 10, 12);");
            db.exec("INSERT INTO product_stock (id, product_id, warehouse_id, unit_stock, carton_stock) VALUES ('ps1', 'p1', 'w1', 0, 5);");
            db.close();

            const { initializeDatabase, getDb } = require('./database');
            initializeDatabase();
            const after = getDb().prepare('SELECT unit_stock, carton_stock FROM product_stock WHERE id = ?').get('ps1');
            getDb().prepare('UPDATE product_stock SET unit_stock = 0 WHERE id = ?').run('ps1');
            initializeDatabase();
            const afterRestart = getDb().prepare('SELECT unit_stock, carton_stock FROM product_stock WHERE id = ?').get('ps1');
            process.stdout.write(JSON.stringify({ after, afterRestart }));
        `);

        assert.equal(result.status, 0, result.stderr);
        const { after, afterRestart } = JSON.parse(result.stdout);
        assert.deepEqual(after, { unit_stock: 60, carton_stock: 0 });
        assert.deepEqual(afterRestart, { unit_stock: 0, carton_stock: 0 });
    });

    it('clears stale carton counts on rows already converted by older builds', () => {
        const result = run(`
            const Database = require('better-sqlite3');
            const db = new Database(process.env.DB_PATH);
            db.exec("CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, sku TEXT, unit_price REAL NOT NULL DEFAULT 0, units_per_carton INTEGER NOT NULL DEFAULT 0, low_stock_threshold INTEGER NOT NULL DEFAULT 10, is_active INTEGER NOT NULL DEFAULT 1);");
            db.exec("CREATE TABLE product_stock (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, warehouse_id TEXT NOT NULL, unit_stock INTEGER NOT NULL DEFAULT 0, carton_stock INTEGER NOT NULL DEFAULT 0, liter20_stock INTEGER NOT NULL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);");
            db.exec("INSERT INTO products (id, name, unit_price, units_per_carton) VALUES ('p1', 'Paint', 10, 12);");
            db.exec("INSERT INTO product_stock (id, product_id, warehouse_id, unit_stock, carton_stock) VALUES ('ps1', 'p1', 'w1', 600, 5);");
            db.close();

            const { initializeDatabase, getDb } = require('./database');
            initializeDatabase();
            const after = getDb().prepare('SELECT unit_stock, carton_stock FROM product_stock WHERE id = ?').get('ps1');
            process.stdout.write(JSON.stringify(after));
        `);

        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), { unit_stock: 600, carton_stock: 0 });
    });

    it('backfills sale-item conversions even when the column already exists', () => {
        const result = run(`
            const Database = require('better-sqlite3');
            const db = new Database(process.env.DB_PATH);
            db.exec("CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, sku TEXT, unit_price REAL NOT NULL DEFAULT 0, units_per_carton INTEGER NOT NULL DEFAULT 0, low_stock_threshold INTEGER NOT NULL DEFAULT 10, is_active INTEGER NOT NULL DEFAULT 1);");
            db.exec("CREATE TABLE sale_items (id TEXT PRIMARY KEY, sale_id TEXT NOT NULL, product_id TEXT NOT NULL, unit_type TEXT NOT NULL CHECK (unit_type IN ('unit', 'carton', 'liter20')), quantity INTEGER NOT NULL, units_per_carton INTEGER NOT NULL DEFAULT 0);");
            db.exec("INSERT INTO products (id, name, unit_price, units_per_carton) VALUES ('p1', 'Paint', 10, 12);");
            db.exec("INSERT INTO sale_items (id, sale_id, product_id, unit_type, quantity, units_per_carton) VALUES ('si1', 's1', 'p1', 'carton', 1, 0);");
            db.close();

            const { initializeDatabase, getDb } = require('./database');
            initializeDatabase();
            const row = getDb().prepare('SELECT units_per_carton FROM sale_items WHERE id = ?').get('si1');
            process.stdout.write(JSON.stringify(row));
        `);

        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).units_per_carton, 12);
    });
});
