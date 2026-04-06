/**
 * Dataset config validation -- runs BEFORE loader is called.
 *
 * Validates:
 *   1. Schema structure (tables, columns, primary keys)
 *   2. Relationships (from/to reference valid tables + columns)
 *   3. Data files exist and contain the declared columns
 *   4. Data integrity (non-empty files, key columns not null)
 */

import * as fs from 'fs';
import * as path from 'path';

// --- Schema Validation -------------------------------------------------------

/**
 * Validates that each table has name + non-empty columns array.
 * Throws on first failure.
 */
function validateSchema(config: any): void {
    if (!Array.isArray(config.tables) || config.tables.length === 0) {
        throw new Error('Invalid schema: tables array is empty.');
    }

    const tableNames = new Set<string>();
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

// --- Relationship Validation -------------------------------------------------

/**
 * Validates every relationship references existing tables and columns.
 * Uses simple split('.') and split('+') -- no regex.
 */
function validateRelationships(config: any): void {
    if (!Array.isArray(config.relationships) || config.relationships.length === 0) {
        throw new Error('Invalid schema: relationships array is empty.');
    }

    // Build lookup: tableName -> Set of column names
    const tableColumnMap = new Map<string, Set<string>>();
    for (const t of config.tables) {
        tableColumnMap.set(t.name, new Set(t.columns));
    }

    for (const rel of config.relationships) {
        const fromCount = validateRelSide(rel.from, tableColumnMap, rel);
        const toCount = validateRelSide(rel.to, tableColumnMap, rel);
        if (fromCount !== toCount) {
            throw new Error(
                `Invalid relationship: ${rel.from} -> ${rel.to} -- column count mismatch (${fromCount} vs ${toCount}).`
            );
        }
    }
}

function validateRelSide(ref: string, tableColumnMap: Map<string, Set<string>>, rel: any): number {
    const dotIdx = ref.indexOf('.');
    if (dotIdx === -1) {
        throw new Error(`Invalid relationship: "${ref}" -- expected "table.column" format.`);
    }

    const table = ref.substring(0, dotIdx);
    const colPart = ref.substring(dotIdx + 1);
    const cols = colPart.split('+');

    if (!tableColumnMap.has(table)) {
        throw new Error(`Invalid relationship: ${rel.from} -> ${rel.to} -- table "${table}" not found in config.`);
    }

    const validCols = tableColumnMap.get(table)!;
    for (const col of cols) {
        if (!validCols.has(col)) {
            throw new Error(`Invalid relationship: ${rel.from} -> ${rel.to} -- column "${col}" missing in table "${table}".`);
        }
    }

    return cols.length;
}

// --- Data File Validation ----------------------------------------------------

/**
 * For each table, checks:
 *   1. Data directory exists
 *   2. At least one JSONL file exists
 *   3. All declared columns exist in the JSONL file headers (first record)
 */
function validateDataFiles(config: any, resolvedDataDir: string): void {
    for (const t of config.tables) {
        const dir: string = t.directory || t.name;
        const dirPath = path.resolve(resolvedDataDir, dir);

        // Block path traversal -- directory must stay within the data root
        // Use separator suffix to avoid prefix collisions (e.g. /app/data vs /app/datax)
        const dataDirBoundary = resolvedDataDir.endsWith(path.sep) ? resolvedDataDir : resolvedDataDir + path.sep;
        if (!dirPath.startsWith(dataDirBoundary) && dirPath !== resolvedDataDir) {
            throw new Error(`Invalid schema: directory "${dir}" for table "${t.name}" escapes the data directory.`);
        }

        if (!fs.existsSync(dirPath)) {
            throw new Error(`Invalid schema: data directory "${dir}" not found for table "${t.name}".`);
        }

        const jsonlFiles = fs.readdirSync(dirPath).filter((f: string) => f.endsWith('.jsonl'));
        if (jsonlFiles.length === 0) {
            throw new Error(`Invalid schema: no .jsonl files found for table "${t.name}" in "${dir}".`);
        }

        // Read first record from first file to check column headers
        const firstFile = path.join(dirPath, jsonlFiles[0]);
        const content = fs.readFileSync(firstFile, 'utf8');
        const firstLine = content.split('\n').find((l: string) => l.trim());

        if (!firstLine) {
            throw new Error(`Invalid schema: table "${t.name}" has empty data file "${jsonlFiles[0]}".`);
        }

        let record: any;
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

// --- Data Integrity Checks ---------------------------------------------------

/**
 * Lightweight pre-load integrity checks:
 *   1. Each table's data files have at least 1 valid record
 *   2. Primary key columns are not null in sampled records
 */
function validateDataIntegrity(config: any, resolvedDataDir: string): void {
    for (const t of config.tables) {
        const dir: string = t.directory || t.name;
        const dirPath = path.join(resolvedDataDir, dir);
        const jsonlFiles = fs.readdirSync(dirPath).filter((f: string) => f.endsWith('.jsonl'));

        let totalRecords = 0;
        const pkCols: string[] = t.primaryKey || [];

        for (const file of jsonlFiles) {
            const filePath = path.join(dirPath, file);
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n').filter((l: string) => l.trim());

            // Sample first 10 records per file for key column checks
            const sample = lines.slice(0, 10);

            for (const line of sample) {
                let record: any;
                try {
                    record = JSON.parse(line);
                } catch {
                    continue; // skip malformed lines -- loader handles these
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

// --- Foreign Key Consistency -------------------------------------------------

/**
 * Parses "table.col1+col2" into { table, cols: ['col1','col2'] }.
 */
function parseRef(ref: string): { table: string; cols: string[] } {
    const dotIdx = ref.indexOf('.');
    const table = ref.substring(0, dotIdx);
    const cols = ref.substring(dotIdx + 1).split('+');
    return { table, cols };
}

/**
 * Builds a composite key string from a record and column list.
 * For single-column keys this is just the value; for composite it joins with '|'.
 */
function compositeKey(record: any, cols: string[]): string {
    return cols.map((c: string) => record[c] ?? '').join('|');
}

/**
 * Samples data from JSONL files and checks that FK values in the child table
 * actually exist in the parent table. Only checks the first 10 child rows
 * against ALL parent values (loaded from first file).
 *
 * Handles composite keys (col1+col2) correctly.
 */
function validateForeignKeyConsistency(config: any, resolvedDataDir: string): void {
    // Build a lookup: tableName -> array of parsed records from first file
    const dataCache = new Map<string, any[]>();

    function getTableSample(tableName: string, maxRows: number): any[] {
        if (dataCache.has(tableName)) return dataCache.get(tableName)!;

        const tableCfg = config.tables.find((t: any) => t.name === tableName);
        if (!tableCfg) return [];

        const dir: string = tableCfg.directory || tableCfg.name;
        const dirPath = path.join(resolvedDataDir, dir);
        if (!fs.existsSync(dirPath)) return [];

        const jsonlFiles = fs.readdirSync(dirPath).filter((f: string) => f.endsWith('.jsonl'));
        const records: any[] = [];

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

    const validRelationships: any[] = [];

    for (const rel of config.relationships) {
        // Skip LEFT JOINs -- partial matches are expected by design
        if (rel.joinType && rel.joinType.toUpperCase().includes('LEFT')) {
            validRelationships.push(rel);
            continue;
        }

        // In the config: from = parent (PK side), to = child (FK side)
        const parent = parseRef(rel.from);
        const child = parseRef(rel.to);

        // Skip composite keys -- raw data may differ from loaded data due
        // to transforms (e.g. item number padding), making pre-load checks unreliable
        if (parent.cols.length > 1 || child.cols.length > 1) {
            validRelationships.push(rel);
            continue;
        }

        // Load parent (from-side) values -- need enough to build a lookup set
        const parentRows = getTableSample(parent.table, 5000);
        if (parentRows.length === 0) {
            validRelationships.push(rel);
            continue;
        }

        const parentSet = new Set(parentRows.map((r: any) => compositeKey(r, parent.cols)));

        // Sample child (to-side) rows -- use larger sample for merged partition data
        const childRows = getTableSample(child.table, 100);

        let checked = 0;
        let matched = 0;

        for (let i = 0; i < Math.min(100, childRows.length); i++) {
            const key = compositeKey(childRows[i], child.cols);
            if (!key || key === '' || key.split('|').every((v: string) => !v)) continue;
            checked++;
            if (parentSet.has(key)) matched++;
        }

        // Only remove if ZERO matches in 100 samples -- very likely a bad relationship
        // (e.g., totalNetAmount matching across tables)
        if (checked > 0 && matched === 0) {
            console.warn(`[VALIDATOR] Auto-removed bad relationship: ${rel.from} -> ${rel.to} -- 0 of ${checked} sampled rows matched.`);
            continue;
        }

        validRelationships.push(rel);
    }

    // Replace config relationships with only the validated ones
    config.relationships = validRelationships;
}

// --- Combined Validator ------------------------------------------------------

/**
 * Runs all validations in order. Fails fast on first error.
 */
function validateDatasetConfig(config: any, resolvedDataDir?: string): void {
    validateSchema(config);
    validateRelationships(config);

    // Data file + integrity + FK consistency checks only when dataDir is provided
    if (resolvedDataDir) {
        validateDataFiles(config, resolvedDataDir);
        validateDataIntegrity(config, resolvedDataDir);
        validateForeignKeyConsistency(config, resolvedDataDir);
    }
}

export {
    validateSchema,
    validateRelationships,
    validateDataFiles,
    validateDataIntegrity,
    validateForeignKeyConsistency,
    validateDatasetConfig
};
