const express = require('express');
const cors = require('cors');
const queryRoutes = require('./routes/queryRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Routes
app.use('/api', queryRoutes);

// Global Error Handler
app.use((err, req, res, next) => {
    console.error(`[Server Error]: ${err.stack}`);
    res.status(500).json({
        success: false,
        error: "Internal Server Error"
    });
});

app.listen(PORT, () => {
    console.log(`🚀 API Server running on http://localhost:${PORT}`);
});

module.exports = app;
