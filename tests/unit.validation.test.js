const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DB_PATH = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'paint-validation-')),
    'test.db'
);
process.env.NODE_ENV = 'test';
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const {
    parsePositiveInteger,
    parseNonNegativeInteger,
    parseFiniteNumber
} = require('../lib/validation');
const { sanitizeCell } = require('../lib/export');
const { isSafeWebhookUrl } = require('../services/notifications');
after(() => require('../database').getDb().close());

describe('Quantity validation', () => {
    it('accepts positive integers', () => {
        assert.equal(parsePositiveInteger(1), 1);
        assert.equal(parsePositiveInteger('3'), 3);
    });

    it('rejects zero, negative, fractional, NaN, Infinity and unsafe integers', () => {
        for (const value of [null, true, false, '', [], {}])
            assert.throws(() => parsePositiveInteger(value));
        assert.throws(() => parsePositiveInteger(0));
        assert.throws(() => parsePositiveInteger(-1));
        assert.throws(() => parsePositiveInteger('1.9'));
        assert.throws(() => parsePositiveInteger(1.5));
        assert.throws(() => parsePositiveInteger('abc'));
        assert.throws(() => parsePositiveInteger(NaN));
        assert.throws(() => parsePositiveInteger(Infinity));
        assert.throws(() => parsePositiveInteger(Number.MAX_SAFE_INTEGER + 1));
    });

    it('accepts zero for non-negative quantity', () => {
        assert.equal(parseNonNegativeInteger(0), 0);
        assert.throws(() => parseNonNegativeInteger(-1));
        assert.throws(() => parseNonNegativeInteger('2.5'));
    });

    it('rejects non-finite numbers', () => {
        assert.throws(() => parseFiniteNumber(NaN));
        assert.throws(() => parseFiniteNumber(Infinity));
        assert.equal(parseFiniteNumber('12.34'), 12.34);
    });
});

describe('Spreadsheet formula injection', () => {
    it('prefixes leading formula characters with a quote', () => {
        assert.equal(sanitizeCell('=cmd|...'), "'=cmd|...");
        assert.equal(sanitizeCell('+SUM(A1)'), "'+SUM(A1)");
        assert.equal(sanitizeCell('-1+2'), "'-1+2");
        assert.equal(sanitizeCell('@foo'), "'@foo");
    });

    it('leaves normal strings unchanged', () => {
        assert.equal(sanitizeCell('Acrylic White'), 'Acrylic White');
        assert.equal(sanitizeCell(''), '');
        assert.equal(sanitizeCell(null), '');
    });
});

describe('Webhook URL safety', () => {
    it('accepts public http(s) URLs', () => {
        assert.equal(isSafeWebhookUrl('https://example.com/hook'), true);
        assert.equal(isSafeWebhookUrl('http://example.com/hook'), true);
    });

    it('rejects non-http protocols and malformed URLs', () => {
        assert.equal(isSafeWebhookUrl('file:///etc/passwd'), false);
        assert.equal(isSafeWebhookUrl('ftp://example.com'), false);
        assert.equal(isSafeWebhookUrl('not-a-url'), false);
        assert.equal(isSafeWebhookUrl(''), false);
    });

    it('rejects localhost and private ranges', () => {
        assert.equal(isSafeWebhookUrl('http://localhost:3000/hook'), false);
        assert.equal(isSafeWebhookUrl('http://127.0.0.1/hook'), false);
        assert.equal(isSafeWebhookUrl('http://10.0.0.1/hook'), false);
        assert.equal(isSafeWebhookUrl('http://192.168.1.5/hook'), false);
        assert.equal(isSafeWebhookUrl('http://172.16.0.1/hook'), false);
        assert.equal(
            isSafeWebhookUrl('http://169.254.169.254/latest/meta-data'),
            false
        );
    });
});
