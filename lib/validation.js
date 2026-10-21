const { ClientError } = require('./errors');

// Strict numeric validation helpers. These reject values that would otherwise
// be silently coerced or truncated (e.g. parseInt('1.9') === 1).

function parsePositiveInteger(value, label = 'Quantity') {
    const num = Number(value);
    if (!Number.isSafeInteger(num) || num <= 0) {
        throw new ClientError(400, `${label} must be a positive whole number`);
    }
    return num;
}

function parseNonNegativeInteger(value, label = 'Quantity') {
    const num = Number(value);
    if (!Number.isSafeInteger(num) || num < 0) {
        throw new ClientError(400, `${label} must be a non-negative whole number`);
    }
    return num;
}

function parseFiniteNumber(value, label = 'Value') {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        throw new ClientError(400, `${label} must be a valid number`);
    }
    return num;
}

module.exports = { parsePositiveInteger, parseNonNegativeInteger, parseFiniteNumber };
