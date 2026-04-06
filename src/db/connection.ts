import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(__dirname, '../../sap_otc.db');

const db: any = new Database(dbPath);

// Enable foreign keys and WAL mode for performance
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

// Async-compatible wrappers (better-sqlite3 is synchronous,
// but wrapping in Promises keeps the rest of the codebase unchanged)

db.runAsync = function (sql: string, params: any[] = []): Promise<any> {
    return Promise.resolve().then(() => this.prepare(sql).run(...params));
};

db.allAsync = function (sql: string, params: any[] = []): Promise<any[]> {
    return Promise.resolve().then(() => this.prepare(sql).all(...params));
};

db.getAsync = function (sql: string, params: any[] = []): Promise<any> {
    return Promise.resolve().then(() => this.prepare(sql).get(...params));
};

// exec handles multiple semicolon-separated statements (e.g., schema.sql)
db.execAsync = function (sql: string): Promise<void> {
    return Promise.resolve(this.exec(sql));
};

// Batch write — atomic execution of multiple statements (matches Turso adapter API)
db.batchWrite = function (statements: Array<{ sql: string; args?: any[] }>): Promise<void> {
    const txn = this.transaction((stmts: Array<{ sql: string; args?: any[] }>) => {
        for (const s of stmts) {
            this.prepare(s.sql).run(...(s.args || []));
        }
    });
    return Promise.resolve(txn(statements));
};

db.type = 'sqlite';

export default db;

// Also assign to module.exports for backward compatibility with raw require() consumers
// (e.g., database.service.ts, vectorStore.ts, workers.ts use require() at runtime)
module.exports = db;
module.exports.default = db;
