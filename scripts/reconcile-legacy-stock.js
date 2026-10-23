const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { ambiguousLegacyStock } = require('../lib/legacy-stock');

const usage = 'node scripts/reconcile-legacy-stock.js --db FILE [--apply --stock-id ID --counted-units TOTAL --reason "Explanation"]';

function main(args) {
    const options = {};
    for (let i = 0; i < args.length; i++) {
        const key = args[i];
        if (!['--db', '--apply', '--stock-id', '--counted-units', '--reason'].includes(key) || key in options)
            throw new Error('Unknown or repeated option. Usage: ' + usage);
        if (key === '--apply') options[key] = true;
        else {
            if (!args[i + 1] || args[i + 1].startsWith('--'))
                throw new Error('Missing option value. Usage: ' + usage);
            options[key] = args[++i];
        }
    }
    if (!options['--db']) throw new Error('An explicit database path is required. Usage: ' + usage);
    const file = path.resolve(options['--db']);
    const apply = options['--apply'] === true;
    let counted;
    if (apply) {
        counted = Number(options['--counted-units']);
        if (!options['--stock-id'] || !/^\d+$/.test(options['--counted-units'] || '') || !Number.isSafeInteger(counted))
            throw new Error('Supply a stock ID and a non-negative whole confirmed unit total. Usage: ' + usage);
        if (!options['--reason']?.trim() || options['--reason'].length > 2000)
            throw new Error('A review explanation of 1–2000 characters is required');
    } else if (Object.keys(options).some((key) => key !== '--db')) {
        throw new Error('Inspection accepts only --db; changing stock requires --apply');
    }
    const db = new Database(file, { readonly: !apply, fileMustExist: true });
    try {
        const rows = ambiguousLegacyStock(db);
        if (!apply) return { database: file, ambiguous_rows: rows };
        const original = rows.find((row) => row.id === options['--stock-id']);
        if (!original) throw new Error('Stock ID is not an ambiguous row in this database; nothing changed');
        if (db.pragma('quick_check', { simple: true }) !== 'ok')
            throw new Error('Database integrity check failed; nothing changed');
        const directory = path.join(path.dirname(file), 'migration-backups');
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const backup = path.join(directory, `${path.basename(file)}.before-legacy-review-${randomUUID()}.db`);
        db.prepare('VACUUM INTO ?').run(backup);
        fs.chmodSync(backup, 0o600);
        const snapshot = new Database(backup, { readonly: true, fileMustExist: true });
        try {
            if (snapshot.pragma('quick_check', { simple: true }) !== 'ok')
                throw new Error('Snapshot verification failed; nothing changed');
        } finally { snapshot.close(); }
        const decision = {
            database: file, stock_id: original.id, original,
            confirmed_unit_stock: counted, reason: options['--reason'].trim(),
            backup, reviewed_at: new Date().toISOString()
        };
        // This records the decision before committing. The success output,
        // rather than the existence of the decision file, confirms application.
        db.transaction(() => {
            const changed = db.prepare(`UPDATE product_stock SET unit_stock=?,carton_stock=0
                WHERE id=? AND unit_stock=? AND carton_stock=?`)
                .run(counted, original.id, original.unit_stock, original.carton_stock);
            if (changed.changes !== 1) throw new Error('Stock changed during review; inspect it again');
            fs.writeFileSync(backup + '.review.json', JSON.stringify(decision, null, 2), { flag: 'wx', mode: 0o600 });
        }).immediate();
        return { ...decision, applied: true, remaining_ambiguous_rows: ambiguousLegacyStock(db).length };
    } finally { db.close(); }
}

if (require.main === module) {
    try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
    catch (error) {
        console.error('Legacy stock review refused:', error.message);
        process.exitCode = 1;
    }
}
module.exports = { main };
