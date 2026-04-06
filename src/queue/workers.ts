/**
 * BullMQ Workers — background job processors.
 *
 * Workers:
 *   - dataset-processing: loads CSV/JSONL into tenant DB, generates KB
 *   - embedding-generation: chunks documents + generates HuggingFace embeddings
 *   - tenant-provisioning: creates isolated Turso database for new tenant
 *
 * All workers use exponential backoff retries (1s → 2s → 4s).
 * Dead letter queue captures jobs that exhaust all retries.
 */
import { registerWorker } from './queueManager';
import type { Job } from 'bullmq';

/**
 * Initialize all workers. Call once at server startup.
 * Workers only start if Redis is connected.
 */
function initWorkers(): void {

    // ─── Dataset Processing Worker ──────────────────────────────────────
    registerWorker('dataset-processing', async (job: Job) => {
        const { config, tenantId, dbUrl, authToken } = job.data;
        console.log(`[Worker:dataset] Processing dataset for tenant ${tenantId}`);

        const initDB = require('../db/init');
        const { loadDataset } = require('../db/loader');
        const { createTursoAdapter } = require('../db/tursoAdapter');
        const { clearTenantCache } = require('../cache/queryCache');

        const dbConn = createTursoAdapter(dbUrl, authToken);
        await initDB(config, dbConn);
        const totalRows = await loadDataset(config, dbConn);

        // Clear stale cache for this tenant after new data loads
        await clearTenantCache(tenantId);

        console.log(`[Worker:dataset] Loaded ${totalRows} rows for tenant ${tenantId}`);
        return { totalRows, tenantId };
    }, { concurrency: 2 });

    // ─── Embedding Generation Worker ────────────────────────────────────
    registerWorker('embedding-generation', async (job: Job) => {
        const { tenantId, documentId, chunks, dbUrl, authToken } = job.data;
        console.log(`[Worker:embedding] Generating embeddings for ${chunks?.length || 0} chunks (tenant: ${tenantId})`);

        const { generateEmbeddings } = require('../rag/embeddingService');
        const { storeEmbeddings } = require('../rag/vectorStore');
        const { createTursoAdapter } = require('../db/tursoAdapter');

        const dbConn = createTursoAdapter(dbUrl, authToken);
        const embeddings = await generateEmbeddings(chunks.map((c: any) => c.text));

        await storeEmbeddings(dbConn, chunks, embeddings, documentId);

        console.log(`[Worker:embedding] Stored ${embeddings.length} embeddings for tenant ${tenantId}`);
        return { embeddingCount: embeddings.length, tenantId };
    }, { concurrency: 1 });  // Lower concurrency — CPU heavy

    // ─── Tenant Provisioning Worker ─────────────────────────────────────
    registerWorker('tenant-provisioning', async (job: Job) => {
        const { tenantId, tursoUrl, authToken, configName } = job.data;
        console.log(`[Worker:tenant] Provisioning tenant ${tenantId}`);

        const { registerTenant } = require('../db/tenantRegistry');
        registerTenant(tenantId, tursoUrl, authToken, configName);

        console.log(`[Worker:tenant] Tenant ${tenantId} provisioned`);
        return { tenantId, status: 'provisioned' };
    }, { concurrency: 3 });

    console.log('[BullMQ] All workers initialized');
}

export { initWorkers };
