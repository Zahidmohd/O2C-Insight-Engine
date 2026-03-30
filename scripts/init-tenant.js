/**
 * One-time script to initialize an existing tenant's Turso DB with schema + data.
 * Usage: node scripts/init-tenant.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createTursoAdapter } = require('../src/db/tursoAdapter');
const initDB = require('../src/db/init');
const { loadDataset } = require('../src/db/loader');
const { initDocumentTables } = require('../src/rag/vectorStore');
const { getActiveConfig, setTenantConfig } = require('../src/config/activeDataset');
const { markInitialized } = require('../src/db/tenantRegistry');

const REGISTRY_PATH = path.join(__dirname, '../data/tenants.json');

async function main() {
    const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    const tenantIds = Object.keys(registry).filter(id => !registry[id].initialized);

    if (tenantIds.length === 0) {
        console.log('All tenants already initialized.');
        return;
    }

    for (const tenantId of tenantIds) {
        const tenant = registry[tenantId];
        console.log(`\n=== Initializing tenant: ${tenantId} ===`);
        console.log(`URL: ${tenant.tursoUrl}`);

        const db = createTursoAdapter(tenant.tursoUrl, tenant.authToken);

        // Test connection
        const test = await db.getAsync('SELECT 1 as ok');
        if (!test || test.ok !== 1) {
            console.error(`Connection FAILED for ${tenantId}, skipping.`);
            db.close();
            continue;
        }
        console.log('Connection: OK');

        // Init document tables
        console.log('Creating document tables...');
        await initDocumentTables(db);

        // Init schema
        const config = getActiveConfig();
        console.log(`Creating schema (${config.tables.length} tables)...`);
        await initDB(config, db);

        // Load data
        console.log('Loading dataset...');
        const rows = await loadDataset(config, db);
        console.log(`Loaded ${rows} rows.`);

        // Set config + mark initialized
        setTenantConfig(tenantId, config);
        markInitialized(tenantId);

        // Verify
        const count = await db.getAsync('SELECT COUNT(*) as c FROM sales_order_headers');
        console.log(`Verification — sales_order_headers: ${count.c} rows`);

        db.close();
        console.log(`Tenant ${tenantId} fully initialized!`);
    }
}

main().catch(e => {
    console.error('FATAL:', e.message);
    process.exit(1);
});
