/**
 * Turso/LibSQL database adapter.
 * Wraps @libsql/client to expose the SAME async method signatures
 * as the better-sqlite3 wrappers in connection.ts.
 *
 * This allows all downstream code (sqlExecutor, vectorStore, init, loader)
 * to work with either adapter without knowing which DB backend is in use.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createClient } = require('@libsql/client');

/**
 * Creates a Turso adapter with the same interface as connection.ts.
 */
export function createTursoAdapter(url: string, authToken: string): any {
    const client = createClient({ url, authToken });

    const adapter = {
        type: 'turso' as const,

        /**
         * Execute SELECT, return array of row objects.
         * Matches: db.allAsync(sql, params) from connection.ts
         */
        async allAsync(sql: string, params: any[] = []): Promise<any[]> {
            const result = await client.execute({ sql, args: params });
            return result.rows;
        },

        /**
         * Execute INSERT/UPDATE/DELETE, return { lastInsertRowid, changes }.
         * Matches: db.runAsync(sql, params) from connection.ts
         */
        async runAsync(sql: string, params: any[] = []): Promise<{ lastInsertRowid: any; changes: any }> {
            const result = await client.execute({ sql, args: params });
            return {
                lastInsertRowid: result.lastInsertRowid,
                changes: result.rowsAffected
            };
        },

        /**
         * Execute SELECT, return single row or undefined.
         * Matches: db.getAsync(sql, params) from connection.ts
         */
        async getAsync(sql: string, params: any[] = []): Promise<any> {
            const result = await client.execute({ sql, args: params });
            return result.rows[0] || undefined;
        },

        /**
         * Execute multi-statement SQL (schema creation, BEGIN/COMMIT/ROLLBACK).
         * Matches: db.execAsync(sql) from connection.ts
         */
        async execAsync(sql: string): Promise<void> {
            await client.executeMultiple(sql);
        },

        /**
         * Execute a batch of write statements atomically.
         * Replaces: db.transaction(fn) from better-sqlite3
         */
        async batchWrite(statements: Array<{ sql: string; args?: any[] }>): Promise<void> {
            await client.batch(
                statements.map((s: { sql: string; args?: any[] }) => ({ sql: s.sql, args: s.args || [] })),
                'write'
            );
        },

        /**
         * Close the client connection.
         */
        close(): void {
            client.close();
        }
    };

    return adapter;
}
