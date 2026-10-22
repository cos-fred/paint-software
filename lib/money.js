const { ClientError } = require('./errors');
const MAX_CENTS = 1_000_000_000_000;

function cents(value, label = 'Amount') {
    if (
        value === null ||
        value === '' ||
        typeof value === 'boolean' ||
        !['number', 'string'].includes(typeof value)
    ) {
        throw new ClientError(400, `${label} must be a monetary amount`);
    }
    const number = Number(value);
    const minor = Math.round(number * 100);
    if (
        !Number.isFinite(number) ||
        number < 0 ||
        !Number.isSafeInteger(minor) ||
        minor > MAX_CENTS ||
        Math.abs(number * 100 - minor) > 0.00001
    ) {
        throw new ClientError(
            400,
            `${label} must be non-negative, within the supported range, and have at most two decimal places`
        );
    }
    return minor;
}

function checked(value, label = 'Total') {
    if (typeof value === 'bigint') {
        if (value < 0n || value > BigInt(MAX_CENTS))
            throw new ClientError(
                400,
                `${label} is outside the supported range`
            );
        return Number(value);
    }
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CENTS)
        throw new ClientError(400, `${label} is outside the supported range`);
    return value;
}

const amount = (minor) => checked(minor) / 100;
const multiply = (minor, quantity) => checked(BigInt(minor) * BigInt(quantity));
const sum = (values) =>
    checked(values.reduce((total, value) => total + BigInt(value), 0n));

// Largest-remainder allocation: every cent belongs to exactly one line.
function allocate(total, weights) {
    checked(total);
    if (!weights.length) return [];
    const denominator = weights.reduce(
        (n, weight) => n + BigInt(checked(weight)),
        0n
    );
    if (denominator === 0n) {
        if (total)
            throw new ClientError(
                400,
                'Cannot allocate an amount to empty sale lines'
            );
        return weights.map(() => 0);
    }
    const rows = weights.map((weight, index) => {
        const numerator = BigInt(total) * BigInt(weight);
        return {
            index,
            value: Number(numerator / denominator),
            remainder: numerator % denominator
        };
    });
    let remaining = total - rows.reduce((n, row) => n + row.value, 0);
    const ranked = [...rows].sort((a, b) =>
        a.remainder === b.remainder
            ? a.index - b.index
            : a.remainder > b.remainder
              ? -1
              : 1
    );
    for (const row of ranked) {
        if (remaining-- <= 0) break;
        rows[row.index].value++;
    }
    return rows.map((row) => row.value);
}

// Cumulative rounding ensures partial credits add up to the exact line total.
function cumulativeCredit(netCents, returned, sold) {
    return checked((BigInt(netCents) * BigInt(returned)) / BigInt(sold));
}

module.exports = {
    cents,
    amount,
    checked,
    multiply,
    sum,
    allocate,
    cumulativeCredit,
    MAX_CENTS
};
