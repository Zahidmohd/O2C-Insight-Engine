/**
 * One-time script to initialize an existing tenant's Turso DB with schema + data.
 * Usage: npx ts-node scripts/init-tenant.ts
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { createTursoAdapter } from '../src/db/tursoAdapter';
import initDB from '../src/db/init';
import { loadDataset } from '../src/db/loader';
import { initDocumentTables } from '../src/rag/vectorStore';
import { getActiveConfig, setTenantConfig } from '../src/config/activeDataset';
import { markInitialized } from '../src/db/tenantRegistry';

const REGISTRY_PATH: string = path.join(__dirname, '../data/tenants.json');

async function main(): Promise<void> {
    const registry: Record<string, any> = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    const tenantIds: string[] = Object.keys(registry).filter((id: string) => !registry[id].initialized);

    if (tenantIds.length === 0) {
        console.log('All tenants already initialized.');
        return;
    }

    for (const tenantId of tenantIds) {
        const tenant: any = registry[tenantId];
        console.log(`\n=== Initializing tenant: ${tenantId} ===`);
        console.log(`URL: ${tenant.tursoUrl}`);

        const db: any = createTursoAdapter(tenant.tursoUrl, tenant.authToken);

        // Test connection
        const test: any = await db.getAsync('SELECT 1 as ok');
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
        const config: any = getActiveConfig();
        console.log(`Creating schema (${config.tables.length} tables)...`);
        await initDB(config, db);

        // Load data
        console.log('Loading dataset...');
        const rows: number = await loadDataset(config, db);
        console.log(`Loaded ${rows} rows.`);

        // Set config + mark initialized
        setTenantConfig(tenantId, config);
        markInitialized(tenantId);

        // Verify
        const count: any = await db.getAsync('SELECT COUNT(*) as c FROM sales_order_headers');
        console.log(`Verification — sales_order_headers: ${count.c} rows`);

        db.close();
        console.log(`Tenant ${tenantId} fully initialized!`);
    }
}

main().catch((e: Error) => {
    console.error('FATAL:', e.message);
    process.exit(1);
});
