class ClientError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'ClientError';
        this.status = status;
        this.expose = true;
    }
}

function sendSafeError(res, err, logLabel) {
    if (err instanceof ClientError) {
        return res.status(err.status).json({ error: err.message });
    }
    const code = err && err.code;
    if (code === 'SQLITE_CONSTRAINT_UNIQUE' || (err && typeof err.message === 'string' && err.message.includes('UNIQUE'))) {
        return res.status(400).json({ error: 'That value is already in use' });
    }
    console.error(logLabel || '[error]', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Something went wrong' });
}

module.exports = { ClientError, sendSafeError };
