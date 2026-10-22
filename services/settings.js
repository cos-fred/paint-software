const { getDb } = require('../database');
const { ClientError } = require('../lib/errors');
const { logAudit } = require('./audit');
const { safeUrl } = require('../lib/public-http');
const validators = {
    company_name: (v) =>
        typeof v === 'string' && v.trim().length > 0 && v.length <= 120,
    company_address: (v) => typeof v === 'string' && v.length <= 300,
    company_phone: (v) => typeof v === 'string' && v.length <= 40,
    company_email: (v) =>
        v === '' ||
        (typeof v === 'string' &&
            v.length <= 200 &&
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)),
    show_total_value: (v) => ['true', 'false'].includes(v),
    currency: (v) => /^[A-Z]{3}$/.test(v),
    low_stock_threshold_default: (v) => /^\d+$/.test(v) && Number(v) <= 1000000,
    notifications_enabled: (v) => ['true', 'false'].includes(v),
    notifications_webhook_url: (v) =>
        v === '' || (v.length <= 500 && !!safeUrl(v))
};
function saveSettings(values, userId, descriptions = {}) {
    if (
        !values ||
        typeof values !== 'object' ||
        Array.isArray(values) ||
        !Object.keys(values).length
    )
        throw new ClientError(400, 'Settings are required');
    const entries = Object.entries(values).map(([key, raw]) => {
        if (!Object.hasOwn(validators, key))
            throw new ClientError(400, 'Unknown setting');
        if (!['string', 'number', 'boolean'].includes(typeof raw))
            throw new ClientError(400, `Invalid value for ${key}`);
        let value = String(raw);
        if (key === 'currency') value = value.toUpperCase();
        if (!validators[key](value))
            throw new ClientError(400, `Invalid value for ${key}`);
        return [key, value];
    });
    const db = getDb();
    db.transaction(() => {
        for (const [key, value] of entries) {
            // Existing receipts use the currency configured when issued. Until a
            // multi-currency ledger exists, changing it after sales is disallowed.
            if (key === 'currency') {
                const current = db
                    .prepare("SELECT value FROM settings WHERE key='currency'")
                    .get();
                if (
                    current &&
                    current.value !== value &&
                    db.prepare('SELECT 1 FROM sales LIMIT 1').get()
                )
                    throw new ClientError(
                        400,
                        'Currency cannot change after sales have been recorded'
                    );
            }
            const description = descriptions[key] ?? null;
            if (
                description !== null &&
                (typeof description !== 'string' || description.length > 300)
            )
                throw new ClientError(400, 'Invalid description');
            db.prepare(
                'INSERT INTO settings(key,value,description) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,description=COALESCE(excluded.description,settings.description)'
            ).run(key, value, description);
        }
        logAudit(userId, 'settings.update', 'settings', null, {
            keys: entries.map(([key]) => key)
        });
    }).immediate();
}
module.exports = { saveSettings };
