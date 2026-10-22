const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getDb } = require('../database');
const {
    encryptionKey,
    encrypt,
    verifyDatabase
} = require('../lib/backup-files');
const { publicRequest } = require('../lib/public-http');
let inFlight = null;
let scheduler = null;
const backupDir = () =>
    path.resolve(
        process.env.BACKUP_DIR ||
            path.join(path.dirname(getDb().name), 'backups')
    );
function state() {
    const db = getDb();
    db.exec(
        'CREATE TABLE IF NOT EXISTS system_state(key TEXT PRIMARY KEY,value TEXT NOT NULL)'
    );
    return JSON.parse(
        db.prepare("SELECT value FROM system_state WHERE key='backup'").get()
            ?.value || '{}'
    );
}
function save(value) {
    getDb()
        .prepare(
            "INSERT INTO system_state(key,value) VALUES('backup',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
        )
        .run(JSON.stringify(value));
}
function getBackupStatus() {
    const current = state();
    return {
        ...current,
        remote_configured: !!(
            process.env.BACKUP_REMOTE_URL || process.env.BACKUP_MIRROR_DIR
        ),
        encrypted: !!process.env.BACKUP_ENCRYPTION_KEY,
        overdue:
            !current.last_success ||
            Date.now() - Date.parse(current.last_success) > 2 * 60 * 60 * 1000
    };
}
function prune(directory, keep) {
    const files = fs
        .readdirSync(directory)
        .filter((name) =>
            /^paint_inventory-[0-9TZ-]+-[a-f0-9-]+\.db(?:\.enc)?$/.test(name)
        )
        .sort();
    for (const name of files.slice(0, Math.max(0, files.length - keep)))
        fs.unlinkSync(path.join(directory, name));
}
function failure(error) {
    console.error('[BACKUP] failed:', error.message);
    try {
        const previous = state();
        save({
            ...previous,
            last_failure: new Date().toISOString(),
            error: 'Backup failed. Check server logs and storage configuration.'
        });
        if (!previous.error) {
            getDb()
                .prepare(
                    "INSERT INTO alerts(id,type,message,severity) VALUES(?,'system',?,'danger')"
                )
                .run(
                    randomUUID(),
                    'Automatic backup failed. An administrator must check backup health.'
                );
            require('./realtime').broadcast('change', {
                action: 'backup.failed'
            });
            if (process.env.BACKUP_ALERT_WEBHOOK_URL)
                publicRequest(process.env.BACKUP_ALERT_WEBHOOK_URL, {
                    body: JSON.stringify({
                        text: 'VEEMENZ automatic backup failed. An administrator must check backup health.'
                    }),
                    headers: { 'Content-Type': 'application/json' }
                }).catch((err) =>
                    console.error(
                        '[BACKUP] failure notification could not be delivered:',
                        err.message
                    )
                );
        }
    } catch (err) {
        console.error('[BACKUP] cannot record failure:', err.message);
    }
}
function runBackup({ forceRemote = false } = {}) {
    if (inFlight) return inFlight;
    inFlight = (async () => {
        const directory = backupDir();
        fs.mkdirSync(directory, { recursive: true });
        const key = encryptionKey();
        const remote = process.env.BACKUP_REMOTE_URL;
        const mirror = process.env.BACKUP_MIRROR_DIR;
        if ((remote || mirror) && !key)
            throw new Error('Remote backups require BACKUP_ENCRYPTION_KEY');
        if (remote && !remote.startsWith('https://'))
            throw new Error('BACKUP_REMOTE_URL must use HTTPS');
        const name = `paint_inventory-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.db`;
        const temp = path.join(directory, name + '.partial');
        const destination = path.join(directory, name + (key ? '.enc' : ''));
        try {
            await getDb().backup(temp);
            verifyDatabase(temp);
            if (key) {
                fs.writeFileSync(
                    destination,
                    encrypt(fs.readFileSync(temp), key),
                    { mode: 0o600 }
                );
                fs.unlinkSync(temp);
            } else {
                fs.renameSync(temp, destination);
                fs.chmodSync(destination, 0o600);
            }
            const current = state();
            const now = new Date().toISOString();
            const updated = {
                ...current,
                last_success: now,
                last_file: path.basename(destination)
            };
            save(updated);
            // Hourly local snapshots; one independently stored copy each UTC day.
            if (
                (remote || mirror) &&
                (forceRemote ||
                    !current.last_remote_success ||
                    current.last_remote_success.slice(0, 10) !==
                        now.slice(0, 10))
            ) {
                const contents = fs.readFileSync(destination);
                if (mirror) {
                    const remoteDirectory = path.resolve(mirror);
                    if (
                        remoteDirectory === directory ||
                        remoteDirectory.startsWith(directory + path.sep)
                    )
                        throw new Error(
                            'Backup mirror must be outside the local backup directory'
                        );
                    fs.mkdirSync(remoteDirectory, { recursive: true });
                    fs.copyFileSync(
                        destination,
                        path.join(remoteDirectory, path.basename(destination))
                    );
                    prune(remoteDirectory, 30);
                }
                if (remote)
                    await publicRequest(remote, {
                        method: 'PUT',
                        body: contents,
                        timeoutMs: 30000,
                        headers: {
                            'Content-Type': 'application/octet-stream',
                            'X-Backup-Filename': path.basename(destination),
                            ...(process.env.BACKUP_REMOTE_TOKEN
                                ? {
                                      Authorization: `Bearer ${process.env.BACKUP_REMOTE_TOKEN}`
                                  }
                                : {})
                        }
                    });
                updated.last_remote_success = now;
                save(updated);
            }
            updated.error = null;
            save(updated);
            const keep = Number(process.env.BACKUP_KEEP || 168);
            if (!Number.isInteger(keep) || keep < 2 || keep > 1000)
                throw new Error('BACKUP_KEEP must be between 2 and 1000');
            prune(directory, keep);
            console.log('[BACKUP] verified snapshot saved');
            return destination;
        } finally {
            if (fs.existsSync(temp)) fs.unlinkSync(temp);
        }
    })()
        .catch((err) => {
            failure(err);
            throw err;
        })
        .finally(() => {
            inFlight = null;
        });
    return inFlight;
}
function startBackupScheduler(intervalMs = 60 * 60 * 1000) {
    if (scheduler) return;
    runBackup().catch(() => {});
    scheduler = setInterval(() => runBackup().catch(() => {}), intervalMs);
    scheduler.unref();
}
async function stopBackupScheduler() {
    if (scheduler) {
        clearInterval(scheduler);
        scheduler = null;
    }
    if (inFlight) await inFlight.catch(() => {});
}
module.exports = {
    runBackup,
    startBackupScheduler,
    stopBackupScheduler,
    getBackupStatus
};
