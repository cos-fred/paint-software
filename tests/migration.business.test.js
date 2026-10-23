const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path');
const { spawnSync } = require('node:child_process');
const { it } = require('node:test');
const assert = require('node:assert/strict');
function fixture(body) {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'paint-ledger-upgrade-')
    );
    const setup = `
        const fs=require('node:fs'),path=require('node:path'),Database=require('better-sqlite3');
        const {initializeDatabase,getDb}=require('./database');initializeDatabase();const db=getDb();
        const user=db.prepare('SELECT id FROM users LIMIT 1').get().id,warehouse=db.prepare('SELECT id FROM warehouses LIMIT 1').get().id;
        db.prepare("INSERT INTO products(id,name,unit_price,units_per_carton) VALUES('paint','Paint',10,1)").run();
        db.prepare("INSERT INTO product_stock(id,product_id,warehouse_id,unit_stock) VALUES('stock','paint',?,100)").run(warehouse);
        for(const status of ['completed','pending','refunded','cancelled']) {
            db.prepare('INSERT INTO sales(id,warehouse_id,subtotal,total,payment_status,created_by) VALUES(?,?,100,100,?,?)').run(status,warehouse,status,user);
            db.prepare("INSERT INTO sale_items(id,sale_id,product_id,warehouse_id,unit_type,quantity,unit_price,units_per_carton,line_total,net_total_cents) VALUES(?,?,'paint',?,'unit',10,10,1,100,10000)").run('line-'+status,status,warehouse);
        }
        for(const [status,qty,amount] of [['completed',2,2000],['refunded',10,10000],['cancelled',10,10000]]) {
            db.prepare("INSERT INTO sale_returns(id,sale_id,sale_item_id,product_id,warehouse_id,unit_type,quantity,unit_price,line_total,amount_cents,created_by) VALUES(?,?,?,'paint',?,'unit',?,10,?,?,?)").run('credit-'+status,status,'line-'+status,warehouse,qty,amount/100,amount,user);
        }
        db.exec('DROP VIEW sale_accounts;DROP TABLE sale_payments;DROP TABLE stocktake_items;DROP TABLE stocktakes;DROP TABLE daily_closing_revisions;DROP TABLE daily_closings;ALTER TABLE sales DROP COLUMN due_date;DELETE FROM schema_migrations WHERE version=3;');
        for(const name of ['brand','colour_name','colour_code','finish','container_size'])db.exec('ALTER TABLE products DROP COLUMN '+name);
    `;
    const result = spawnSync(process.execPath, ['-e', setup + body], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        env: {
            ...process.env,
            NODE_ENV: 'test',
            DB_PATH: path.join(directory, 'app.db'),
            ADMIN_PASSWORD: 'LedgerMigrationPass22',
            JWT_SECRET: 'k'.repeat(48)
        }
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}
it('imports prior payment states once and snapshots the complete pre-ledger database', () => {
    const result = fixture(`
        initializeDatabase();const first=db.prepare('SELECT COUNT(*) AS n FROM sale_payments').get().n;
        const accounts=db.prepare('SELECT id,balance_due_cents,refund_due_cents,net_paid_cents FROM sale_accounts ORDER BY id').all();
        const backup=db.prepare('SELECT backup_path FROM schema_migrations WHERE version=3').get().backup_path;
        const old=new Database(backup,{readonly:true});const originalHasLedger=!!old.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sale_payments'").get();old.close();
        initializeDatabase();console.log(JSON.stringify({first,after:db.prepare('SELECT COUNT(*) AS n FROM sale_payments').get().n,accounts,originalHasLedger,
            origins:db.prepare('SELECT DISTINCT origin FROM sale_payments').all(),snapshots:fs.readdirSync(path.dirname(backup)).length,foreignKeys:db.pragma('foreign_key_check').length,
            stock:db.prepare("SELECT unit_stock FROM product_stock WHERE id='stock'").get().unit_stock}));db.close();
    `);
    assert.equal(result.first, 4);
    assert.equal(result.after, 4);
    assert.equal(result.originalHasLedger, false);
    assert.equal(result.snapshots, 1);
    assert.equal(result.foreignKeys, 0);
    assert.equal(result.stock, 100);
    assert.deepEqual(result.origins, [{ origin: 'legacy' }]);
    const rows = Object.fromEntries(result.accounts.map((a) => [a.id, a]));
    assert.equal(rows.completed.net_paid_cents, 8000);
    assert.equal(rows.completed.balance_due_cents, 0);
    assert.equal(rows.pending.balance_due_cents, 10000);
    assert.equal(rows.refunded.net_paid_cents, 0);
    assert.equal(rows.cancelled.net_paid_cents, 0);
});
it('rolls back the complete business migration if its version stamp cannot be committed', () => {
    const result = fixture(`
        db.exec("CREATE TRIGGER reject_ledger_upgrade BEFORE INSERT ON schema_migrations WHEN NEW.version=3 BEGIN SELECT RAISE(ABORT,'fixture ledger failure');END");
        let error;try {initializeDatabase();}catch(e){error=e.message;}
        console.log(JSON.stringify({error,ledger:!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sale_payments'").get(),
            brand:db.prepare('PRAGMA table_info(products)').all().some(c=>c.name==='brand'),sales:db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,
            stock:db.prepare("SELECT unit_stock FROM product_stock WHERE id='stock'").get().unit_stock}));db.close();
    `);
    assert.match(result.error, /fixture ledger failure/);
    assert.equal(result.ledger, false);
    assert.equal(result.brand, false);
    assert.equal(result.sales, 4);
    assert.equal(result.stock, 100);
});
