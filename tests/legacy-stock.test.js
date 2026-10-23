const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { main } = require('../scripts/reconcile-legacy-stock');
const { assertLegacyStockUnambiguous } = require('../lib/legacy-stock');

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-legacy-review-'));
    const file = path.join(directory, 'app.db');
    const db = new Database(file);
    db.exec(`CREATE TABLE products(id TEXT PRIMARY KEY,name TEXT);
        CREATE TABLE warehouses(id TEXT PRIMARY KEY,name TEXT);
        CREATE TABLE product_stock(id TEXT PRIMARY KEY,product_id TEXT,warehouse_id TEXT,unit_stock INTEGER,carton_stock INTEGER,liter20_stock INTEGER);
        CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
        INSERT INTO products VALUES('p','Mixed Paint'); INSERT INTO warehouses VALUES('w','Main');
        INSERT INTO product_stock VALUES('mixed','p','w',7,5,3);
        INSERT INTO product_stock VALUES('other','p','w',12,0,8);
        INSERT INTO schema_migrations VALUES(2),(3);`);
    db.close();
    return { file, directory };
}
it('inspects without changing an existing database and identifies product and warehouse', () => {
    const { file } = fixture();
    const before = fs.readFileSync(file);
    const report = main(['--db', file]);
    assert.equal(report.ambiguous_rows.length, 1);
    assert.equal(report.ambiguous_rows[0].product_name, 'Mixed Paint');
    assert.equal(report.ambiguous_rows[0].warehouse_name, 'Main');
    assert.deepEqual(fs.readFileSync(file), before);
    const db = new Database(file);
    assert.throws(() => assertLegacyStockUnambiguous(db), /Legacy stock review required/);
    db.close();
});
for (const total of [0, 7, 67]) {
    it(`applies only the confirmed total ${total} and retains a verified original snapshot`, () => {
        const { file } = fixture();
        const result = main(['--db', file, '--apply', '--stock-id', 'mixed', '--counted-units', String(total), '--reason', 'Owner verified physical inventory']);
        assert.equal(result.applied, true);
        assert.equal(result.remaining_ambiguous_rows, 0);
        const snapshot = new Database(result.backup, { readonly: true });
        assert.deepEqual(snapshot.prepare("SELECT unit_stock,carton_stock,liter20_stock FROM product_stock WHERE id='mixed'").get(), { unit_stock: 7, carton_stock: 5, liter20_stock: 3 });
        snapshot.close();
        const decision = JSON.parse(fs.readFileSync(result.backup + '.review.json', 'utf8'));
        assert.equal(decision.confirmed_unit_stock, total);
        assert.equal(decision.reason, 'Owner verified physical inventory');
        const db = new Database(file);
        assert.deepEqual(db.prepare("SELECT unit_stock,carton_stock,liter20_stock FROM product_stock WHERE id='mixed'").get(), { unit_stock: total, carton_stock: 0, liter20_stock: 3 });
        assert.deepEqual(db.prepare("SELECT unit_stock,carton_stock,liter20_stock FROM product_stock WHERE id='other'").get(), { unit_stock: 12, carton_stock: 0, liter20_stock: 8 });
        assert.doesNotThrow(() => assertLegacyStockUnambiguous(db));
        db.close();
        assert.throws(() => main(['--db', file, '--apply', '--stock-id', 'mixed', '--counted-units', String(total), '--reason', 'Repeat']), /not an ambiguous row/);
    });
}
it('rejects invalid quantities, missing reasons and missing files without writing', () => {
    const { file, directory } = fixture();
    const before = fs.readFileSync(file);
    for (const value of ['-1', '1.5', 'NaN', '9007199254740992'])
        assert.throws(() => main(['--db', file, '--apply', '--stock-id', 'mixed', '--counted-units', value, '--reason', 'Review']));
    assert.throws(() => main(['--db', file, '--apply', '--stock-id', 'mixed', '--counted-units', '7']), /explanation/);
    assert.throws(() => main(['--db', file, '--counted-units', '7']), /requires --apply/);
    assert.deepEqual(fs.readFileSync(file), before);
    const missing = path.join(directory, 'missing.db');
    assert.throws(() => main(['--db', missing]));
    assert.equal(fs.existsSync(missing), false);
});
it('refuses changes if a recovery snapshot cannot be created', () => {
    const { file, directory } = fixture();
    fs.writeFileSync(path.join(directory, 'migration-backups'), 'not a directory');
    const before = fs.readFileSync(file);
    assert.throws(() => main(['--db', file, '--apply', '--stock-id', 'mixed', '--counted-units', '67', '--reason', 'Review']));
    assert.deepEqual(fs.readFileSync(file), before);
});

it('rolls back reconciliation if the review decision cannot be recorded', () => {
    const { file } = fixture();
    const write = fs.writeFileSync;
    try {
        fs.writeFileSync = function (filename, ...args) {
            if (String(filename).endsWith('.review.json')) throw new Error('Review file unavailable');
            return write.call(this, filename, ...args);
        };
        assert.throws(() => main(['--db', file, '--apply', '--stock-id', 'mixed', '--counted-units', '67', '--reason', 'Review']), /Review file unavailable/);
    } finally { fs.writeFileSync = write; }
    assert.equal(main(['--db', file]).ambiguous_rows[0].unit_stock, 7);
    assert.equal(main(['--db', file]).ambiguous_rows[0].carton_stock, 5);
});
