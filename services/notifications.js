const { getDb } = require('../database');
const { safeUrl, publicRequest } = require('../lib/public-http');
function setting(key, fallback = '') {
    const row = getDb()
        .prepare('SELECT value FROM settings WHERE key=?')
        .get(key);
    return row ? row.value : fallback;
}
function isEnabled() {
    return setting('notifications_enabled', 'false') === 'true';
}
function isSafeWebhookUrl(value) {
    return !!safeUrl(value);
}
async function notifyLowStock({
    productName,
    warehouseName,
    unitType,
    current,
    threshold
}) {
    if (!isEnabled()) return false;
    const url = setting('notifications_webhook_url');
    if (!url) return false;
    try {
        await publicRequest(url, {
            body: JSON.stringify({
                text: `Low stock: ${productName} (${warehouseName}) has ${current} ${unitType} left (threshold: ${threshold})`,
                product_name: productName,
                warehouse: warehouseName,
                unit_type: unitType,
                current,
                threshold
            }),
            headers: { 'Content-Type': 'application/json' }
        });
        return true;
    } catch (err) {
        console.error('[NOTIFY] webhook failed:', err.message);
        return false;
    }
}
module.exports = { notifyLowStock, isEnabled, isSafeWebhookUrl };
