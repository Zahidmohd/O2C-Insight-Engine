/**
 * Prompts construction for the natural language to SQL engine.
 * Schema and relationships are generated dynamically from the active dataset config.
 * SCHEMA_CONTEXT is lazily built and cached — rebuilt automatically on dataset switch.
 */

const { getActiveConfig } = require('../config/activeDataset');

// ─── Dynamic Schema Generation ──────────────────────────────────────────────

/**
 * Builds the "--- DATABASE SCHEMA ---" section from config tables.
 * Output format: 1. table_name (col1, col2 PK, col3, ...)
 */
function buildSchemaSection(config) {
    return config.tables.map((t, i) => {
        const colList = t.columns.map(c => {
            const isPk = t.primaryKey && t.primaryKey.length === 1 && t.primaryKey[0] === c;
            return isPk ? `${c} PK` : c;
        }).join(', ');
        return `${i + 1}. ${t.name} (${colList})`;
    }).join('\n');
}

/**
 * Parses a relationship reference like "table.col1+col2" into { table, cols }.
 */
function parseRef(ref) {
    const [table, colPart] = ref.split('.');
    const cols = colPart.split('+');
    return { table, cols };
}

/**
 * Builds the "--- VALIDATED JOIN RELATIONSHIPS ---" section from config.
 */
function buildRelationshipSection(config) {
    return config.relationships.map((r, i) => {
        const from = parseRef(r.from);
        const to = parseRef(r.to);

        const joinConditions = from.cols.map((fc, j) =>
            `${to.table}.${to.cols[j]} = ${from.table}.${fc}`
        ).join('\n    AND ');

        return `${i + 1}. ${r.description} (${r.label}):\n   ${r.joinType} ${to.table}\n     ON ${joinConditions}`;
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

let _cachedConfig = null;
let _cachedSchemaContext = null;

function buildSchemaContext(config) {
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
function getSchemaContext() {
    const config = getActiveConfig();
    if (config !== _cachedConfig) {
        _cachedSchemaContext = buildSchemaContext(config);
        _cachedConfig = config;
    }
    return _cachedSchemaContext;
}

function buildPrompt(userQuery) {
    return `${getSchemaContext()}\n\nUser Question: ${userQuery}\n\nGenerate the SQL query to answer this question.`;
}

module.exports = {
    buildPrompt,
    getSchemaContext,
    get domainKeywords() { return getActiveConfig().domainKeywords; }
};
