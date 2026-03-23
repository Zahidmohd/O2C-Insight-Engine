const fs = require('fs');
const path = require('path');
const db = require('./connection');

async function initDB() {
    try {
        console.log('Initializing database schema...');
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schemaSql = fs.readFileSync(schemaPath, 'utf8');

        // execute all statements
        await db.execAsync(schemaSql);

        console.log('✅ Database schema initialized successfully.');
    } catch (err) {
        console.error('❌ Error initializing schema:', err.message);
        process.exit(1);
    }
}

// If run directly
if (require.main === module) {
    initDB().then(() => {
        db.close();
    });
}

module.exports = initDB;
