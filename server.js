require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { initializeDatabase } = require('./database');
const { startBackupScheduler } = require('./services/backup');
const { init: initRealtime } = require('./services/realtime');

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

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1000, message: { error: 'Too many requests, please try again later' } });
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

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// JSON 404 for unknown API routes
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// SPA fallback for non-API routes
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Internal server error' });
});

function startServer() {
    initializeDatabase();
    console.log('Database initialized');
    startBackupScheduler();

    const http = require('http');
    const server = http.createServer(app);
    initRealtime(server);

    server.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
        console.log(`API available at http://localhost:${PORT}/api`);
    });
}

startServer();