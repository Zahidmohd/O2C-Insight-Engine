/**
 * Turso/LibSQL database adapter.
 * Wraps @libsql/client to expose the SAME async method signatures
 * as the better-sqlite3 wrappers in connection.js.
 *
 * This allows all downstream code (sqlExecutor, vectorStore, init, loader)
 * to work with either adapter without knowing which DB backend is in use.
 */

const { createClient } = require('@libsql/client');

/**
 * Creates a Turso adapter with the same interface as connection.js.
 * @param {string} url - Turso database URL (libsql://...)
 * @param {string} authToken - Turso auth token
 * @returns {object} Adapter with allAsync, runAsync, getAsync, execAsync, batchWrite, close
 */
function createTursoAdapter(url, authToken) {
    const client = createClient({ url, authToken });

    const adapter = {
        type: 'turso',

        /**
         * Execute SELECT, return array of row objects.
         * Matches: db.allAsync(sql, params) from connection.js
         */
        async allAsync(sql, params = []) {
            const result = await client.execute({ sql, args: params });
            return result.rows;
        },

        /**
         * Execute INSERT/UPDATE/DELETE, return { lastInsertRowid, changes }.
         * Matches: db.runAsync(sql, params) from connection.js
         */
        async runAsync(sql, params = []) {
            const result = await client.execute({ sql, args: params });
            return {
                lastInsertRowid: result.lastInsertRowid,
                changes: result.rowsAffected
            };
        },

        /**
         * Execute SELECT, return single row or undefined.
         * Matches: db.getAsync(sql, params) from connection.js
         */
        async getAsync(sql, params = []) {
            const result = await client.execute({ sql, args: params });
            return result.rows[0] || undefined;
        },

        /**
         * Execute multi-statement SQL (schema creation, BEGIN/COMMIT/ROLLBACK).
         * Matches: db.execAsync(sql) from connection.js
         */
        async execAsync(sql) {
            await client.executeMultiple(sql);
        },

        /**
         * Execute a batch of write statements atomically.
         * Replaces: db.transaction(fn) from better-sqlite3
         * @param {Array<{sql: string, args?: any[]}>} statements
         */
        async batchWrite(statements) {
            await client.batch(
                statements.map(s => ({ sql: s.sql, args: s.args || [] })),
                'write'
            );
        },

        /**
         * Close the client connection.
         */
        close() {
            client.close();
        }
    };

    return adapter;
}

module.exports = { createTursoAdapter };
