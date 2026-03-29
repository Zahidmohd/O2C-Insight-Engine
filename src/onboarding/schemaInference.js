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
const ID_SUFFIXES = ['id', '_id', 'key', 'code', 'number', 'no', 'num', 'ref'];

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

        // All sampled values must be unique
        if (uniqueValues.size === values.length) {
            const lowerCol = col.toLowerCase();
            const hasIdSuffix = ID_SUFFIXES.some(s => lowerCol.endsWith(s));
            const isDatetime = DATETIME_HINTS.some(h => lowerCol.includes(h));

            // Priority: 0 = ID suffix (best), 1 = regular, 2 = datetime (worst)
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
function inferSchema(files) {
    if (!files || files.length === 0) {
        throw new Error('No files provided for schema inference.');
    }

    const tables = [];
    const tableNames = new Set();

    for (const file of files) {
        if (!file.content || !file.content.trim()) {
            throw new Error(`File "${file.filename}" is empty.`);
        }

        const format = detectFormat(file.content);
        const records = parseFile(file.content, format);

        if (records.length === 0) {
            throw new Error(`File "${file.filename}" contains no valid records.`);
        }

        let tableName = inferTableName(file.filename);

        // Deduplicate table names
        if (tableNames.has(tableName)) {
            let suffix = 2;
            while (tableNames.has(`${tableName}_${suffix}`)) suffix++;
            tableName = `${tableName}_${suffix}`;
        }
        tableNames.add(tableName);

        const columns = inferColumns(records);
        if (!columns || columns.length === 0) {
            throw new Error(`File "${file.filename}" has no detectable columns.`);
        }

        const primaryKey = detectPrimaryKeyCandidates(records, columns);

        tables.push({
            name: tableName,
            displayName: generateDisplayName(tableName),
            columns,
            primaryKey,
            recordCount: records.length,
            records // kept for relationship inference — not sent to client
        });
    }

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
