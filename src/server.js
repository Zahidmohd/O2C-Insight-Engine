const express = require('express');
const cors = require('cors');
const path = require('path');
const queryRoutes = require('./routes/queryRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve frontend static files in production
const frontendDist = path.join(__dirname, '../frontend/dist');
app.use(express.static(frontendDist));

// Request logging middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Routes
app.use('/api', queryRoutes);

// SPA catch-all — serve index.html for any non-API route
app.get('*', (req, res) => {
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

module.exports = app;
