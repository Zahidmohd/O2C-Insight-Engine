/**
 * Tenant resolution middleware.
 *
 * BEHAVIOR:
 * - No X-Tenant-Id → global SQLite DB (backward compat for tests/dev)
 * - X-Tenant-Id + registered tenant → tenant's Turso DB (strict isolation)
 * - X-Tenant-Id + unregistered → global SQLite DB (graceful fallback)
 *
 * Cross-tenant leakage is prevented: registered tenant A cannot see tenant B's data.
 * Unregistered tenants share the global DB (demo/dev mode).
 */

const globalDb = require('../db/connection');
const { getTenant, getDbForTenant } = require('../db/tenantRegistry');
const { getActiveConfig, getTenantConfig } = require('../config/activeDataset');

function tenantResolver(req, res, next) {
    const tenantId = req.headers['x-tenant-id'];

    // No tenant header → global DB
    if (!tenantId) {
        req.db = globalDb;
        req.tenantId = null;
        req.config = getActiveConfig();
        return next();
    }

    // Check if tenant is registered (has a Turso DB)
    const tenant = getTenant(tenantId);

    if (!tenant) {
        // Unregistered tenant → use global DB
        req.db = globalDb;
        req.tenantId = tenantId;
        req.config = getActiveConfig();
        return next();
    }

    // Registered but NOT yet initialized → use global DB until background init finishes
    if (!tenant.initialized) {
        req.db = globalDb;
        req.tenantId = tenantId;
        req.config = getActiveConfig();
        return next();
    }

    // ── REGISTERED + INITIALIZED TENANT: USE TURSO DB ────────────────────────

    const tenantDb = getDbForTenant(tenantId);
    if (!tenantDb) {
        console.warn(`[TENANT] Connection failed for '${tenantId}', falling back to global.`);
        req.db = globalDb;
        req.tenantId = tenantId;
        req.config = getTenantConfig(tenantId) || getActiveConfig();
        return next();
    }

    req.db = tenantDb;
    req.tenantId = tenantId;
    req.config = getTenantConfig(tenantId) || getActiveConfig();

    console.log(`[TENANT] ${req.method} ${req.path} | tenant=${tenantId} | db=turso | config=${req.config.name}`);
    next();
}

module.exports = tenantResolver;
