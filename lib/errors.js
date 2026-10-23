class ClientError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'ClientError';
        this.status = status;
        this.expose = true;
    }
}

class StockShortageError extends ClientError {
    constructor(shortages) {
        super(400, 'Insufficient stock: ' + shortages.map((item) =>
            `${item.product_name}${item.sku ? ` (${item.sku})` : ''}: requested ${item.requested_label}; available ${item.available_label}`
        ).join('; '));
        this.shortages = shortages;
    }
}

function sendSafeError(res, err, logLabel) {
    if (err instanceof StockShortageError) {
        return res.status(err.status).json({
            error: err.message,
            code: 'INSUFFICIENT_STOCK',
            shortages: err.shortages
        });
    }
    if (err instanceof ClientError) {
        return res.status(err.status).json({ error: err.message });
    }
    const code = err && err.code;
    const msg = err && typeof err.message === 'string' ? err.message : '';
    if (code === 'SQLITE_CONSTRAINT_UNIQUE' || msg.includes('UNIQUE')) {
        return res.status(400).json({ error: 'That value is already in use' });
    }
    if (code === 'SQLITE_CONSTRAINT_CHECK' || code === 'SQLITE_CONSTRAINT_NOTNULL' ||
        msg.includes('CHECK constraint failed') || msg.includes('NOT NULL constraint failed')) {
        return res.status(400).json({ error: 'Invalid data provided' });
    }
    console.error(logLabel || '[error]', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Something went wrong' });
}

module.exports = { ClientError, StockShortageError, sendSafeError };
