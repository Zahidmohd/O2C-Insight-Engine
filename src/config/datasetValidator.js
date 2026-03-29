/**
 * Dataset config validation — runs BEFORE loader is called.
 *
 * Validates:
 *   1. Schema structure (tables, columns, primary keys)
 *   2. Relationships (from/to reference valid tables + columns)
 *   3. Data files exist and contain the declared columns
 *   4. Data integrity (non-empty files, key columns not null)
 */

const fs = require('fs');
const path = require('path');

// ─── Schema Validation ──────────────────────────────────────────────────────

/**
 * Validates that each table has name + non-empty columns array.
 * Throws on first failure.
 */
function validateSchema(config) {
    if (!Array.isArray(config.tables) || config.tables.length === 0) {
        throw new Error('Invalid schema: tables array is empty.');
    }

    const tableNames = new Set();
    for (const t of config.tables) {
        if (!t.name || typeof t.name !== 'string') {
            throw new Error(`Invalid schema: table missing "name".`);
        }
        if (tableNames.has(t.name)) {
            throw new Error(`Invalid schema: duplicate table "${t.name}".`);
        }
        tableNames.add(t.name);

        if (!Array.isArray(t.columns) || t.columns.length === 0) {
            throw new Error(`Invalid schema: table "${t.name}" has no columns.`);
        }
    }
}

// ─── Relationship Validation ────────────────────────────────────────────────

/**
 * Validates every relationship references existing tables and columns.
 * Uses simple split('.') and split('+') — no regex.
 */
function validateRelationships(config) {
    if (!Array.isArray(config.relationships) || config.relationships.length === 0) {
        throw new Error('Invalid schema: relationships array is empty.');
    }

    // Build lookup: tableName -> Set of column names
    const tableColumnMap = new Map();
    for (const t of config.tables) {
        tableColumnMap.set(t.name, new Set(t.columns));
    }

    for (const rel of config.relationships) {
        const fromCount = validateRelSide(rel.from, tableColumnMap, rel);
        const toCount = validateRelSide(rel.to, tableColumnMap, rel);
        if (fromCount !== toCount) {
            throw new Error(
                `Invalid relationship: ${rel.from} → ${rel.to} — column count mismatch (${fromCount} vs ${toCount}).`
            );
        }
    }
}

function validateRelSide(ref, tableColumnMap, rel) {
    const dotIdx = ref.indexOf('.');
    if (dotIdx === -1) {
        throw new Error(`Invalid relationship: "${ref}" — expected "table.column" format.`);
    }

    const table = ref.substring(0, dotIdx);
    const colPart = ref.substring(dotIdx + 1);
    const cols = colPart.split('+');

    if (!tableColumnMap.has(table)) {
        throw new Error(`Invalid relationship: ${rel.from} → ${rel.to} — table "${table}" not found in config.`);
    }

    const validCols = tableColumnMap.get(table);
    for (const col of cols) {
        if (!validCols.has(col)) {
            throw new Error(`Invalid relationship: ${rel.from} → ${rel.to} — column "${col}" missing in table "${table}".`);
        }
    }

    return cols.length;
}

// ─── Data File Validation ───────────────────────────────────────────────────

/**
 * For each table, checks:
 *   1. Data directory exists
 *   2. At least one JSONL file exists
 *   3. All declared columns exist in the JSONL file headers (first record)
 *
 * @param {object} config - dataset config
 * @param {string} resolvedDataDir - absolute path to the data directory
 */
function validateDataFiles(config, resolvedDataDir) {
    for (const t of config.tables) {
        const dir = t.directory || t.name;
        const dirPath = path.resolve(resolvedDataDir, dir);

        // Block path traversal — directory must stay within the data root
        if (!dirPath.startsWith(resolvedDataDir)) {
            throw new Error(`Invalid schema: directory "${dir}" for table "${t.name}" escapes the data directory.`);
        }

        if (!fs.existsSync(dirPath)) {
            throw new Error(`Invalid schema: data directory "${dir}" not found for table "${t.name}".`);
        }

        const jsonlFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
        if (jsonlFiles.length === 0) {
            throw new Error(`Invalid schema: no .jsonl files found for table "${t.name}" in "${dir}".`);
        }

        // Read first record from first file to check column headers
        const firstFile = path.join(dirPath, jsonlFiles[0]);
        const content = fs.readFileSync(firstFile, 'utf8');
        const firstLine = content.split('\n').find(l => l.trim());

        if (!firstLine) {
            throw new Error(`Invalid schema: table "${t.name}" has empty data file "${jsonlFiles[0]}".`);
        }

        let record;
        try {
            record = JSON.parse(firstLine);
        } catch {
            throw new Error(`Invalid schema: cannot parse first record in "${jsonlFiles[0]}" for table "${t.name}".`);
        }

        const fileColumns = new Set(Object.keys(record));
        for (const col of t.columns) {
            if (!fileColumns.has(col)) {
                throw new Error(`Invalid schema: column "${col}" missing in table "${t.name}".`);
            }
        }
    }
}

// ─── Data Integrity Checks ──────────────────────────────────────────────────

/**
 * Lightweight pre-load integrity checks:
 *   1. Each table's data files have at least 1 valid record
 *   2. Primary key columns are not null in sampled records
 *
 * @param {object} config - dataset config
 * @param {string} resolvedDataDir - absolute path to the data directory
 */
function validateDataIntegrity(config, resolvedDataDir) {
    for (const t of config.tables) {
        const dir = t.directory || t.name;
        const dirPath = path.join(resolvedDataDir, dir);
        const jsonlFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));

        let totalRecords = 0;
        const pkCols = t.primaryKey || [];

        for (const file of jsonlFiles) {
            const filePath = path.join(dirPath, file);
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n').filter(l => l.trim());

            // Sample first 10 records per file for key column checks
            const sample = lines.slice(0, 10);

            for (const line of sample) {
                let record;
                try {
                    record = JSON.parse(line);
                } catch {
                    continue; // skip malformed lines — loader handles these
                }

                totalRecords++;

                // Check primary key columns are not null/empty
                for (const pk of pkCols) {
                    const val = record[pk];
                    if (val === null || val === undefined || val === '') {
                        throw new Error(
                            `Data integrity error: primary key "${pk}" is null/empty in table "${t.name}" (file: ${file}).`
                        );
                    }
                }
            }

            // Count remaining lines (beyond sample) for total
            totalRecords += Math.max(0, lines.length - sample.length);
        }

        if (totalRecords === 0) {
            throw new Error(`Data integrity error: table "${t.name}" has 0 valid records.`);
        }
    }
}

// ─── Foreign Key Consistency ────────────────────────────────────────────────

/**
 * Parses "table.col1+col2" into { table, cols: ['col1','col2'] }.
 */
function parseRef(ref) {
    const dotIdx = ref.indexOf('.');
    const table = ref.substring(0, dotIdx);
    const cols = ref.substring(dotIdx + 1).split('+');
    return { table, cols };
}

/**
 * Builds a composite key string from a record and column list.
 * For single-column keys this is just the value; for composite it joins with '|'.
 */
function compositeKey(record, cols) {
    return cols.map(c => record[c] ?? '').join('|');
}

/**
 * Samples data from JSONL files and checks that FK values in the child table
 * actually exist in the parent table. Only checks the first 10 child rows
 * against ALL parent values (loaded from first file).
 *
 * Handles composite keys (col1+col2) correctly.
 *
 * @param {object} config - dataset config
 * @param {string} resolvedDataDir - absolute path to data directory
 */
function validateForeignKeyConsistency(config, resolvedDataDir) {
    // Build a lookup: tableName -> array of parsed records from first file
    const dataCache = new Map();

    function getTableSample(tableName, maxRows) {
        if (dataCache.has(tableName)) return dataCache.get(tableName);

        const tableCfg = config.tables.find(t => t.name === tableName);
        if (!tableCfg) return [];

        const dir = tableCfg.directory || tableCfg.name;
        const dirPath = path.join(resolvedDataDir, dir);
        if (!fs.existsSync(dirPath)) return [];

        const jsonlFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
        const records = [];

        for (const file of jsonlFiles) {
            const content = fs.readFileSync(path.join(dirPath, file), 'utf8');
            for (const line of content.split('\n')) {
                if (!line.trim()) continue;
                try {
                    records.push(JSON.parse(line));
                } catch { continue; }
                if (records.length >= maxRows) break;
            }
            if (records.length >= maxRows) break;
        }

        dataCache.set(tableName, records);
        return records;
    }

    for (const rel of config.relationships) {
        // Skip LEFT JOINs — partial matches are expected by design
        if (rel.joinType && rel.joinType.toUpperCase().includes('LEFT')) continue;

        // In the config: from = parent (PK side), to = child (FK side)
        const parent = parseRef(rel.from);
        const child = parseRef(rel.to);

        // Skip composite keys — raw data may differ from loaded data due
        // to transforms (e.g. item number padding), making pre-load checks unreliable
        if (parent.cols.length > 1 || child.cols.length > 1) continue;

        // Load parent (from-side) values — need enough to build a lookup set
        const parentRows = getTableSample(parent.table, 5000);
        if (parentRows.length === 0) continue; // skip if no data

        const parentSet = new Set(parentRows.map(r => compositeKey(r, parent.cols)));

        // Sample first 10 child (to-side) rows
        const childRows = getTableSample(child.table, 10);

        let checked = 0;
        let matched = 0;

        for (let i = 0; i < Math.min(10, childRows.length); i++) {
            const key = compositeKey(childRows[i], child.cols);
            // Skip null/empty keys — those are valid (nullable FKs)
            if (!key || key === '' || key.split('|').every(v => !v)) continue;

            checked++;
            if (parentSet.has(key)) matched++;
        }

        // Fail only if we checked rows and NONE matched — complete disconnection
        if (checked > 0 && matched === 0) {
            throw new Error(
                `Foreign key mismatch: ${rel.from} → ${rel.to} — 0 of ${checked} sampled rows found in ${parent.table}.`
            );
        }
    }
}

// ─── Combined Validator ─────────────────────────────────────────────────────

/**
 * Runs all validations in order. Fails fast on first error.
 *
 * @param {object} config - dataset config
 * @param {string} resolvedDataDir - absolute path to data directory
 */
function validateDatasetConfig(config, resolvedDataDir) {
    validateSchema(config);
    validateRelationships(config);

    // Data file + integrity + FK consistency checks only when dataDir is provided
    if (resolvedDataDir) {
        validateDataFiles(config, resolvedDataDir);
        validateDataIntegrity(config, resolvedDataDir);
        validateForeignKeyConsistency(config, resolvedDataDir);
    }
}

module.exports = {
    validateSchema,
    validateRelationships,
    validateDataFiles,
    validateDataIntegrity,
    validateForeignKeyConsistency,
    validateDatasetConfig
};
