const db = require('../db/connection');

/**
 * Execute validated query string returning raw rows.
 * Accepts optional params array for parameterized queries (prevents SQL injection).
 */
async function executeQuery(sql, params = []) {
    try {
        const start = process.hrtime();

        // Execute the query
        // db.allAsync was securely defined in connection.js
        const rows = await db.allAsync(sql, params);
        
        const delta = process.hrtime(start);
        const execTimeMs = (delta[0] * 1000) + (delta[1] / 1000000);

        const MAX_ROWS = 1000;
        const truncated = rows.length > MAX_ROWS;

        return {
            success: true,
            executionTimeMs: execTimeMs.toFixed(2),
            rowCount: rows.length,
            rows: truncated ? rows.slice(0, MAX_ROWS) : rows,
            truncated
        };
    } catch (error) {
        console.error('SQL Execution Error:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Synchronous version for rule-based queries (better-sqlite3 is sync internally).
 */
function executeQuerySync(sql, params = []) {
    try {
        const start = process.hrtime();
        const rows = db.prepare(sql).all(...params);
        const delta = process.hrtime(start);
        const execTimeMs = (delta[0] * 1000) + (delta[1] / 1000000);

        const MAX_ROWS = 1000;
        const truncated = rows.length > MAX_ROWS;

        return {
            success: true,
            executionTimeMs: execTimeMs.toFixed(2),
            rowCount: rows.length,
            rows: truncated ? rows.slice(0, MAX_ROWS) : rows,
            truncated
        };
    } catch (error) {
        console.error('SQL Execution Error (sync):', error.message);
        return { success: false, error: error.message };
    }
}

module.exports = {
    executeQuery,
    executeQuerySync
};
