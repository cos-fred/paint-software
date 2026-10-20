const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');

function runNode(env, source) {
    return spawnSync(process.execPath, ['-e', source], {
        cwd: root,
        env: { ...process.env, ...env },
        encoding: 'utf8'
    });
}

describe('Startup configuration', () => {
    it('fails safely when ADMIN_PASSWORD is missing on a fresh database', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-admin-'));
        const result = runNode({
            NODE_ENV: 'test',
            DB_PATH: path.join(dir, 'fresh.db'),
            JWT_SECRET: 'a'.repeat(48),
            ADMIN_PASSWORD: ''
        }, `
            const { initializeDatabase } = require('./database');
            try {
                initializeDatabase();
                console.error('expected failure');
                process.exit(2);
            } catch (err) {
                if (String(err.message).includes('ADMIN_PASSWORD')) process.exit(0);
                console.error(err);
                process.exit(1);
            }
        `);
        assert.equal(result.status, 0, result.stderr + result.stdout);
    });

    it('does not reset an existing administrator password', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-admin2-'));
        const result = runNode({
            NODE_ENV: 'test',
            DB_PATH: path.join(dir, 'keep.db'),
            JWT_SECRET: 'a'.repeat(48),
            ADMIN_PASSWORD: 'FirstAdminPass12'
        }, `
            const { initializeDatabase, getDb } = require('./database');
            initializeDatabase();
            const first = getDb().prepare('SELECT password_hash FROM users WHERE username = ?').get('admin');
            delete process.env.ADMIN_PASSWORD;
            process.env.ADMIN_PASSWORD = 'SecondAdminPass99';
            initializeDatabase();
            const second = getDb().prepare('SELECT password_hash FROM users WHERE username = ?').get('admin');
            if (first.password_hash !== second.password_hash) process.exit(3);
            process.exit(0);
        `);
        assert.equal(result.status, 0, result.stderr + result.stdout);
    });

    it('rejects a placeholder JWT secret in production', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-jwt-'));
        const result = runNode({
            NODE_ENV: 'production',
            DB_PATH: path.join(dir, 'jwt.db'),
            JWT_SECRET: 'your-super-secret-key-change-in-production'
        }, `require('./auth');`);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr + result.stdout, /JWT_SECRET/);
    });
});
