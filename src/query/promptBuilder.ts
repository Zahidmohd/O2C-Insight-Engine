/**
 * Prompts construction for the natural language to SQL engine.
 * Schema and relationships are generated dynamically from the active dataset config.
 * SCHEMA_CONTEXT is lazily built and cached — rebuilt automatically on dataset switch.
 */

const { getActiveConfig } = require('../config/activeDataset');

// ─── Dynamic Schema Generation ──────────────────────────────────────────────

const MAX_COLUMNS_PER_TABLE = 12;

/**
 * Collects all columns referenced in relationships for a given table.
 * These are foreign-key columns that must always appear in the schema.
 */
function getFkColumns(config: any, tableName: string): Set<string> {
    const fkCols = new Set<string>();
    for (const rel of config.relationships) {
        for (const ref of [rel.from, rel.to]) {
            const dotIdx = ref.indexOf('.');
            const table = ref.substring(0, dotIdx);
            if (table === tableName) {
                const cols = ref.substring(dotIdx + 1).split('+');
                cols.forEach((c: string) => fkCols.add(c));
            }
        }
    }
    return fkCols;
}

/**
 * Builds the "--- DATABASE SCHEMA ---" section from config tables.
 * Limits columns per table to MAX_COLUMNS_PER_TABLE.
 * Always includes: primary key columns + foreign key columns.
 * Output format: 1. table_name (col1 PK, col2 FK, col3, ...)
 */
function buildSchemaSection(config: any): string {
    return config.tables.map((t: any, i: number) => {
        const pkSet = new Set(t.primaryKey || []);
        const fkSet = getFkColumns(config, t.name);

        // Priority columns: PK first, then FK, then the rest
        const priorityCols: string[] = [];
        const restCols: string[] = [];
        for (const c of t.columns) {
            if (pkSet.has(c) || fkSet.has(c)) {
                priorityCols.push(c);
            } else {
                restCols.push(c);
            }
        }

        // Fill remaining slots up to MAX_COLUMNS_PER_TABLE
        const remaining = Math.max(0, MAX_COLUMNS_PER_TABLE - priorityCols.length);
        const selectedCols = [...priorityCols, ...restCols.slice(0, remaining)];
        const omitted = t.columns.length - selectedCols.length;

        const colList = selectedCols.map((c: string) => {
            const tags: string[] = [];
            if (pkSet.has(c)) tags.push('PK');
            if (fkSet.has(c)) tags.push('FK');
            return tags.length > 0 ? `${c} ${tags.join(',')}` : c;
        }).join(', ');

        const suffix = omitted > 0 ? ` ... +${omitted} more` : '';
        return `${i + 1}. ${t.name} (${colList}${suffix})`;
    }).join('\n');
}

/**
 * Parses a relationship reference like "table.col1+col2" into { table, cols }.
 */
function parseRef(ref: string): { table: string; cols: string[] } {
    const [table, colPart] = ref.split('.');
    const cols = colPart.split('+');
    return { table, cols };
}

/**
 * Builds the "--- VALIDATED JOIN RELATIONSHIPS ---" section from config.
 * Highlights the exact column mapping: tableA.colA → tableB.colB
 */
function buildRelationshipSection(config: any): string {
    return config.relationships.map((r: any, i: number) => {
        const from = parseRef(r.from);
        const to = parseRef(r.to);

        // Clear column mapping line
        const mapping = from.cols.map((fc: string, j: number) =>
            `${from.table}.${fc} → ${to.table}.${to.cols[j]}`
        ).join(', ');

        const joinConditions = from.cols.map((fc: string, j: number) =>
            `${to.table}.${to.cols[j]} = ${from.table}.${fc}`
        ).join('\n    AND ');

        return `${i + 1}. ${r.description} (${r.label}):\n   Mapping: ${mapping}\n   ${r.joinType} ${to.table}\n     ON ${joinConditions}`;
    }).join('\n\n');
}

// ─── Standard Instructions (dataset-agnostic) ───────────────────────────────

const STANDARD_INSTRUCTIONS = `- Respond with standard SQLite SQL ONLY.
- No markdown formatting wrappers like \`\`\`sql. Just the raw SQL string.
- Only SELECT queries. Never DELETE, UPDATE, DROP, PRAGMA.
- Do not make up tables. Use only the provided schema.
- Try to answer the user's question as accurately and simply as possible.
- CRITICAL: All ID columns are TEXT type. Always wrap filter values in single quotes.
- For "trace full flow" or "trace" queries, follow the few-shot examples exactly if provided.`;

// ─── Lazy Schema Context Cache ──────────────────────────────────────────────

let _cachedConfig: any = null;
let _cachedSchemaContext: string | null = null;

function buildSchemaContext(config: any): string {
    let ctx = `
You are a database expert generating SQL for ${config.displayName || 'a relational database'}.
The database is SQLite. Do NOT use MySQL, PostgreSQL, or SQL Server specific syntax.

--- DATABASE SCHEMA ---

${buildSchemaSection(config)}

--- VALIDATED JOIN RELATIONSHIPS (MUST USE THESE EXACTLY) ---

${buildRelationshipSection(config)}
`;

    if (config.rules) {
        ctx += `\n--- JOIN STRATEGY RULES ---\n\n${config.rules}\n`;
    }

    if (config.examples) {
        ctx += `\n--- FEW-SHOT EXAMPLES ---\n\n${config.examples}\n`;
    }

    ctx += `\n--- INSTRUCTIONS ---\n${STANDARD_INSTRUCTIONS}\n`;

    return ctx;
}

/**
 * Returns the SCHEMA_CONTEXT for the active dataset.
 * Rebuilt automatically when the active config reference changes.
 */
function getSchemaContext(): string {
    const config = getActiveConfig();
    if (config !== _cachedConfig) {
        _cachedSchemaContext = buildSchemaContext(config);
        _cachedConfig = config;
    }
    return _cachedSchemaContext!;
}

function buildPrompt(userQuery: string): string {
    return `${getSchemaContext()}\n\nUser Question: ${userQuery}\n\nGenerate the SQL query to answer this question.`;
}

export {
    buildPrompt,
    getSchemaContext,
};

// Note: Original used `get domainKeywords()` in module.exports.
// In ES module style, we export a function that returns the current value.
export function getDomainKeywords(): string[] {
    return getActiveConfig().domainKeywords;
}
