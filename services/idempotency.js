const { createHash } = require('node:crypto');
const { getDb } = require('../database');
const { ClientError } = require('../lib/errors');

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object')
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, canonical(value[key])])
        );
    return value;
}

function executeOnce(req, operation, action) {
    const key = req.get('Idempotency-Key');
    if (key && !/^[A-Za-z0-9_-]{16,128}$/.test(key))
        throw new ClientError(400, 'Invalid Idempotency-Key');
    const db = getDb();
    const fingerprint = createHash('sha256')
        .update(JSON.stringify(canonical(req.body)))
        .digest('hex');
    return db
        .transaction(() => {
            if (key) {
                const previous = db
                    .prepare(
                        'SELECT fingerprint, response FROM request_keys WHERE user_id=? AND operation=? AND key=?'
                    )
                    .get(req.user.id, operation, key);
                if (previous) {
                    if (previous.fingerprint !== fingerprint)
                        throw new ClientError(
                            409,
                            'This request key was already used for different data'
                        );
                    return {
                        body: JSON.parse(previous.response),
                        replay: true
                    };
                }
            }
            const body = action();
            if (key)
                db.prepare(
                    'INSERT INTO request_keys (user_id,operation,key,fingerprint,response) VALUES (?,?,?,?,?)'
                ).run(
                    req.user.id,
                    operation,
                    key,
                    fingerprint,
                    JSON.stringify(body)
                );
            return { body, replay: false };
        })
        .immediate();
}

module.exports = { executeOnce };
