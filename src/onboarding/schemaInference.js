/**
 * Deterministic schema inference from uploaded JSONL/CSV files.
 * No LLM — pure structural analysis of file content.
 *
 * inferSchema(files) → { tables: [{name, displayName, columns, primaryKey, recordCount}] }
 */

const { parse } = require('csv-parse/sync');

// ─── Format Detection ──────────────────────────────────────────────────────

/**
 * Detects file format by attempting JSON parse on the first non-empty line.
 * @param {string} content - Raw file content
 * @returns {'jsonl' | 'csv'}
 */
function detectFormat(content) {
    const firstLine = content.split('\n').find(l => l.trim());
    if (!firstLine) return 'csv'; // empty file fallback

    try {
        const parsed = JSON.parse(firstLine.trim());
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return 'jsonl';
        }
    } catch {
        // Not JSON — treat as CSV
    }
    return 'csv';
}

// ─── File Parsing ──────────────────────────────────────────────────────────

/**
 * Parses file content into an array of record objects.
 * @param {string} content - Raw file content
 * @param {'jsonl' | 'csv'} format
 * @returns {object[]}
 */
function parseFile(content, format) {
    if (format === 'jsonl') {
        return parseJSONL(content);
    }
    return parseCSV(content);
}

function parseJSONL(content) {
    const records = [];
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const record = JSON.parse(trimmed);
            if (record && typeof record === 'object') {
                records.push(record);
            }
        } catch {
            // Skip malformed lines
        }
    }
    return records;
}

function parseCSV(content) {
    try {
        return parse(content, {
            columns: true,       // Use first row as headers
            skip_empty_lines: true,
            trim: true,
            relax_column_count: true
        });
    } catch (err) {
        throw new Error(`CSV parse error: ${err.message}`);
    }
}

// ─── Table Name Inference ──────────────────────────────────────────────────

/**
 * Infers a clean table name from the original filename.
 * "SalesOrderHeaders.jsonl" → "sales_order_headers"
 * "my-data-file.csv" → "my_data_file"
 * @param {string} filename
 * @returns {string}
 */
function inferTableName(filename) {
    // Strip extension
    let name = filename.replace(/\.(jsonl|csv|json)$/i, '');

    // Convert camelCase/PascalCase to snake_case
    name = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');

    // Replace hyphens, spaces, dots with underscores
    name = name.replace(/[-.\s]+/g, '_');

    // Lowercase and clean up multiple underscores
    name = name.toLowerCase().replace(/_+/g, '_').replace(/^_|_$/g, '');

    return name || 'unnamed_table';
}

// ─── Column Inference ──────────────────────────────────────────────────────

/**
 * Infers column names from the first record's keys.
 * Merges keys from the first few records to handle sparse data.
 * @param {object[]} records
 * @returns {string[]}
 */
function inferColumns(records) {
    if (records.length === 0) return [];

    const columnSet = new Set();
    // Sample first 10 records to catch all columns (some records may have sparse fields)
    const sample = records.slice(0, 10);
    for (const record of sample) {
        for (const key of Object.keys(record)) {
            columnSet.add(key);
        }
    }
    return Array.from(columnSet);
}

// ─── Primary Key Detection ─────────────────────────────────────────────────

/** Suffixes that suggest a column is an identifier */
const ID_SUFFIXES = ['id', '_id', 'key', 'code', 'number', 'no', 'num', 'ref', 'document', 'order', 'partner'];

/** Substrings that indicate a datetime/timestamp column — rarely a real PK */
const DATETIME_HINTS = ['date', 'time', 'timestamp', 'created', 'modified', 'changed', 'updated'];

/**
 * Detects primary key candidates: columns where all sampled values are unique and non-null.
 * Priority: ID-suffix columns (0) > regular columns (1) > datetime columns (2).
 * @param {object[]} records
 * @param {string[]} columns
 * @param {number} sampleSize
 * @returns {string[]} Best PK candidate(s) — single column preferred
 */
function detectPrimaryKeyCandidates(records, columns, sampleSize = 500) {
    const sample = records.slice(0, sampleSize);
    if (sample.length === 0) return [];

    const candidates = [];

    for (const col of columns) {
        const values = sample.map(r => r[col]).filter(v => v !== null && v !== undefined && v !== '');

        // Skip if too many nulls (>10% of sample)
        if (values.length < sample.length * 0.9) continue;

        const uniqueValues = new Set(values.map(v => String(v)));

        const lowerCol = col.toLowerCase();
        const hasIdSuffix = ID_SUFFIXES.some(s => lowerCol.endsWith(s));
        const isDatetime = DATETIME_HINTS.some(h => lowerCol.includes(h));
        const uniquenessRatio = uniqueValues.size / values.length;

        // For ID-suffix columns: accept 95%+ uniqueness (merged partitions may have overlapping rows)
        // For other columns: require 100% uniqueness
        const threshold = hasIdSuffix ? 0.95 : 1.0;

        if (uniquenessRatio >= threshold) {
            let priority;
            if (hasIdSuffix) priority = 0;
            else if (isDatetime) priority = 2;
            else priority = 1;

            candidates.push({ col, priority });
        }
    }

    // Sort: ID-suffix first, then regular, then datetime; within same priority: alphabetical
    candidates.sort((a, b) => a.priority - b.priority || a.col.localeCompare(b.col));

    // Return best single-column candidate
    if (candidates.length > 0) {
        return [candidates[0].col];
    }

    return [];
}

// ─── Display Name Generation ───────────────────────────────────────────────

/**
 * Generates a human-readable display name from a snake_case table name.
 * "sales_order_headers" → "Sales Order Header"
 * @param {string} tableName
 * @returns {string}
 */
function generateDisplayName(tableName) {
    return tableName
        .split('_')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')
        // Remove trailing 's' for singular form
        .replace(/s$/, '');
}

// ─── Records to JSONL ──────────────────────────────────────────────────────

/**
 * Converts records array to JSONL string for writing to disk.
 * @param {object[]} records
 * @returns {string}
 */
function recordsToJSONL(records) {
    return records.map(r => JSON.stringify(r)).join('\n');
}

// ─── Main Entry Point ──────────────────────────────────────────────────────

/**
 * Infers full schema for a set of uploaded files.
 * @param {Array<{filename: string, content: string}>} files
 * @returns {{ tables: Array<{name, displayName, columns, primaryKey, recordCount, records}> }}
 */
/**
 * Strips partition suffixes from table names so split files merge into one table.
 * Examples:
 *   "sales_order_items_part_20251119_133430_214" → "sales_order_items"
 *   "sap_o2c_data_billing_document_headers_part_20251119_133433_936" → "billing_document_headers"
 */
function stripPartitionSuffix(name) {
    // Remove common prefixes like "sap_o2c_data_"
    let clean = name.replace(/^sap_o2c_data_/i, '');

    // Remove partition suffixes: _part_YYYYMMDD_HHMMSS_NNN or _part_NUMBER
    clean = clean.replace(/_part_\d[\d_]*$/i, '');

    // Remove trailing timestamps: _20251119_133430_214
    clean = clean.replace(/_\d{8}_\d{5,}_\d+$/, '');

    // Remove trailing numeric-only suffixes (e.g., _214, _936)
    clean = clean.replace(/_\d{2,}$/, '');

    return clean || name;
}

function inferSchema(files) {
    if (!files || files.length === 0) {
        throw new Error('No files provided for schema inference.');
    }

    // Phase 1: Parse all files and group by column signature (merge partitions)
    const mergeMap = new Map(); // columnKey → { name, records[], columns }

    for (const file of files) {
        if (!file.content || !file.content.trim()) {
            throw new Error(`File "${file.filename}" is empty.`);
        }

        const format = detectFormat(file.content);
        const records = parseFile(file.content, format);

        if (records.length === 0) {
            throw new Error(`File "${file.filename}" contains no valid records.`);
        }

        const columns = inferColumns(records);
        if (!columns || columns.length === 0) {
            throw new Error(`File "${file.filename}" has no detectable columns.`);
        }

        // Column signature: sorted column names joined — same signature = same table
        const colKey = [...columns].sort().join('|');
        const baseName = stripPartitionSuffix(inferTableName(file.filename));

        if (mergeMap.has(colKey)) {
            // Merge records into existing table
            const existing = mergeMap.get(colKey);
            existing.records.push(...records);
            // Keep the shorter/cleaner name
            if (baseName.length < existing.name.length) {
                existing.name = baseName;
            }
        } else {
            mergeMap.set(colKey, { name: baseName, columns, records });
        }
    }

    // Phase 2: Build table objects from merged groups
    const tables = [];
    const tableNames = new Set();

    for (const group of mergeMap.values()) {
        let tableName = group.name;

        // Deduplicate table names
        if (tableNames.has(tableName)) {
            let suffix = 2;
            while (tableNames.has(`${tableName}_${suffix}`)) suffix++;
            tableName = `${tableName}_${suffix}`;
        }
        tableNames.add(tableName);

        const primaryKey = detectPrimaryKeyCandidates(group.records, group.columns);

        tables.push({
            name: tableName,
            displayName: generateDisplayName(tableName),
            columns: group.columns,
            primaryKey,
            recordCount: group.records.length,
            records: group.records
        });
    }

    console.log(`[SCHEMA] Inferred ${tables.length} tables from ${files.length} files${files.length > tables.length ? ` (merged ${files.length - tables.length} partitions)` : ''}.`);

    return { tables };
}

module.exports = {
    detectFormat,
    parseFile,
    inferTableName,
    inferColumns,
    detectPrimaryKeyCandidates,
    generateDisplayName,
    recordsToJSONL,
    inferSchema
};
