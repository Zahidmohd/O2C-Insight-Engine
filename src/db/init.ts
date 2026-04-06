import fs from 'fs';
import path from 'path';
import db from './connection';
import { getActiveConfig } from '../config/activeDataset';

/**
 * Generates CREATE TABLE SQL from a dataset config when no schema.sql exists.
 * All columns are TEXT (preserves leading zeros in SAP IDs).
 */
function generateSchemaFromConfig(config: any): string {
    const statements = config.tables.map((t: any) => {
        const colDefs = t.columns.map((c: string) => `    "${c}" TEXT`).join(',\n');
        const pkClause = t.primaryKey && t.primaryKey.length > 0
            ? `,\n    PRIMARY KEY (${t.primaryKey.map((k: string) => `"${k}"`).join(', ')})`
            : '';
        return `CREATE TABLE IF NOT EXISTS "${t.name}" (\n${colDefs}${pkClause}\n);`;
    });
    return statements.join('\n\n');
}

/**
 * Initializes the database schema.
 *
 * @param config - If provided (dataset switch), drops all existing tables
 *   and generates schema from this config. If null, uses schema.sql for the default
 *   SAP O2C dataset or falls back to generating from the active config.
 * @param dbConn - Database connection (defaults to global SQLite)
 */
async function initDB(config: any = null, dbConn: any = db): Promise<void> {
    try {
        console.log('Initializing database schema...');

        // If a new config is provided (dataset switch), drop all existing tables first
        if (config) {
            console.log('Dropping existing tables for dataset switch...');
            const existingTables = await dbConn.allAsync(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('documents', 'document_chunks')"
            );
            for (const t of existingTables) {
                await dbConn.execAsync(`DROP TABLE IF EXISTS "${t.name}"`);
            }
            console.log(`Dropped ${existingTables.length} tables.`);
        }

        const schemaPath = path.join(__dirname, 'schema.sql');
        let schemaSql: string;

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

        await dbConn.execAsync(schemaSql);

        console.log('✅ Database schema initialized successfully.');
    } catch (err: any) {
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

export default initDB;

// Also assign to module.exports for backward compatibility with raw require() consumers
// (e.g., workers.ts uses `const initDB = require('../db/init')` then calls initDB() directly)
module.exports = initDB;
module.exports.default = initDB;
