const dns = require('node:dns').promises;
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

const blocked = new net.BlockList();
for (const [address, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4]
])
    blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const specialV6 = new net.BlockList();
specialV6.addSubnet('2001:db8::', 32, 'ipv6');
specialV6.addSubnet('2002::', 16, 'ipv6');
specialV6.addSubnet('2001::', 32, 'ipv6');

function isPublicAddress(address) {
    const ip = String(address).replace(/^\[|\]$/g, '');
    const family = net.isIP(ip);
    if (family === 4) return !blocked.check(ip, 'ipv4');
    if (family === 6)
        return globalV6.check(ip, 'ipv6') && !specialV6.check(ip, 'ipv6');
    return false;
}

function safeUrl(value) {
    try {
        const url = new URL(value);
        if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.hash
        )
            return null;
        const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        const allow = (process.env.WEBHOOK_ALLOWED_HOSTS || '')
            .split(',')
            .map((h) => h.trim().toLowerCase())
            .filter(Boolean);
        if (allow.length && !allow.includes(host)) return null;
        if (net.isIP(host)) return isPublicAddress(host) ? url : null;
        if (
            !host.includes('.') ||
            /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host)
        )
            return null;
        return url;
    } catch {
        return null;
    }
}

async function publicRequest(
    value,
    {
        method = 'POST',
        body = '',
        headers = {},
        timeoutMs = 10000,
        lookup = dns.lookup
    } = {}
) {
    const url = safeUrl(value);
    if (!url) throw new Error('Destination is invalid or disallowed');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(host)
        ? [{ address: host, family: net.isIP(host) }]
        : await lookup(host, { all: true, verbatim: true });
    if (
        !addresses.length ||
        addresses.some((row) => !isPublicAddress(row.address))
    )
        throw new Error('Destination resolves to a non-public address');
    const chosen = addresses[0];
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const request = transport.request(
            url,
            {
                method,
                headers: {
                    ...headers,
                    'Content-Length': Buffer.byteLength(body)
                },
                lookup: (_host, options, callback) =>
                    options.all
                        ? callback(null, [chosen])
                        : callback(null, chosen.address, chosen.family)
            },
            (response) => {
                response.resume();
                response.on('end', () => {
                    if (response.statusCode < 200 || response.statusCode >= 300)
                        return reject(
                            new Error(
                                `Destination returned ${response.statusCode}; redirects are not followed`
                            )
                        );
                    resolve({ status: response.statusCode });
                });
                response.on('error', reject);
            }
        );
        const timer = setTimeout(
            () => request.destroy(new Error('Request timed out')),
            timeoutMs
        );
        timer.unref();
        request.on('close', () => clearTimeout(timer));
        request.on('error', reject);
        request.end(body);
    });
}
module.exports = { isPublicAddress, safeUrl, publicRequest };
