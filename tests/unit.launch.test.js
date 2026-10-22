const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const money = require('../lib/money');
const {
    isPublicAddress,
    safeUrl,
    publicRequest
} = require('../lib/public-http');
describe('Exact money and outbound destination safeguards', () => {
    it('allocates cents exactly and deterministically', () => {
        assert.deepEqual(money.allocate(1, [1, 1, 1]), [1, 0, 0]);
        assert.deepEqual(money.allocate(100, [600, 1000]), [38, 62]);
        assert.equal(money.sum(money.allocate(1001, [777, 888, 999])), 1001);
        for (const value of [NaN, Infinity, -1, '', true, 0.001, 1e100])
            assert.throws(() => money.cents(value));
        assert.equal(money.cents(0.29), 29);
        assert.throws(() => money.multiply(money.MAX_CENTS, 2));
    });
    it('blocks IPv4 and IPv6 loopback, private, mapped and special addresses', () => {
        for (const ip of [
            '127.0.0.1',
            '10.0.0.1',
            '169.254.169.254',
            '100.64.0.1',
            '::1',
            '::',
            'fc00::1',
            'fe80::1',
            '::ffff:127.0.0.1',
            '2002:7f00:1::',
            '2001:db8::1'
        ])
            assert.equal(isPublicAddress(ip), false, ip);
        assert.equal(isPublicAddress('8.8.8.8'), true);
        assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
        for (const url of [
            'http://[::1]/',
            'http://[::ffff:127.0.0.1]/',
            'https://user:secret@example.com',
            'file:///tmp/a'
        ])
            assert.equal(safeUrl(url), null);
    });
    it('rejects a hostname with any non-public DNS answer before sending a request', async () => {
        await assert.rejects(
            publicRequest('https://example.com', {
                lookup: async () => [
                    { address: '8.8.8.8', family: 4 },
                    { address: '127.0.0.1', family: 4 }
                ]
            }),
            /non-public/
        );
    });
    it('pins the connection to its checked DNS answer and does not follow redirects', async (t) => {
        const https = require('node:https');
        let calls = 0;
        let pinned;
        t.mock.method(https, 'request', (url, options, callback) => {
            calls++;
            options.lookup('example.com', {}, (err, address) => {
                assert.equal(err, null);
                pinned = address;
            });
            const req = new EventEmitter();
            req.destroy = (err) => req.emit('error', err);
            req.end = () => {
                const res = new EventEmitter();
                res.statusCode = 302;
                res.resume = () => {};
                callback(res);
                process.nextTick(() => {
                    res.emit('end');
                    req.emit('close');
                });
            };
            return req;
        });
        await assert.rejects(
            publicRequest('https://example.com/hook', {
                lookup: async () => [{ address: '8.8.8.8', family: 4 }]
            }),
            /redirects are not followed/
        );
        assert.equal(calls, 1);
        assert.equal(pinned, '8.8.8.8');
    });
});
