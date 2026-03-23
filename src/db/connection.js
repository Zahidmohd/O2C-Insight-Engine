const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../../sap_otc.db');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database connection:', err.message);
        process.exit(1);
    }
    
    // Enable foreign keys
    db.run('PRAGMA foreign_keys = ON;', (err) => {
        if (err) {
            console.error('Error enabling foreign keys:', err.message);
        }
    });
});

// Helper function to make db.run return a Promise
db.runAsync = function (sql, params = []) {
    return new Promise((resolve, reject) => {
        this.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
};

// Helper function to make db.all return a Promise
db.allAsync = function (sql, params = []) {
    return new Promise((resolve, reject) => {
        this.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};

// Helper function to make db.get return a Promise
db.getAsync = function (sql, params = []) {
    return new Promise((resolve, reject) => {
        this.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};

// Helper to execute multiple queries (e.g., from schema.sql)
db.execAsync = function (sql) {
    return new Promise((resolve, reject) => {
        this.exec(sql, function (err) {
            if (err) reject(err);
            else resolve();
        });
    });
};

module.exports = db;
