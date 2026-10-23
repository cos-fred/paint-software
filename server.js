if (process.env.NODE_ENV !== 'test') require('dotenv').config();

process.on('uncaughtException', (err) => {
    console.error(
        '[FATAL] uncaughtException:',
        err && err.stack ? err.stack : err
    );
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] unhandledRejection:', reason);
    process.exit(1);
});

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { initializeDatabase } = require('./database');
const { startBackupScheduler } = require('./services/backup');
const { init: initRealtime } = require('./services/realtime');
const { parseCorsOrigins, corsOriginOption } = require('./lib/cors');

const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const customerRoutes = require('./routes/customers');
const salesRoutes = require('./routes/sales');
const reportRoutes = require('./routes/reports');
const alertRoutes = require('./routes/alerts');
const settingsRoutes = require('./routes/settings');
const userRoutes = require('./routes/users');
const transferRoutes = require('./routes/transfers');
const returnRoutes = require('./routes/returns');
const auditRoutes = require('./routes/audit');
const warehouseRoutes = require('./routes/warehouses');
const systemRoutes = require('./routes/system');

const PORT = process.env.PORT || 3000;

function createApp() {
    const app = express();

    if (process.env.TRUST_PROXY === '1') {
        app.set('trust proxy', 1);
    }

    const allowedOrigins = parseCorsOrigins(
        process.env.CORS_ORIGIN,
        process.env.NODE_ENV
    );

    app.use(
        helmet({
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    scriptSrc: ["'self'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                    fontSrc: ["'self'", 'data:'],
                    imgSrc: ["'self'", 'data:'],
                    connectSrc: ["'self'", 'ws:', 'wss:'],
                    objectSrc: ["'none'"],
                    baseUri: ["'self'"],
                    frameAncestors: ["'none'"]
                }
            }
        })
    );
    app.use(
        cors({ origin: corsOriginOption(allowedOrigins), credentials: true })
    );
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ extended: true }));
    app.use('/api', (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        if (
            ['POST', 'PUT', 'PATCH'].includes(req.method) &&
            req.path !== '/auth/logout' &&
            (!req.body ||
                typeof req.body !== 'object' ||
                Array.isArray(req.body))
        ) {
            return res.status(400).json({ error: 'A JSON object is required' });
        }
        if (
            !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
            require('./services/maintenance').isActive()
        ) {
            return res.status(503).json({
                error: 'System maintenance is in progress. Please retry shortly.'
            });
        }
        next();
    });

    const limiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 5000,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many requests, please try again later' }
    });
    app.use('/api/', limiter);

    app.use('/api/auth', authRoutes);
    app.use('/api/products', productRoutes);
    app.use('/api/customers', customerRoutes);
    app.use('/api/sales/:saleId/payments', require('./routes/payments'));
    app.use('/api/stocktakes', require('./routes/stocktakes'));
    app.use('/api/daily-closing', require('./routes/daily-closing'));
    app.use('/api/sales', salesRoutes);
    app.use('/api/reports', reportRoutes);
    app.use('/api/alerts', alertRoutes);
    app.use('/api/settings', settingsRoutes);
    app.use('/api/auth/users', userRoutes);
    app.use('/api/transfers', transferRoutes);
    app.use('/api/returns', returnRoutes);
    app.use('/api/audit', auditRoutes);
    app.use('/api/warehouses', warehouseRoutes);
    app.use('/api/system', systemRoutes);

    // Shared stock helpers used by both the server and the browser UI.
    app.get('/stock.js', (req, res) => {
        res.sendFile(path.join(__dirname, 'lib', 'stock.js'));
    });

    app.use(express.static(path.join(__dirname, 'public')));

    app.get('/api/health', (req, res) => {
        try {
            require('./database').getDb().prepare('SELECT 1').get();
            const fs = require('node:fs');
            const storage = fs.statfsSync(
                path.dirname(require('./database').getDb().name)
            );
            if (
                Number(storage.bavail) * Number(storage.bsize) <
                50 * 1024 * 1024
            )
                throw new Error('Low storage');
            res.json({ status: 'ok', timestamp: new Date().toISOString() });
        } catch (err) {
            res.status(503).json({
                status: 'unavailable',
                timestamp: new Date().toISOString()
            });
        }
    });

    app.use('/api', (req, res) => {
        res.status(404).json({ error: 'Not found' });
    });

    app.use((req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    app.use((err, req, res, next) => {
        console.error(err.stack);
        if (res.headersSent) return next(err);
        const status =
            err.type === 'entity.too.large'
                ? 413
                : err instanceof SyntaxError && err.status === 400
                  ? 400
                  : 500;
        res.status(status).json({
            error:
                status === 400
                    ? 'Invalid JSON'
                    : status === 413
                      ? 'Request is too large'
                      : 'Internal server error'
        });
    });

    return app;
}

function startServer() {
    try {
        console.log(
            `[startup] DB_PATH = ${process.env.DB_PATH || '(default ./paint_inventory.db)'}`
        );
        initializeDatabase();
        console.log('Database initialized');
        if (process.env.NODE_ENV !== 'test') {
            startBackupScheduler();
        }

        const http = require('http');
        const app = createApp();
        const server = http.createServer(app);
        if (process.env.NODE_ENV !== 'test') {
            const allowedOrigins = parseCorsOrigins(
                process.env.CORS_ORIGIN,
                process.env.NODE_ENV
            );
            initRealtime(server, allowedOrigins);
        }

        server.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
            console.log(`API available at /api`);
        });
        return server;
    } catch (err) {
        console.error(
            '[FATAL] startup failed:',
            err && err.stack ? err.stack : err
        );
        process.exit(1);
    }
}

if (require.main === module) {
    const server = startServer();
    if (server) {
        let shuttingDown = false;
        const shutdown = async (signal) => {
            if (shuttingDown) return;
            shuttingDown = true;
            console.log(`[shutdown] received ${signal}, closing server`);
            const forceExit = setTimeout(() => process.exit(1), 5000);
            forceExit.unref();
            require('./services/realtime').close();
            await require('./services/backup').stopBackupScheduler();
            server.close(() => {
                try {
                    require('./database').getDb().close();
                } catch (err) {
                    console.error('[shutdown] failed to close database:', err);
                }
                clearTimeout(forceExit);
                process.exit(0);
            });
        };
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
    }
}

module.exports = { createApp, startServer };
