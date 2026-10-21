const WEAK_PASSWORDS = new Set([
    'admin123',
    'password',
    'password1',
    'password123',
    '12345678',
    '123456789',
    'qwerty123',
    'letmein',
    'changeme'
]);

function isWeakPassword(password, { minLength = 8 } = {}) {
    if (password == null) return true;
    const value = String(password);
    if (value.trim() !== value) return true;
    if (value.length < minLength) return true;
    if (WEAK_PASSWORDS.has(value.toLowerCase())) return true;
    return false;
}

function validateAdminPassword(password) {
    const value = password == null ? '' : String(password).trim();
    if (!value) {
        throw new Error(
            'ADMIN_PASSWORD is required to create the initial administrator account. ' +
            'Set a strong ADMIN_PASSWORD environment variable (at least 8 characters) and restart.'
        );
    }
    if (isWeakPassword(value, { minLength: 8 })) {
        throw new Error(
            'ADMIN_PASSWORD is too weak. Use at least 8 characters and do not use a known default password.'
        );
    }
    return value;
}

module.exports = { isWeakPassword, validateAdminPassword };
