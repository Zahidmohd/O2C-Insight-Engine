/**
 * Tenant registry — maps tenant IDs to Turso database credentials.
 * Persists to data/tenants.json. Caches Turso adapter instances in memory.
 */

import fs from 'fs';
import path from 'path';
import { createTursoAdapter } from './tursoAdapter';

const REGISTRY_PATH = path.join(__dirname, '../../data/tenants.json');

// In-memory cache of tenant records
let registry: Record<string, any> = {};

// Connection pool — reuses Turso adapters per tenant
const clientPool: Map<string, any> = new Map();

// ─── Registry I/O ────────────────────────────────────────────────────────────

function loadRegistry(): Record<string, any> {
    try {
        if (fs.existsSync(REGISTRY_PATH)) {
            registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
        }
    } catch (err: any) {
        console.warn('[TENANT] Failed to load registry, starting fresh:', err.message);
        registry = {};
    }
    return registry;
}

function saveRegistry(): void {
    try {
        const dir = path.dirname(REGISTRY_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf8');
    } catch (err: any) {
        console.error('[TENANT] Failed to save registry:', err.message);
    }
}

// ─── Tenant CRUD ─────────────────────────────────────────────────────────────

function getTenant(tenantId: string): any | null {
    return registry[tenantId] || null;
}

function registerTenant(tenantId: string, tursoUrl: string, authToken: string, configName: string = 'sap_o2c'): any {
    registry[tenantId] = {
        tursoUrl,
        authToken,
        configName,
        initialized: false,
        createdAt: new Date().toISOString()
    };
    saveRegistry();
    console.log(`[TENANT] Registered tenant: ${tenantId}`);
    return registry[tenantId];
}

function markInitialized(tenantId: string): void {
    if (registry[tenantId]) {
        registry[tenantId].initialized = true;
        saveRegistry();
    }
}

function removeTenant(tenantId: string): void {
    // Close cached connection
    if (clientPool.has(tenantId)) {
        clientPool.get(tenantId).close();
        clientPool.delete(tenantId);
    }
    delete registry[tenantId];
    saveRegistry();
    console.log(`[TENANT] Removed tenant: ${tenantId}`);
}

function listTenants(): Array<{ id: string; [key: string]: any }> {
    return Object.keys(registry).map(id => ({
        id,
        ...registry[id]
    }));
}

// ─── Connection Pool ─────────────────────────────────────────────────────────

function getDbForTenant(tenantId: string): any | null {
    // Return cached adapter if exists
    if (clientPool.has(tenantId)) {
        return clientPool.get(tenantId);
    }

    const tenant = registry[tenantId];
    if (!tenant) return null;

    // Create and cache new adapter
    const adapter = createTursoAdapter(tenant.tursoUrl, tenant.authToken);
    clientPool.set(tenantId, adapter);
    return adapter;
}

// Load registry on module init
loadRegistry();

export {
    loadRegistry,
    getTenant,
    registerTenant,
    markInitialized,
    removeTenant,
    listTenants,
    getDbForTenant
};
