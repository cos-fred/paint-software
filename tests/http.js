const http = require('http');

function request(server, { method = 'GET', path, token, body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const addr = server.address();
        const data = body === undefined ? null : JSON.stringify(body);
        const reqHeaders = { ...headers };
        if (data) {
            reqHeaders['Content-Type'] = 'application/json';
            reqHeaders['Content-Length'] = Buffer.byteLength(data);
        }
        if (token) reqHeaders.Authorization = `Bearer ${token}`;

        const req = http.request({
            host: '127.0.0.1',
            port: addr.port,
            method,
            path,
            headers: reqHeaders
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let parsed = raw;
                try { parsed = raw ? JSON.parse(raw) : null; } catch { /* keep raw */ }
                resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

function listen(app) {
    const server = http.createServer(app);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

module.exports = { request, listen };
