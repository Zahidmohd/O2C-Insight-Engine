/**
 * Global active dataset state.
 *
 * Holds a mutable reference to the currently active dataset config.
 * All consumers read from getActiveConfig() instead of importing datasetConfig directly.
 * This allows runtime dataset switching via setActiveConfig().
 *
 * Default: SAP O2C config from datasetConfig.js.
 */

const { datasetConfig: defaultConfig } = require('./datasetConfig');

let activeConfig = defaultConfig;

function getActiveConfig() {
    return activeConfig;
}

function setActiveConfig(config) {
    activeConfig = config;
    console.log(`[DATASET] Active dataset switched to: ${config.name || 'unnamed'}`);
}

module.exports = { getActiveConfig, setActiveConfig, defaultConfig };
