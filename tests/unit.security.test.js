const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseCorsOrigins } = require('../lib/cors');
const { isWeakPassword, validateAdminPassword } = require('../lib/passwords');
const { isWeakSecret } = require('../lib/jwt-secret');

describe('CORS origin parsing', () => {
    it('allows an empty list (same-origin only)', () => {
        assert.deepEqual(parseCorsOrigins('', 'production'), []);
        assert.deepEqual(parseCorsOrigins(undefined, 'production'), []);
    });

    it('allows an explicit production origin', () => {
        assert.deepEqual(
            parseCorsOrigins('https://app.example.com', 'production'),
            ['https://app.example.com']
        );
    });

    it('rejects wildcard in production', () => {
        assert.throws(() => parseCorsOrigins('*', 'production'), /not allowed in production/);
    });

    it('allows wildcard only in development', () => {
        assert.equal(parseCorsOrigins('*', 'development'), '*');
    });

    it('rejects malformed production origins', () => {
        assert.throws(() => parseCorsOrigins('not-a-url', 'production'), /Malformed/);
        assert.throws(() => parseCorsOrigins('https://app.example.com/', 'production'), /slash/);
        assert.throws(() => parseCorsOrigins('ftp://app.example.com', 'production'), /http/);
    });
});

describe('Password and JWT secret policy', () => {
    it('rejects missing, empty, short, and default passwords', () => {
        assert.equal(isWeakPassword(''), true);
        assert.equal(isWeakPassword('admin123'), true);
        assert.equal(isWeakPassword('short'), true);
        assert.equal(isWeakPassword('GoodPass9'), false);
        assert.throws(() => validateAdminPassword(''), /ADMIN_PASSWORD is required/);
        assert.throws(() => validateAdminPassword('admin123'), /too weak/);
        assert.throws(() => validateAdminPassword('   '), /ADMIN_PASSWORD is required/);
        assert.equal(validateAdminPassword('StrongAdminPass12'), 'StrongAdminPass12');
    });

    it('rejects placeholder JWT secrets', () => {
        assert.equal(isWeakSecret(''), true);
        assert.equal(isWeakSecret('short'), true);
        assert.equal(isWeakSecret('your-super-secret-key-change-in-production'), true);
        assert.equal(isWeakSecret('a'.repeat(48)), false);
    });
});
