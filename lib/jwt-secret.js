const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIN_SECRET_LENGTH = 32;

const WEAK_MARKERS = [
    'change-me', 'change-this', 'changeme', 'your-super-secret', 'secret-key',
    'secretkey', 'admin123', 'password', 'example', 'placeholder', 'default',
    'your_secret', 'super-secret'
];

function isWeakSecret(secret) {
    if (!secret) return true;
    if (secret.length < MIN_SECRET_LENGTH) return true;
    const lower = secret.toLowerCase();
    return WEAK_MARKERS.some(m => lower.includes(m));
}

function loadJwtSecret() {
    const envSecret = process.env.JWT_SECRET;

    if (envSecret) {
        if (isWeakSecret(envSecret)) {
            const msg = 'JWT_SECRET is missing, too short, or a known placeholder. Set a strong random secret (at least 32 chars).';
            if (process.env.NODE_ENV === 'production') throw new Error(msg);
            console.warn('[warn] ' + msg + ' (using it anyway in development)');
            return envSecret;
        }
        return envSecret;
    }

    if (process.env.NODE_ENV === 'production') {
        throw new Error('JWT_SECRET is required in production. Set a strong random secret.');
    }

    const secretPath = path.join(__dirname, '..', '.jwt-secret');
    try {
        if (fs.existsSync(secretPath)) {
            const existing = fs.readFileSync(secretPath, 'utf8').trim();
            if (existing && !isWeakSecret(existing)) return existing;
        }
    } catch (e) { /* ignore */ }
    const generated = crypto.randomBytes(48).toString('hex');
    try { fs.writeFileSync(secretPath, generated, { mode: 0o600 }); } catch (e) { /* ignore */ }
    return generated;
}

module.exports = { isWeakSecret, loadJwtSecret, MIN_SECRET_LENGTH };
