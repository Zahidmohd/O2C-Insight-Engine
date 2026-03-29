const fs = require('fs');
const path = require('path');
const db = require('./connection');
const { getActiveConfig } = require('../config/activeDataset');

/**
 * Generates CREATE TABLE SQL from a dataset config when no schema.sql exists.
 * All columns are TEXT (preserves leading zeros in SAP IDs).
 */
function generateSchemaFromConfig(config) {
    const statements = config.tables.map(t => {
        const colDefs = t.columns.map(c => `    "${c}" TEXT`).join(',\n');
        const pkClause = t.primaryKey && t.primaryKey.length > 0
            ? `,\n    PRIMARY KEY (${t.primaryKey.map(k => `"${k}"`).join(', ')})`
            : '';
        return `CREATE TABLE IF NOT EXISTS "${t.name}" (\n${colDefs}${pkClause}\n);`;
    });
    return statements.join('\n\n');
}

/**
 * Initializes the database schema.
 *
 * @param {object|null} config - If provided (dataset switch), drops all existing tables
 *   and generates schema from this config. If null, uses schema.sql for the default
 *   SAP O2C dataset or falls back to generating from the active config.
 */
async function initDB(config = null) {
    try {
        console.log('Initializing database schema...');

        // If a new config is provided (dataset switch), drop all existing tables first
        if (config) {
            console.log('Dropping existing tables for dataset switch...');
            const existingTables = db.prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('documents', 'document_chunks')"
            ).all();
            for (const t of existingTables) {
                db.exec(`DROP TABLE IF EXISTS "${t.name}"`);
            }
            console.log(`Dropped ${existingTables.length} tables.`);
        }

        const schemaPath = path.join(__dirname, 'schema.sql');
        let schemaSql;

        if (!config && fs.existsSync(schemaPath)) {
            // Default startup: use hand-crafted schema.sql (includes indexes, constraints)
            schemaSql = fs.readFileSync(schemaPath, 'utf8');
            console.log('Using schema.sql for database initialization.');
        } else {
            // Generate schema from provided config or active config
            const effectiveConfig = config || getActiveConfig();
            schemaSql = generateSchemaFromConfig(effectiveConfig);
            console.log(`Generated schema from config (${effectiveConfig.tables.length} tables).`);
        }

        await db.execAsync(schemaSql);

        console.log('✅ Database schema initialized successfully.');
    } catch (err) {
        console.error('❌ Error initializing schema:', err.message);
        if (!config) process.exit(1); // Only exit on startup failure, not runtime switch
        throw err;
    }
}

// If run directly
if (require.main === module) {
    initDB().then(() => {
        db.close();
    });
}

module.exports = initDB;
