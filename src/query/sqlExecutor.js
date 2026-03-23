const db = require('../db/connection');

/**
 * Execute validated query string returning raw rows.
 */
async function executeQuery(sql) {
    try {
        const start = process.hrtime();
        
        // Execute the query
        // db.allAsync was securely defined in connection.js
        const rows = await db.allAsync(sql, []);
        
        const delta = process.hrtime(start);
        const execTimeMs = (delta[0] * 1000) + (delta[1] / 1000000);

        return {
            success: true,
            executionTimeMs: execTimeMs.toFixed(2),
            rowCount: rows.length,
            rows: rows
        };
    } catch (error) {
        console.error('SQL Execution Error:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

module.exports = {
    executeQuery
};
