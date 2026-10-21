const { getDb } = require('../database');

const WEBHOOK_TIMEOUT_MS = 10000;

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

function isPrivateHost(hostname) {
    const h = String(hostname).toLowerCase();
    if (h === 'localhost' || h === '0.0.0.0' || h === '::1' || h === '::') return true;
    if (h.startsWith('127.')) return true;
    if (/^10\./.test(h)) return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^169\.254\./.test(h)) return true;
    const m = h.match(/^172\.(\d{1,3})\./);
    if (m) {
        const second = parseInt(m[1], 10);
        if (second >= 16 && second <= 31) return true;
    }
    return false;
}

// Validate the webhook destination to prevent SSRF and non-HTTP protocols.
function isSafeWebhookUrl(url) {
    if (!url) return false;
    let parsed;
    try {
        parsed = new URL(url);
    } catch (e) {
        return false;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    if (isPrivateHost(parsed.hostname)) return false;
    return true;
}

async function notifyLowStock({ productName, warehouseName, unitType, current, threshold }) {
    if (!isEnabled()) return false;

    const webhookUrl = getSetting('notifications_webhook_url', '');
    const message = `⚠️ Low stock: ${productName} (${warehouseName}) has ${current} ${unitType} left (threshold: ${threshold})`;

    console.log('[NOTIFY]', message);

    if (!webhookUrl) return false;

    if (!isSafeWebhookUrl(webhookUrl)) {
        console.error('[NOTIFY] webhook URL is invalid or disallowed');
        return false;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: message, product_name: productName, warehouse: warehouseName, unit_type: unitType, current, threshold }),
            signal: controller.signal
        });
        if (!response.ok) {
            console.error('[NOTIFY] webhook returned', response.status);
            return false;
        }
        return true;
    } catch (err) {
        console.error('[NOTIFY] webhook failed:', err.message);
        return false;
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { notifyLowStock, isEnabled, isSafeWebhookUrl };
