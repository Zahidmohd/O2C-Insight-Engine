/**
 * Tenant management API routes.
 * Handles creation, listing, and deletion of tenants via Turso Platform API.
 */

const express = require('express');
const router = express.Router();
const { getTenant, registerTenant, removeTenant, listTenants, getDbForTenant, markInitialized } = require('../db/tenantRegistry');
const initDB = require('../db/init');
const { loadDataset } = require('../db/loader');
const { initDocumentTables } = require('../rag/vectorStore');
const { getActiveConfig, setTenantConfig } = require('../config/activeDataset');

const TURSO_API_TOKEN = process.env.TURSO_API_TOKEN;
const TURSO_ORG_SLUG = process.env.TURSO_ORG_SLUG;

// ─── Create Tenant ───────────────────────────────────────────────────────────

router.post('/tenants', async (req, res) => {
    try {
        const { tenantId, tursoUrl, authToken } = req.body;

        if (!tenantId || typeof tenantId !== 'string' || tenantId.trim().length < 3) {
            return res.status(400).json({
                success: false,
                error: { message: 'tenantId is required (min 3 characters).', type: 'VALIDATION_ERROR' }
            });
        }

        const safeTenantId = tenantId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

        if (getTenant(safeTenantId)) {
            return res.status(409).json({
                success: false,
                error: { message: `Tenant '${safeTenantId}' already exists.`, type: 'CONFLICT' }
            });
        }

        let finalUrl = tursoUrl;
        let finalToken = authToken;

        // Auto-provision via Turso Platform API if no URL provided
        if (!finalUrl) {
            if (!TURSO_API_TOKEN || !TURSO_ORG_SLUG) {
                return res.status(400).json({
                    success: false,
                    error: { message: 'Turso credentials not configured. Provide tursoUrl + authToken manually, or set TURSO_API_TOKEN and TURSO_ORG_SLUG env vars.', type: 'CONFIG_ERROR' }
                });
            }

            console.log(`[TENANT] Auto-provisioning Turso DB for tenant: ${safeTenantId}...`);

            // Create database
            const createRes = await fetch(`https://api.turso.tech/v1/organizations/${TURSO_ORG_SLUG}/databases`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${TURSO_API_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ name: `o2c-${safeTenantId}`, group: 'default' })
            });

            if (createRes.ok) {
                const createData = await createRes.json();
                finalUrl = `libsql://${createData.database.Hostname}`;
            } else if (createRes.status === 409 || createRes.status === 422) {
                // DB already exists (previous deploy) — look up its hostname and reuse
                console.log(`[TENANT] Turso DB already exists for tenant: ${safeTenantId}, reusing.`);
                try {
                    const infoRes = await fetch(`https://api.turso.tech/v1/organizations/${TURSO_ORG_SLUG}/databases/o2c-${safeTenantId}`, {
                        headers: { 'Authorization': `Bearer ${TURSO_API_TOKEN}` }
                    });
                    if (infoRes.ok) {
                        const infoData = await infoRes.json();
                        finalUrl = `libsql://${infoData.database.Hostname}`;
                    } else {
                        finalUrl = `libsql://o2c-${safeTenantId}-${TURSO_ORG_SLUG}.turso.io`;
                    }
                } catch {
                    finalUrl = `libsql://o2c-${safeTenantId}-${TURSO_ORG_SLUG}.turso.io`;
                }
            } else {
                const err = await createRes.text();
                console.error(`[TENANT] Turso DB creation failed (${createRes.status}): ${err}`);
                return res.status(500).json({
                    success: false,
                    error: { message: `Turso DB creation failed: ${err}`, type: 'TURSO_ERROR' }
                });
            }

            // Generate auth token
            const tokenRes = await fetch(`https://api.turso.tech/v1/organizations/${TURSO_ORG_SLUG}/databases/o2c-${safeTenantId}/auth/tokens`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${TURSO_API_TOKEN}` }
            });

            if (!tokenRes.ok) {
                const err = await tokenRes.text();
                return res.status(500).json({
                    success: false,
                    error: { message: `Turso token generation failed: ${err}`, type: 'TURSO_ERROR' }
                });
            }

            const tokenData = await tokenRes.json();
            finalToken = tokenData.jwt;

            console.log(`[TENANT] Turso DB provisioned: ${finalUrl}`);
        }

        // Register tenant immediately
        registerTenant(safeTenantId, finalUrl, finalToken);

        // Respond immediately — user can start querying (falls back to global DB)
        res.status(201).json({
            success: true,
            tenantId: safeTenantId,
            tursoUrl: finalUrl,
            message: `Tenant '${safeTenantId}' created. Database initializing in background — queries work immediately via shared dataset.`
        });

        // Initialize tenant DB in background (non-blocking)
        (async () => {
            try {
                const tenantDb = getDbForTenant(safeTenantId);

                // Check if Turso DB already has tables (from a previous deploy)
                const existingTables = await tenantDb.allAsync(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('documents', 'document_chunks', '_litestream_seq', '_litestream_lock')"
                );

                if (existingTables.length > 0) {
                    // DB already has data — just mark as initialized, don't overwrite
                    console.log(`[TENANT] Turso DB already has ${existingTables.length} tables, skipping init for: ${safeTenantId}`);
                    setTenantConfig(safeTenantId, getActiveConfig());
                    markInitialized(safeTenantId);
                } else {
                    // Fresh DB — load default dataset
                    console.log(`[TENANT] Background init starting for: ${safeTenantId}...`);
                    const defaultConfig = getActiveConfig();

                    await initDocumentTables(tenantDb);
                    await initDB(defaultConfig, tenantDb);
                    await loadDataset(defaultConfig, tenantDb);
                    setTenantConfig(safeTenantId, defaultConfig);
                    markInitialized(safeTenantId);

                    console.log(`[TENANT] Background init complete for: ${safeTenantId}`);
                }
            } catch (initErr) {
                console.error(`[TENANT] Background init failed for ${safeTenantId}:`, initErr.message);
            }
        })();

        return;

    } catch (err) {
        console.error('[TENANT] Creation error:', err.message);
        return res.status(500).json({
            success: false,
            error: { message: `Tenant creation failed: ${err.message}`, type: 'API_ERROR' }
        });
    }
});

// ─── List Tenants ────────────────────────────────────────────────────────────

router.get('/tenants', (req, res) => {
    const tenants = listTenants().map(t => ({
        id: t.id,
        configName: t.configName,
        initialized: t.initialized,
        createdAt: t.createdAt
    }));
    return res.status(200).json({ success: true, tenants });
});

// ─── Delete Tenant ───────────────────────────────────────────────────────────

router.delete('/tenants/:id', async (req, res) => {
    try {
        const tenantId = req.params.id;
        const tenant = getTenant(tenantId);

        if (!tenant) {
            return res.status(404).json({
                success: false,
                error: { message: `Tenant '${tenantId}' not found.`, type: 'NOT_FOUND' }
            });
        }

        // Optionally destroy Turso DB via API
        if (TURSO_API_TOKEN && TURSO_ORG_SLUG) {
            try {
                await fetch(`https://api.turso.tech/v1/organizations/${TURSO_ORG_SLUG}/databases/o2c-${tenantId}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${TURSO_API_TOKEN}` }
                });
                console.log(`[TENANT] Turso DB destroyed for tenant: ${tenantId}`);
            } catch (tursoErr) {
                console.warn(`[TENANT] Failed to destroy Turso DB: ${tursoErr.message}`);
            }
        }

        removeTenant(tenantId);

        return res.status(200).json({
            success: true,
            message: `Tenant '${tenantId}' deleted.`
        });

    } catch (err) {
        console.error('[TENANT] Deletion error:', err.message);
        return res.status(500).json({
            success: false,
            error: { message: `Tenant deletion failed: ${err.message}`, type: 'API_ERROR' }
        });
    }
});

module.exports = router;
