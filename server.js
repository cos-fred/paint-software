require('dotenv').config();

process.on('uncaughtException', (err) => {
    console.error('[FATAL] uncaughtException:', err && err.stack ? err.stack : err);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] unhandledRejection:', reason);
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

    const allowedOrigins = parseCorsOrigins(process.env.CORS_ORIGIN, process.env.NODE_ENV);

    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", "data:"],
                connectSrc: ["'self'", "ws:", "wss:"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                frameAncestors: ["'none'"]
            }
        }
    }));
    app.use(cors({ origin: corsOriginOption(allowedOrigins), credentials: true }));
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ extended: true }));

    const limiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 1000,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many requests, please try again later' }
    });
    app.use('/api/', limiter);

    app.use('/api/auth', authRoutes);
    app.use('/api/products', productRoutes);
    app.use('/api/customers', customerRoutes);
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

    app.use(express.static(path.join(__dirname, 'public')));

    app.get('/api/health', (req, res) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
        res.status(500).json({ error: 'Internal server error' });
    });

    return app;
}

function startServer() {
    try {
        console.log(`[startup] DB_PATH = ${process.env.DB_PATH || '(default ./paint_inventory.db)'}`);
        initializeDatabase();
        console.log('Database initialized');
        if (process.env.NODE_ENV !== 'test') {
            startBackupScheduler();
        }

        const http = require('http');
        const app = createApp();
        const server = http.createServer(app);
        if (process.env.NODE_ENV !== 'test') {
            const allowedOrigins = parseCorsOrigins(process.env.CORS_ORIGIN, process.env.NODE_ENV);
            initRealtime(server, allowedOrigins);
        }

        server.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
            console.log(`API available at /api`);
        });
        return server;
    } catch (err) {
        console.error('[FATAL] startup failed:', err && err.stack ? err.stack : err);
        process.exit(1);
    }
}

if (require.main === module) {
    startServer();
}

module.exports = { createApp, startServer };
