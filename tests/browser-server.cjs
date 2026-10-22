const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paint-browser-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(directory, 'browser.db');
process.env.BACKUP_DIR = path.join(directory, 'backups');
process.env.JWT_SECRET = 'browser-test-signing-key-of-more-than-48-characters';
process.env.ADMIN_PASSWORD = 'BrowserAdminPass12';
process.env.CORS_ORIGIN = '';
const { initializeDatabase, getDb } = require('../database');
initializeDatabase();
const insert = getDb().prepare(
    'INSERT INTO customers(id,name,email) VALUES(?,?,?)'
);
for (let n = 0; n < 121; n++)
    insert.run(
        randomUUID(),
        `Customer ${String(n).padStart(3, '0')}`,
        `customer${n}@example.invalid`
    );
insert.run(randomUUID(), 'ZZZ Older Customer', 'older@example.invalid');
const server = require('node:http').createServer(
    require('../server').createApp()
);
require('../services/realtime').init(server, []);
server.listen(39173, '127.0.0.1', () =>
    console.log('Isolated browser-test server ready')
);
process.on('SIGTERM', () => {
    require('../services/realtime').close();
    server.close(() => {
        getDb().close();
        process.exit(0);
    });
});
