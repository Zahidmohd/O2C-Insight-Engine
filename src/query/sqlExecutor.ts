import db from '../db/connection';

/**
 * Execute validated query string returning raw rows.
 * Accepts optional params array for parameterized queries (prevents SQL injection).
 */
async function executeQuery(sql: string, params: any[] = [], dbConn: any = db): Promise<any> {
    try {
        const start = process.hrtime();

        // Execute the query
        const rows = await dbConn.allAsync(sql, params);

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
    } catch (error: any) {
        console.error('SQL Execution Error:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Direct query execution (previously sync, now async for Turso compatibility).
 * Used by rule-based queries in queryService.
 */
async function executeQueryDirect(sql: string, params: any[] = [], dbConn: any = db): Promise<any> {
    try {
        const start = process.hrtime();
        const rows = await dbConn.allAsync(sql, params);
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
    } catch (error: any) {
        console.error('SQL Execution Error (direct):', error.message);
        return { success: false, error: error.message };
    }
}

export {
    executeQuery,
    executeQueryDirect,
    // Backward compat alias
    executeQueryDirect as executeQuerySync
};
