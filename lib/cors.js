function parseCorsOrigins(raw, nodeEnv) {
    const env = nodeEnv || process.env.NODE_ENV || 'development';
    const value = (raw == null ? '' : String(raw)).trim();
    if (!value) return [];

    if (value === '*') {
        if (env === 'production') {
            throw new Error('CORS_ORIGIN=* is not allowed in production. Set explicit comma-separated origins.');
        }
        return '*';
    }

    const origins = value.split(',').map((s) => s.trim()).filter(Boolean);
    if (origins.length === 0) return [];

    for (const origin of origins) {
        if (origin === '*') {
            throw new Error('CORS_ORIGIN cannot mix "*" with other origins. Use a list of explicit origins.');
        }
        let parsed;
        try {
            parsed = new URL(origin);
        } catch {
            throw new Error(`Malformed CORS_ORIGIN value: ${origin}`);
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error(`CORS_ORIGIN must be an http(s) origin: ${origin}`);
        }
        if (parsed.pathname !== '/' && parsed.pathname !== '') {
            throw new Error(`CORS_ORIGIN must not include a path: ${origin}`);
        }
        if (origin.endsWith('/')) {
            throw new Error(`CORS_ORIGIN must not end with a slash: ${origin}`);
        }
    }
    return origins;
}

function corsOriginOption(allowed) {
    if (allowed === '*') return '*';
    return function originCheck(origin, callback) {
        if (!origin) return callback(null, true);
        if (Array.isArray(allowed) && allowed.includes(origin)) return callback(null, true);
        return callback(null, false);
    };
}

module.exports = { parseCorsOrigins, corsOriginOption };
