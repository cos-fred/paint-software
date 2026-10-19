const { getDb } = require('../database');

function getSetting(key, fallback = '') {
    try {
        const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
        return row ? row.value : fallback;
    } catch (e) {
        return fallback;
    }
}

function isEnabled() {
    return getSetting('notifications_enabled', 'false') === 'true';
}

async function notifyLowStock({ productName, warehouseName, unitType, current, threshold }) {
    if (!isEnabled()) return false;

    const webhookUrl = getSetting('notifications_webhook_url', '');
    const message = `⚠️ Low stock: ${productName} (${warehouseName}) has ${current} ${unitType} left (threshold: ${threshold})`;

    console.log('[NOTIFY]', message);

    if (webhookUrl) {
        try {
            await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: message, product_name: productName, warehouse: warehouseName, unit_type: unitType, current, threshold })
            });
            return true;
        } catch (err) {
            console.error('[NOTIFY] webhook failed:', err.message);
            return false;
        }
    }
    return false;
}

module.exports = { notifyLowStock, isEnabled };