const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-backup-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(temp, 'app.db');
process.env.BACKUP_DIR = path.join(temp, 'backups');
process.env.JWT_SECRET = 'backup-test-signing-key-with-at-least-48-characters';
process.env.ADMIN_PASSWORD = 'BackupAdminPass12';
process.env.BACKUP_ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.BACKUP_KEEP = '2';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initializeDatabase, getDb } = require('../database');
const { runBackup, getBackupStatus } = require('../services/backup');
const { restoreToNewFile, verifyDatabase } = require('../lib/backup-files');
describe('Verified encrypted backups and recovery', { concurrency: 1 }, () => {
    before(() => initializeDatabase());
    after(() => getDb().close());
    it('restores an encrypted snapshot with its original records into a new database', async () => {
        const file = await runBackup();
        assert.ok(file.endsWith('.enc'));
        assert.equal(
            fs.readFileSync(file).subarray(0, 8).toString(),
            'PAINTBK1'
        );
        const restored = path.join(temp, 'restored.db');
        restoreToNewFile(file, restored);
        verifyDatabase(restored);
        const Database = require('better-sqlite3');
        const copy = new Database(restored, { readonly: true });
        assert.equal(
            copy.prepare('SELECT COUNT(*) AS n FROM users').get().n,
            1
        );
        assert.equal(
            copy.prepare('SELECT COUNT(*) AS n FROM warehouses').get().n,
            2
        );
        copy.close();
        assert.throws(() => restoreToNewFile(file, restored), /new file/);
        assert.equal(getBackupStatus().overdue, false);
    });
    it('refuses a wrong key or damaged backup without replacing an existing database', async () => {
        const file = await runBackup();
        const original = fs.readFileSync(process.env.DB_PATH);
        const wrongOutput = path.join(temp, 'wrong-key.db');
        const key = process.env.BACKUP_ENCRYPTION_KEY;
        process.env.BACKUP_ENCRYPTION_KEY = 'cd'.repeat(32);
        assert.throws(() => restoreToNewFile(file, wrongOutput));
        assert.equal(fs.existsSync(wrongOutput), false);
        process.env.BACKUP_ENCRYPTION_KEY = key;
        const damaged = path.join(temp, 'damaged.enc');
        const bytes = fs.readFileSync(file);
        bytes[bytes.length - 1] ^= 1;
        fs.writeFileSync(damaged, bytes);
        assert.throws(() =>
            restoreToNewFile(damaged, path.join(temp, 'damaged.db'))
        );
        assert.deepEqual(fs.readFileSync(process.env.DB_PATH), original);
    });
    it('keeps only its own snapshots and makes a separate encrypted daily copy', async () => {
        process.env.BACKUP_MIRROR_DIR = path.join(
            temp,
            'independent-destination'
        );
        fs.writeFileSync(
            path.join(process.env.BACKUP_DIR, 'unrelated.db'),
            'must remain'
        );
        await runBackup({ forceRemote: true });
        await runBackup();
        await runBackup();
        assert.equal(
            fs
                .readdirSync(process.env.BACKUP_DIR)
                .filter((name) => name.endsWith('.enc')).length,
            2
        );
        assert.equal(
            fs.readFileSync(
                path.join(process.env.BACKUP_DIR, 'unrelated.db'),
                'utf8'
            ),
            'must remain'
        );
        assert.equal(fs.readdirSync(process.env.BACKUP_MIRROR_DIR).length, 1);
        assert.ok(getBackupStatus().last_remote_success);
        delete process.env.BACKUP_MIRROR_DIR;
    });
    it('records one visible failure alert and recovers after storage is repaired', async () => {
        const directory = process.env.BACKUP_DIR;
        const file = path.join(temp, 'not-a-directory');
        fs.writeFileSync(file, 'x');
        process.env.BACKUP_DIR = file;
        await assert.rejects(runBackup());
        await assert.rejects(runBackup());
        assert.ok(getBackupStatus().error);
        assert.equal(
            getDb()
                .prepare("SELECT COUNT(*) AS n FROM alerts WHERE type='system'")
                .get().n,
            1
        );
        process.env.BACKUP_DIR = directory;
        await runBackup();
        assert.equal(getBackupStatus().error, null);
    });
    it('the restore command validates an encrypted backup without opening the live database', async () => {
        const file = await runBackup();
        const output = path.join(temp, 'cli-restored.db');
        const result = spawnSync(
            process.execPath,
            ['scripts/restore.js', file, output],
            {
                cwd: path.join(__dirname, '..'),
                env: process.env,
                encoding: 'utf8'
            }
        );
        assert.equal(result.status, 0, result.stderr);
        verifyDatabase(output);
    });
});
