const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const MAGIC = Buffer.from('PAINTBK1');
function encryptionKey() {
    const value = process.env.BACKUP_ENCRYPTION_KEY;
    if (!value) return null;
    if (!/^[a-fA-F0-9]{64}$/.test(value))
        throw new Error(
            'BACKUP_ENCRYPTION_KEY must be 64 hexadecimal characters'
        );
    return Buffer.from(value, 'hex');
}
function encrypt(data, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}
function decrypt(data, key) {
    if (!data.subarray(0, 8).equals(MAGIC)) return data;
    if (!key)
        throw new Error('Encrypted backup requires BACKUP_ENCRYPTION_KEY');
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        data.subarray(8, 20)
    );
    decipher.setAuthTag(data.subarray(20, 36));
    return Buffer.concat([
        decipher.update(data.subarray(36)),
        decipher.final()
    ]);
}
function verifyDatabase(file) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
        if (db.pragma('quick_check', { simple: true }) !== 'ok')
            throw new Error('Backup integrity check failed');
        if (db.pragma('foreign_key_check').length)
            throw new Error('Backup foreign key check failed');
        const requiredTables = [
            'users',
            'warehouses',
            'products',
            'sales',
            'sale_items',
            'sale_returns',
            'stock_movements'
        ];
        const hasVersions = db
            .prepare(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
            )
            .get();
        if (
            hasVersions &&
            db.prepare('SELECT 1 FROM schema_migrations WHERE version=3').get()
        ) {
            requiredTables.push(
                'sale_payments',
                'stocktakes',
                'stocktake_items',
                'daily_closings',
                'daily_closing_revisions'
            );
            // A database already stamped version 3 must have its ledger view;
            // startup will not rerun a completed migration to repair missing data.
            db.prepare('SELECT id FROM sale_accounts LIMIT 1').all();
        }
        for (const table of requiredTables) {
            if (
                !db
                    .prepare(
                        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
                    )
                    .get(table)
            )
                throw new Error(`Backup is missing table ${table}`);
        }
    } finally {
        db.close();
    }
}
function restoreToNewFile(source, output) {
    if (
        fs.existsSync(output) ||
        fs.existsSync(output + '-wal') ||
        fs.existsSync(output + '-shm')
    )
        throw new Error(
            'Restore destination must be a new file; stop the app and restore to a separate path'
        );
    const data = decrypt(fs.readFileSync(source), encryptionKey());
    const descriptor = fs.openSync(output, 'wx', 0o600);
    try {
        fs.writeFileSync(descriptor, data);
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
    try {
        verifyDatabase(output);
    } catch (err) {
        fs.unlinkSync(output);
        throw err;
    }
    return output;
}
module.exports = {
    encryptionKey,
    encrypt,
    decrypt,
    verifyDatabase,
    restoreToNewFile
};
