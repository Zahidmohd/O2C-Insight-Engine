/**
 * Global active dataset state.
 *
 * Holds a mutable reference to the currently active dataset config.
 * All consumers read from getActiveConfig() instead of importing datasetConfig directly.
 * This allows runtime dataset switching via setActiveConfig().
 *
 * Default: SAP O2C config from datasetConfig.js.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { datasetConfig: importedDefaultConfig } = require('./datasetConfig');

const defaultConfig: any = importedDefaultConfig;

let activeConfig: any = defaultConfig;

function getActiveConfig(): any {
    return activeConfig;
}

function setActiveConfig(config: any): void {
    activeConfig = config;
    console.log(`[DATASET] Active dataset switched to: ${config.name || 'unnamed'}`);
}

// --- Per-Tenant Config Storage -----------------------------------------------

const tenantConfigs: Map<string, any> = new Map();

function getTenantConfig(tenantId: string): any | null {
    return tenantConfigs.get(tenantId) || null;
}

function setTenantConfig(tenantId: string, config: any): void {
    tenantConfigs.set(tenantId, config);
    console.log(`[DATASET] Tenant ${tenantId} config set to: ${config.name || 'unnamed'}`);
}

export { getActiveConfig, setActiveConfig, defaultConfig, getTenantConfig, setTenantConfig };
