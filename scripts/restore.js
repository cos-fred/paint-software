const path = require('node:path');
require('dotenv').config();
const { restoreToNewFile } = require('../lib/backup-files');
const [source, output] = process.argv.slice(2);
if (!source || !output) {
    console.error('Usage: npm run restore -- backup.db[.enc] NEW-database.db');
    process.exitCode = 1;
} else {
    try {
        const file = restoreToNewFile(
            path.resolve(source),
            path.resolve(output)
        );
        console.log('Verified restored database:', file);
        console.log(
            'With the server stopped, set DB_PATH to this new file before restarting.'
        );
    } catch (err) {
        console.error('Restore refused:', err.message);
        process.exitCode = 1;
    }
}
