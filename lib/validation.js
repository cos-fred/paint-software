const { ClientError } = require('./errors');
function numeric(value) {
    if (
        !['number', 'string'].includes(typeof value) ||
        (typeof value === 'string' && !value.trim())
    )
        return NaN;
    return Number(value);
}

// Strict numeric validation helpers. These reject values that would otherwise
// be silently coerced or truncated (e.g. parseInt('1.9') === 1).

function parsePositiveInteger(value, label = 'Quantity') {
    const num = numeric(value);
    if (!Number.isSafeInteger(num) || num <= 0) {
        throw new ClientError(400, `${label} must be a positive whole number`);
    }
    return num;
}

function parseNonNegativeInteger(value, label = 'Quantity') {
    const num = numeric(value);
    if (!Number.isSafeInteger(num) || num < 0) {
        throw new ClientError(
            400,
            `${label} must be a non-negative whole number`
        );
    }
    return num;
}

function parseFiniteNumber(value, label = 'Value') {
    const num = numeric(value);
    if (!Number.isFinite(num)) {
        throw new ClientError(400, `${label} must be a valid number`);
    }
    return num;
}

function parseNonNegativeNumber(value, label = 'Value') {
    const num = numeric(value);
    if (!Number.isFinite(num) || num < 0) {
        throw new ClientError(400, `${label} must be a non-negative number`);
    }
    return num;
}

function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
}

function parseLimit(value, fallback = 100, max = 500) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return fallback;
    return Math.min(Math.floor(num), max);
}

function parseOffset(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) return 0;
    return Math.floor(num);
}

module.exports = {
    parsePositiveInteger,
    parseNonNegativeInteger,
    parseFiniteNumber,
    parseNonNegativeNumber,
    round2,
    parseLimit,
    parseOffset
};
