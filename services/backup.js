const fs = require('fs');
const path = require('path');
const { getDb } = require('../database');

const backupDir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');

function runBackup() {
    try {
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        const db = getDb();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const dest = path.join(backupDir, `paint_inventory-${stamp}.db`);
        db.backup(dest)
            .then(() => {
                console.log('[BACKUP] Saved to', dest);
                pruneOldBackups();
            })
            .catch(err => console.error('[BACKUP] failed:', err.message));
    } catch (err) {
        console.error('[BACKUP] failed:', err.message);
    }
}

function pruneOldBackups(keep = 10) {
    try {
        const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.db')).sort();
        while (files.length > keep) {
            const oldest = files.shift();
            fs.unlinkSync(path.join(backupDir, oldest));
        }
    } catch (err) { /* ignore */ }
}

function startBackupScheduler(intervalMs = 24 * 60 * 60 * 1000) {
    runBackup();
    setInterval(runBackup, intervalMs);
}

module.exports = { runBackup, startBackupScheduler };