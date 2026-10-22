const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-money-migration-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(temp, 'app.db');
process.env.JWT_SECRET = 'migration-launch-test-signing-key-of-48-characters';
process.env.ADMIN_PASSWORD = 'MigrationLaunchPass12';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initializeDatabase, getDb } = require('../database');
const { runLaunchMigrations } = require('../lib/migrations');
describe('Versioned money and return migration', { concurrency: 1 }, () => {
    before(() => initializeDatabase());
    after(() => getDb().close());
    it('splits a legacy return across sale lines and is idempotent', () => {
        const db = getDb();
        const user = db.prepare('SELECT id FROM users LIMIT 1').get().id,
            warehouse = db
                .prepare('SELECT id FROM warehouses LIMIT 1')
                .get().id;
        const product = randomUUID(),
            sale = randomUUID();
        db.prepare(
            "INSERT INTO products(id,name,unit_price,units_per_carton) VALUES(?,'Legacy',10,12)"
        ).run(product);
        db.prepare(
            'INSERT INTO sales(id,warehouse_id,subtotal,total,created_by) VALUES(?,?,16,16,?)'
        ).run(sale, warehouse, user);
        const insert = db.prepare(
            "INSERT INTO sale_items(id,sale_id,product_id,warehouse_id,unit_type,quantity,unit_price,discount,line_total) VALUES(?,?,?,?,'unit',1,10,?,?)"
        );
        insert.run(randomUUID(), sale, product, warehouse, 4, 6);
        insert.run(randomUUID(), sale, product, warehouse, 0, 10);
        db.prepare(
            "INSERT INTO sale_returns(id,sale_id,product_id,warehouse_id,unit_type,quantity,unit_price,line_total,created_by) VALUES(?,?,?,?,'unit',2,10,20,?)"
        ).run(randomUUID(), sale, product, warehouse, user);
        db.prepare('DELETE FROM schema_migrations WHERE version=1').run();
        runLaunchMigrations(db);
        const migrated = db
            .prepare(
                'SELECT quantity,amount_cents,sale_item_id FROM sale_returns WHERE sale_id=? ORDER BY rowid'
            )
            .all(sale);
        assert.equal(migrated.length, 2);
        assert.deepEqual(
            migrated.map((row) => row.amount_cents),
            [600, 1000]
        );
        assert.ok(migrated.every((row) => row.sale_item_id));
        runLaunchMigrations(db);
        assert.equal(
            db
                .prepare(
                    'SELECT COUNT(*) AS n FROM sale_returns WHERE sale_id=?'
                )
                .get(sale).n,
            2
        );
        assert.equal(db.pragma('foreign_key_check').length, 0);
    });
    it('reconciles a legacy refund without restoring physical stock a second time', () => {
        const db = getDb();
        const user = db.prepare('SELECT id FROM users LIMIT 1').get().id,
            warehouse = db
                .prepare('SELECT id FROM warehouses LIMIT 1')
                .get().id;
        const product = randomUUID(),
            sale = randomUUID(),
            line = randomUUID();
        db.prepare(
            "INSERT INTO products(id,name,unit_price,units_per_carton) VALUES(?,'Legacy Refund',10,12)"
        ).run(product);
        db.prepare(
            'INSERT INTO product_stock(id,product_id,warehouse_id,unit_stock) VALUES(?,?,?,17)'
        ).run(randomUUID(), product, warehouse);
        db.prepare(
            "INSERT INTO sales(id,warehouse_id,subtotal,total,payment_status,created_by) VALUES(?,?,24,24,'refunded',?)"
        ).run(sale, warehouse, user);
        db.prepare(
            "INSERT INTO sale_items(id,sale_id,product_id,warehouse_id,unit_type,quantity,unit_price,discount,line_total) VALUES(?,?,?,?,'unit',4,10,4,24)"
        ).run(line, sale, product, warehouse);
        db.prepare(
            "INSERT INTO sale_returns(id,sale_id,product_id,warehouse_id,unit_type,quantity,unit_price,line_total,created_by) VALUES(?,?,?,?,'unit',1,10,10,?)"
        ).run(randomUUID(), sale, product, warehouse, user);
        db.prepare('DELETE FROM schema_migrations WHERE version=1').run();
        runLaunchMigrations(db);
        assert.equal(
            db
                .prepare(
                    'SELECT SUM(amount_cents) AS n FROM sale_returns WHERE sale_id=?'
                )
                .get(sale).n,
            2400
        );
        assert.equal(
            db
                .prepare(
                    'SELECT unit_stock FROM product_stock WHERE product_id=?'
                )
                .get(product).unit_stock,
            17
        );
        runLaunchMigrations(db);
        assert.equal(
            db
                .prepare(
                    'SELECT COUNT(*) AS n FROM sale_returns WHERE sale_id=?'
                )
                .get(sale).n,
            2
        );
    });
});
