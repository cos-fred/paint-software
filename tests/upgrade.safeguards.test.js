const { it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fixture(source) {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'paint-upgrade-safeguards-')
    );
    const setup = `
        const fs=require('node:fs'), path=require('node:path');
        const Database=require('better-sqlite3');
        const {initializeDatabase,getDb}=require('./database');
        initializeDatabase(); const db=getDb();
        const user=db.prepare('SELECT * FROM users LIMIT 1').get();
        const warehouse=db.prepare('SELECT id FROM warehouses LIMIT 1').get().id;
        db.prepare("INSERT INTO products(id,name,unit_price,carton_price,units_per_carton) VALUES('fixture-product','Fixture',10,120,12)").run();
        db.prepare("INSERT INTO product_stock(id,product_id,warehouse_id,unit_stock,carton_stock) VALUES('fixture-stock','fixture-product',?,0,5)").run(warehouse);
        db.exec('DELETE FROM schema_migrations WHERE version IN (2,3)');
        db.exec('ALTER TABLE sale_items DROP COLUMN discount');
        db.exec('ALTER TABLE sales ADD COLUMN tax REAL NOT NULL DEFAULT 0');
        const columns=t=>db.prepare('PRAGMA table_info('+t+')').all().map(c=>c.name);
    `;
    const result = spawnSync(process.execPath, ['-e', setup + source], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        env: {
            ...process.env,
            NODE_ENV: 'test',
            DB_PATH: path.join(directory, 'app.db'),
            JWT_SECRET: 'u'.repeat(48),
            ADMIN_PASSWORD: 'UpgradeFixturePass22'
        }
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

for (const alreadyVersioned of [false, true]) {
    it(`repairs missing discounts and removes sales tax (${alreadyVersioned ? 'already versioned' : 'pre-launch schema'})`, () => {
        const result = fixture(`
            if (!${alreadyVersioned}) { db.exec('DELETE FROM schema_migrations WHERE version=1'); db.exec('ALTER TABLE sale_items DROP COLUMN net_total_cents'); }
            initializeDatabase();
            const {createSale}=require('./services/sales');
            const sale=createSale({user,get:()=>undefined,body:{warehouse_id:warehouse,items:[{product_id:'fixture-product',unit_type:'unit',quantity:1,discount:2}]}});
            const row=db.prepare('SELECT discount,net_total_cents FROM sale_items WHERE sale_id=?').get(sale.body.id);
            const version=db.prepare('SELECT backup_path FROM schema_migrations WHERE version=2').get();
            const snapshot=new Database(version.backup_path,{readonly:true});
            const originalTax=snapshot.prepare('PRAGMA table_info(sales)').all().some(c=>c.name==='tax');
            snapshot.close();
            const snapshots=fs.readdirSync(path.dirname(version.backup_path)).length;
            db.prepare('UPDATE sale_items SET units_per_carton=0 WHERE sale_id=?').run(sale.body.id);
            initializeDatabase();
            console.log(JSON.stringify({row,tax:columns('sales').includes('tax'),originalTax,
                stock:db.prepare("SELECT unit_stock,carton_stock FROM product_stock WHERE id='fixture-stock'").get(),
                repeatSnapshots:fs.readdirSync(path.dirname(version.backup_path)).length-snapshots,
                repeatedBackfill:db.prepare('SELECT units_per_carton AS n FROM sale_items WHERE sale_id=?').get(sale.body.id).n,
                integrity:db.pragma('integrity_check',{simple:true})}));
            db.close();
        `);
        assert.deepEqual(result.row, { discount: 2, net_total_cents: 800 });
        assert.equal(result.tax, false);
        assert.equal(result.originalTax, true);
        assert.deepEqual(result.stock, { unit_stock: 59, carton_stock: 0 });
        assert.equal(result.repeatSnapshots, 0);
        assert.equal(result.repeatedBackfill, 0);
        assert.equal(result.integrity, 'ok');
    });
}

it('rolls the stock conversion and schema changes back together on migration failure', () => {
    const result = fixture(`
        db.exec("CREATE TRIGGER reject_upgrade BEFORE INSERT ON schema_migrations WHEN NEW.version=2 BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
        let error; try {initializeDatabase();} catch(e) {error=e.message;}
        console.log(JSON.stringify({error,tax:columns('sales').includes('tax'),discount:columns('sale_items').includes('discount'),
            stock:db.prepare("SELECT unit_stock,carton_stock FROM product_stock WHERE id='fixture-stock'").get(),
            version:!!db.prepare('SELECT 1 FROM schema_migrations WHERE version=2').get()}));
        db.close();
    `);
    assert.match(result.error, /fixture failure/);
    assert.equal(result.tax, true);
    assert.equal(result.discount, false);
    assert.equal(result.version, false);
    assert.deepEqual(result.stock, { unit_stock: 0, carton_stock: 5 });
});

it('preserves recorded totals and credits when removing historical sales tax', () => {
    const result = fixture(`
        db.prepare("INSERT INTO sales(id,warehouse_id,subtotal,tax,total,created_by) VALUES('historical',?,10,2,12,?)").run(warehouse,user.id);
        db.prepare("INSERT INTO sale_items(id,sale_id,product_id,warehouse_id,unit_type,quantity,unit_price,units_per_carton,line_total,net_total_cents) VALUES('historical-line','historical','fixture-product',?,'unit',1,10,12,10,1200)").run(warehouse);
        initializeDatabase();
        console.log(JSON.stringify({total:db.prepare("SELECT total FROM sales WHERE id='historical'").get().total,
            credit:db.prepare("SELECT net_total_cents FROM sale_items WHERE id='historical-line'").get().net_total_cents,
            tax:columns('sales').includes('tax')}));db.close();
    `);
    assert.deepEqual(result, { total: 12, credit: 1200, tax: false });
});

it('keeps unknown carton quantities and raises a visible inventory review alert', () => {
    const result = fixture(`
        db.prepare("UPDATE products SET units_per_carton=0 WHERE id='fixture-product'").run();
        initializeDatabase(); initializeDatabase();
        console.log(JSON.stringify({stock:db.prepare("SELECT unit_stock,carton_stock FROM product_stock WHERE id='fixture-stock'").get(),
            alerts:db.prepare("SELECT message FROM alerts WHERE product_id='fixture-product'").all()})); db.close();
    `);
    assert.deepEqual(result.stock, { unit_stock: 0, carton_stock: 5 });
    assert.equal(result.alerts.length, 1);
    assert.match(result.alerts[0].message, /Inventory review required/);
});

it('classifies historical stock alerts by the quantity label rather than the product name', () => {
    const result = fixture(`
        db.prepare("INSERT INTO alerts(id,type,product_id,warehouse_id,message,severity) VALUES('carton-alert','low_stock','fixture-product',?,'Low stock alert: 20L Paint (Main) has 2 cartons remaining (threshold: 3)','warning')").run(warehouse);
        db.prepare("INSERT INTO alerts(id,type,product_id,warehouse_id,message,severity) VALUES('container-alert','low_stock','fixture-product',?,'Low stock alert: Paint (Main) has 2 20L containers remaining (threshold: 3)','warning')").run(warehouse);
        initializeDatabase();
        console.log(JSON.stringify(db.prepare("SELECT id,stock_pool FROM alerts WHERE id IN ('carton-alert','container-alert') ORDER BY id").all()));db.close();
    `);
    assert.deepEqual(result, [
        { id: 'carton-alert', stock_pool: 'unit_stock' },
        { id: 'container-alert', stock_pool: 'liter20_stock' }
    ]);
});
