const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

it('production startup, verified backups and committed stock survive a server restart', async () => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'paint-production-smoke-')
    );
    const env = {
        ...process.env,
        NODE_ENV: 'production',
        PORT: '0',
        DB_PATH: path.join(directory, 'app.db'),
        BACKUP_DIR: path.join(directory, 'backups'),
        JWT_SECRET: 'startup-launch-strong-key-012345678901234567890123456789',
        ADMIN_PASSWORD: 'ProductionSmokePass12',
        CORS_ORIGIN: '',
        BACKUP_REMOTE_URL: '',
        BACKUP_MIRROR_DIR: '',
        BACKUP_ENCRYPTION_KEY: '',
        BACKUP_ALERT_WEBHOOK_URL: '',
        ALLOW_SYSTEM_RESET: 'false'
    };
    const source = `const server=require('./server').startServer();server.on('listening',()=>console.log('SMOKE_READY:'+server.address().port));`;
    async function start() {
        const child = spawn(process.execPath, ['-e', source], {
            cwd: path.join(__dirname, '..'),
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let logs = '';
        child.stderr.on('data', (chunk) => {
            logs += chunk;
        });
        const port = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                child.kill();
                reject(new Error('Startup timed out: ' + logs));
            }, 10000);
            child.stdout.on('data', (chunk) => {
                logs += chunk;
                const ready = /SMOKE_READY:(\d+)/.exec(logs);
                if (ready) {
                    clearTimeout(timeout);
                    resolve(Number(ready[1]));
                }
            });
            child.once('exit', (code) => {
                clearTimeout(timeout);
                reject(new Error('Startup exited ' + code + ': ' + logs));
            });
        });
        return { child, base: 'http://127.0.0.1:' + port };
    }
    async function stop(child) {
        if (child.exitCode !== null) return;
        const exited = once(child, 'exit');
        child.kill();
        await exited;
    }
    async function call(base, url, { token, method = 'GET', body } = {}) {
        const response = await fetch(base + url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: 'Bearer ' + token } : {})
            },
            body: body ? JSON.stringify(body) : undefined
        });
        return { status: response.status, body: await response.json() };
    }
    let running;
    try {
        running = await start();
        assert.equal((await call(running.base, '/api/health')).status, 200);
        const login = await call(running.base, '/api/auth/login', {
            method: 'POST',
            body: { username: 'admin', password: env.ADMIN_PASSWORD }
        });
        const token = login.body.token;
        const warehouse = (
            await call(running.base, '/api/warehouses', { token })
        ).body[0].id;
        const product = await call(running.base, '/api/products', {
            token,
            method: 'POST',
            body: {
                name: 'Persistent Paint',
                warehouse_id: warehouse,
                unit_price: 10,
                units_per_carton: 12,
                cartons: 2
            }
        });
        assert.equal(product.status, 201);
        const sale = await call(running.base, '/api/sales', {
            token,
            method: 'POST',
            body: {
                warehouse_id: warehouse,
                items: [
                    {
                        product_id: product.body.id,
                        unit_type: 'unit',
                        quantity: 1
                    }
                ]
            }
        });
        assert.equal(sale.status, 201);
        assert.equal(
            (
                await call(running.base, '/api/system/reset', {
                    token,
                    method: 'POST',
                    body: { password: env.ADMIN_PASSWORD }
                })
            ).status,
            403
        );
        assert.equal(
            (
                await call(running.base, '/api/system/backup', {
                    token,
                    method: 'POST',
                    body: {}
                })
            ).status,
            200
        );
        await stop(running.child);
        running = await start();
        const retained = await call(
            running.base,
            `/api/products/${product.body.id}?warehouse_id=${warehouse}`,
            { token }
        );
        assert.equal(retained.status, 200);
        assert.equal(retained.body.warehouse_unit_stock, 23);
        assert.equal(
            (await call(running.base, '/api/sales/' + sale.body.id, { token }))
                .body.total,
            10
        );
        assert.ok(
            (await call(running.base, '/api/system/status', { token })).body
                .backup.last_success
        );
    } finally {
        if (running) await stop(running.child);
    }
});
