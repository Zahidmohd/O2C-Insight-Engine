const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const queryRoutes = require('./routes/queryRoutes');
const documentRoutes = require('./routes/documentRoutes');
const tenantRoutes = require('./routes/tenantRoutes');
const authRoutes = require('./auth/authRoutes');
const authMiddleware = require('./auth/authMiddleware');
const tenantResolver = require('./middleware/tenantResolver');
const db = require('./db/connection');
const { initDocumentTables } = require('./rag/vectorStore');
const { initAuthDb } = require('./auth/authDb');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust first proxy (Render, nginx, etc.) so req.ip returns real client IP
app.set('trust proxy', 1);

// Security headers
app.use(helmet({ contentSecurityPolicy: false }));

// CORS — whitelist specific origins
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
        : ['http://localhost:3000', 'http://localhost:5173'],
    methods: ['GET', 'POST', 'DELETE'],
}));

app.use(express.json());

// Serve frontend static files with cache headers
const frontendDist = path.join(__dirname, '../frontend/dist');
app.use(express.static(frontendDist, { maxAge: '1d' }));

// Request logging middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Auth middleware (JWT verification — exempt routes skip auth)
app.use(authMiddleware(authRoutes.JWT_SECRET));

// Tenant resolution (attaches req.db, req.tenantId, req.config)
app.use(tenantResolver);

// Routes
app.use('/api', authRoutes);
app.use('/api', tenantRoutes);
app.use('/api', queryRoutes);
app.use('/api', documentRoutes);

// SPA catch-all — serve index.html for any non-API route
app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error(`[Server Error]: ${err.stack}`);
    res.status(500).json({
        success: false,
        error: "Internal Server Error"
    });
});

// Async startup
(async () => {
    await initAuthDb();
    await initDocumentTables();
    const server = app.listen(PORT, () => {
        console.log(`🚀 API Server running on http://localhost:${PORT}`);
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`❌ Port ${PORT} is already in use. Kill the existing process or use a different port.`);
            console.error(`   Run: npx kill-port ${PORT}`);
        } else {
            console.error('❌ Server error:', err.message);
        }
        process.exit(1);
    });

    function shutdown(signal) {
        console.log(`\n${signal} received. Shutting down gracefully...`);
        server.close(() => {
            db.close();
            console.log('Server closed.');
            process.exit(0);
        });
        setTimeout(() => {
            console.error('Forced shutdown after timeout.');
            process.exit(1);
        }, 10000).unref();
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
})();

module.exports = app;
