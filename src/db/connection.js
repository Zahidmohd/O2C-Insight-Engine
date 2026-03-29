const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../../sap_otc.db');

const db = new Database(dbPath);

// Enable foreign keys and WAL mode for performance
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

// Async-compatible wrappers (better-sqlite3 is synchronous,
// but wrapping in Promises keeps the rest of the codebase unchanged)

db.runAsync = function (sql, params = []) {
    return Promise.resolve().then(() => this.prepare(sql).run(...params));
};

db.allAsync = function (sql, params = []) {
    return Promise.resolve().then(() => this.prepare(sql).all(...params));
};

db.getAsync = function (sql, params = []) {
    return Promise.resolve().then(() => this.prepare(sql).get(...params));
};

// exec handles multiple semicolon-separated statements (e.g., schema.sql)
db.execAsync = function (sql) {
    return Promise.resolve(this.exec(sql));
};

module.exports = db;
