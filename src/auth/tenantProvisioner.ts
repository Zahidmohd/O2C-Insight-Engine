/**
 * Tenant provisioning — creates per-tenant Turso databases.
 * Extracted from authRoutes.js for use by NestJS auth service.
 */
import { getTenant, registerTenant, getDbForTenant, markInitialized } from '../db/tenantRegistry';
import { getActiveConfig, setTenantConfig } from '../config/activeDataset';
import initDB from '../db/init';
import { loadDataset } from '../db/loader';
import { initDocumentTables } from '../rag/vectorStore';

const TURSO_API_TOKEN: string | undefined = process.env.TURSO_API_TOKEN;
const TURSO_ORG_SLUG: string | undefined = process.env.TURSO_ORG_SLUG;
const JWT_SECRET: string = process.env.JWT_SECRET || 'o2c-insight-engine-secret-' + Date.now();

async function provisionTenantDb(tenantId: string): Promise<void> {
    try {
        if (getTenant(tenantId)) return;

        if (!TURSO_API_TOKEN || !TURSO_ORG_SLUG) {
            console.log(`[AUTH] No Turso credentials — tenant ${tenantId} will use global SQLite.`);
            return;
        }

        const safeTenantId: string = tenantId.toLowerCase().replace(/[^a-z0-9-]/g, '-');

        // Create or reuse Turso DB
        let hostname: string;
        const createRes = await fetch(`https://api.turso.tech/v1/organizations/${TURSO_ORG_SLUG}/databases`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${TURSO_API_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: `o2c-${safeTenantId}`, group: 'default' })
        });

        if (createRes.ok) {
            const data: any = await createRes.json();
            hostname = data.database.Hostname;
        } else {
            const infoRes = await fetch(`https://api.turso.tech/v1/organizations/${TURSO_ORG_SLUG}/databases/o2c-${safeTenantId}`, {
                headers: { 'Authorization': `Bearer ${TURSO_API_TOKEN}` }
            });
            if (infoRes.ok) {
                hostname = ((await infoRes.json()) as any).database.Hostname;
            } else {
                hostname = `o2c-${safeTenantId}-${TURSO_ORG_SLUG}.turso.io`;
            }
        }

        // Generate token
        const tokenRes = await fetch(`https://api.turso.tech/v1/organizations/${TURSO_ORG_SLUG}/databases/o2c-${safeTenantId}/auth/tokens`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${TURSO_API_TOKEN}` }
        });

        if (!tokenRes.ok) throw new Error('Token generation failed');
        const finalToken: string = ((await tokenRes.json()) as any).jwt;
        const finalUrl: string = `libsql://${hostname}`;

        registerTenant(safeTenantId, finalUrl, finalToken);

        // Check if DB already has tables
        const tenantDb: any = getDbForTenant(safeTenantId);
        const existingTables: any[] = await tenantDb.allAsync(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('documents', 'document_chunks', '_litestream_seq', '_litestream_lock')"
        );

        if (existingTables.length > 0) {
            console.log(`[AUTH] Turso DB already has ${existingTables.length} tables for tenant ${safeTenantId}, skipping init.`);
            setTenantConfig(safeTenantId, getActiveConfig());
            markInitialized(safeTenantId);
        } else {
            console.log(`[AUTH] Initializing Turso DB for tenant ${safeTenantId}...`);
            const defaultConfig: any = getActiveConfig();
            await initDocumentTables(tenantDb);
            await initDB(defaultConfig, tenantDb);
            await loadDataset(defaultConfig, tenantDb);
            setTenantConfig(safeTenantId, defaultConfig);
            markInitialized(safeTenantId);
            console.log(`[AUTH] Tenant ${safeTenantId} fully initialized.`);
        }

    } catch (err: any) {
        console.error(`[AUTH] Tenant provisioning failed for ${tenantId}:`, err.message);
    }
}

export { provisionTenantDb, JWT_SECRET };
