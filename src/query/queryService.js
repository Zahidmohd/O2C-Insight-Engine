const { buildPrompt } = require('./promptBuilder');
const { getSqlFromLLM, generateNLAnswer } = require('./llmClient');
const { validateSql } = require('./validator');
const { executeQuery } = require('./sqlExecutor');
const { extractGraph } = require('./graphExtractor');
const { classifyQuery } = require('./queryClassifier');
const { classifyComplexity } = require('./complexityClassifier');
const { retrieveContext } = require('../rag/knowledgeBase');
const { getActiveConfig } = require('../config/activeDataset');

/**
 * In-memory response cache — avoids burning LLM tokens on repeated identical queries.
 * TTL: 5 minutes. Keyed by normalized query + includeSql flag so toggling
 * "Show SQL" always fetches a fresh response with SQL included.
 */
const responseCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 500;

const STOPWORDS = new Set(['the', 'is', 'show', 'all', 'give', 'me', 'a', 'an', 'of', 'for', 'and', 'with', 'in', 'to', 'by']);

/**
 * Normalizes a query string for cache key matching.
 * "Show all billing documents" and "show billing documents" hit the same key.
 * Steps: lowercase → strip punctuation → collapse whitespace → remove stopwords.
 * Word order is preserved to avoid false hits across different query intents.
 */
function normalizeQuery(query) {
    return query
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w && !STOPWORDS.has(w))
        .join(' ');
}

function cacheKey(query, includeSql, tenantId, config) {
    const dsKey = `${tenantId || 'global'}:${config.name}:${config.version || 'default'}`;
    return `${dsKey}:${normalizeQuery(query)}${includeSql ? ':sql' : ''}`;
}

function getCached(query, includeSql, tenantId, config) {
    const key = cacheKey(query, includeSql, tenantId, config);
    const entry = responseCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
        responseCache.delete(key);
        return null;
    }
    return entry.response;
}

function setCached(query, includeSql, response, tenantId, config) {
    const key = cacheKey(query, includeSql, tenantId, config);
    if (responseCache.size >= MAX_CACHE_SIZE) {
        const oldestKey = responseCache.keys().next().value;
        responseCache.delete(oldestKey);
    }
    responseCache.set(key, { response, timestamp: Date.now() });
}

/**
 * Validates domain safety before spending API tokens
 * Rejects questions wildly outside the active dataset's domain
 */
function isIntentValid(query) {
    const queryLower = query.toLowerCase().trim();
    // Valid business intents derived from user specs plus standard English interrogation frames required for backward compatibility
    const validIntents = [
        'trace', 'show', 'find', 'list', 'count', 'top', 'which', 'how', 'what',
        'get', 'fetch', 'highest', 'lowest', 'give', 'total', 'average', 'identify',
        'all', 'are', 'is', 'does', 'do', 'has', 'have', 'between', 'for',
        'compare', 'check', 'display', 'search', 'broken', 'incomplete', 'cancelled',
        'who', 'where', 'when', 'many', 'much',
        'most', 'least', 'best', 'worst', 'popular', 'frequent', 'biggest', 'smallest',
        'largest', 'highest', 'lowest', 'recent', 'latest', 'oldest', 'first', 'last'
    ];
    
    // Must contain at least one valid intent word structurally
    const words = queryLower.match(/\b\w+\b/g) || [];
    const hasIntent = validIntents.some(intent => words.includes(intent));

    // Also allow queries that contain document IDs (just numbers)
    const hasDocumentId = /\d{5,}/.test(queryLower);

    if (!hasIntent && !hasDocumentId) {
        return {
            valid: false,
            message: "Could not understand the query. Please rephrase using a clear business action like 'trace', 'show', or 'find'."
        };
    }
    return { valid: true };
}

function isDomainQuery(query) {
    const queryLower = query.toLowerCase();

    // Domain keywords sourced from active dataset config
    const matchedKeywords = getActiveConfig().domainKeywords.filter(kw => queryLower.includes(kw));

    if (matchedKeywords.length === 0) {
        return {
            valid: false,
            message: "This system is designed to answer questions related to the provided dataset only."
        };
    }
    return { valid: true };
}

/**
 * Attempts to handle simple single-table queries without calling the LLM.
 * Matches patterns like "show all X", "list X", "get X" where X is a known table.
 * Returns a full response object on match, or null to fall through to LLM.
 */
async function tryRuleBasedQuery(query, tag, options) {
    const lower = query.toLowerCase().trim();

    // Only handle simple show/list/get/find patterns without JOINs or complex logic
    if (!/^(show|list|get|find|fetch|display)\b/i.test(lower)) return null;
    if (/\b(join|between|where|group|having|relationship|compare|trace|flow)\b/i.test(lower)) return null;
    if (/\b(top\s+\d|count|total|sum|average|avg|min|max)\b/i.test(lower)) return null;

    const config = getActiveConfig();

    // Try to match a table name in the query
    let matchedTable = null;
    for (const t of config.tables) {
        const displayLower = (t.displayName || '').toLowerCase();
        const nameLower = t.name.toLowerCase().replace(/_/g, ' ');
        if (lower.includes(displayLower) || lower.includes(nameLower) || lower.includes(t.name.toLowerCase())) {
            matchedTable = t;
            break;
        }
    }

    if (!matchedTable) return null;

    const sql = `SELECT * FROM "${matchedTable.name}" LIMIT 100`;

    try {
        validateSql(sql);
    } catch {
        return null; // Fall through to LLM if validation fails
    }

    console.log(`${tag} [RULE_BASED] Simple listing query → ${sql}`);

    // Execute synchronously-style via the same pipeline
    const result = await require('./sqlExecutor').executeQueryDirect(sql);
    if (!result || !result.success) return null; // Fall through to LLM on DB error

    const response = formatResponse(result, options.includeSql ? sql : undefined);
    const explanation = buildExplanation(query, sql);
    const confidence = calculateConfidence({ queryType: 'SQL', fallbackApplied: false, rowCount: result.rowCount, isAggregation: false });

    return {
        ...response,
        dataset: config.name,
        queryType: 'SQL',
        reason: result.rowCount > 0 ? 'DATA_FOUND' : 'NO_DATA',
        message: result.rowCount === 0 ? 'No records found.' : null,
        suggestions: [],
        nlAnswer: result.rowCount > 0
            ? `Found ${result.rowCount} ${(config.tables.find(t => t.name === matchedTable.name)?.displayName || matchedTable.name.replace(/_/g, ' '))} record${result.rowCount !== 1 ? 's' : ''}.`
            : null,
        explanation,
        confidence: confidence.score,
        confidenceLabel: confidence.label,
        confidenceReasons: [...confidence.reasons, 'Rule-based query (no LLM used)'],
        executionPlan: 'RULE_BASED',
        queryPlan: buildQueryPlan(sql, explanation),
        truncated: result.rows.length > 100
    };
}

/**
 * Appends a LIMIT to queries that lack them to protect performance
 */
function enforceLimit(sql) {
    // Basic regex check if LIMIT exists regardless of spacing/casing
    const hasLimit = /LIMIT\s+\d+/i.test(sql);
    if (!hasLimit) {
        // Find trailing semicolons and append LIMIT before it if needed
        let cleanSql = sql.trim();
        if (cleanSql.endsWith(';')) cleanSql = cleanSql.slice(0, -1);
        return cleanSql + '\nLIMIT 100;';
    }
    return sql;
}

/**
 * Promise wrapper to add execution timeout protection
 */
function withTimeout(promise, ms, operationName) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`Timeout: ${operationName} exceeded ${ms}ms limit.`));
        }, ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

/**
 * Extracts explicitly referenced entities from the SQL conditionally building highlighting focus paths natively.
 */
function extractHighlightNodes(sql) {
    const config = getActiveConfig();

    if (config.name === 'sap_o2c') {
        return extractHighlightNodesO2C(sql);
    }

    return extractHighlightNodesGeneric(sql, config);
}

function extractHighlightNodesO2C(sql) {
    const highlights = [];
    if (!sql) return highlights;
    const idRegex = /(?:billingDocument|salesOrder|customer|accountingDocument|deliveryDocument|soldToParty)\s*(?:=|LIKE)\s*['"]?(\d+)['"]?/gi;
    let match;
    while ((match = idRegex.exec(sql)) !== null) {
        const fieldName = match[0].toLowerCase();
        const id = match[1];
        if (fieldName.includes('billing')) highlights.push(`BILL_${id}`);
        else if (fieldName.includes('sales')) highlights.push(`SO_${id}`);
        else if (fieldName.includes('customer') || fieldName.includes('soldtoparty')) highlights.push(`CUST_${id}`);
        else if (fieldName.includes('accounting')) highlights.push(`JE_${id}`);
        else if (fieldName.includes('delivery')) highlights.push(`DEL_${id}`);
    }
    return highlights;
}

function extractHighlightNodesGeneric(sql, config) {
    const highlights = [];
    if (!sql) return highlights;
    // Build regex from tables with single-column primary keys
    for (const t of config.tables) {
        if (!t.primaryKey || t.primaryKey.length !== 1) continue;
        const pk = t.primaryKey[0];
        const regex = new RegExp(`${pk}\\s*(?:=|LIKE)\\s*['"]?([\\w]+)['"]?`, 'gi');
        let match;
        while ((match = regex.exec(sql)) !== null) {
            highlights.push(`${t.name}_${pk}_${match[1]}`);
        }
    }
    return highlights;
}

/**
 * Builds ID existence checks for generic (non-O2C) datasets.
 * Creates a check for each table with a single-column primary key.
 */
function buildGenericIdChecks(config) {
    const checks = [];
    for (const t of config.tables) {
        if (!t.primaryKey || t.primaryKey.length !== 1) continue;
        const pk = t.primaryKey[0];
        const displayName = (t.displayName || t.name.replace(/_/g, ' '));
        checks.push({
            // Match pk = 'value' or pk = "value" or pk = 12345 (quoted or numeric only)
            // Excludes bare words like table aliases (bdh, soh, etc.)
            regex: new RegExp(`(?<![.\\w])${pk}\\s*(?:=|LIKE)\\s*'([^']+)'`, 'i'),
            table: `"${t.name}"`,
            column: `"${pk}"`,
            label: displayName
        });
    }
    return checks;
}

/**
 * Formats the final structural response output
 */
function formatResponse(result, rawSql) {
    // Truncate to max 100 rows for payload efficiency
    const MAX_ROWS = 100;
    const isTruncated = result.rows.length > MAX_ROWS;
    const finalRows = isTruncated ? result.rows.slice(0, MAX_ROWS) : result.rows;

    let summary = `Query returned ${result.rowCount} row(s) in ${result.executionTimeMs}ms.`;
    if (result.rowCount === 0) {
        summary = `No records found matching your query in the dataset. Execution took ${result.executionTimeMs}ms.`;
    } else if (isTruncated) {
        summary = `Query returned ${result.rowCount} row(s). Truncated payload to ${MAX_ROWS} rows for wire performance. Execution took ${result.executionTimeMs}ms.`;
    }

    const keyFields = finalRows && finalRows.length > 0 
        ? Object.keys(finalRows[0])
        : [];

    const highlightNodes = extractHighlightNodes(rawSql);

    // Map rows mapping structural identifiers down to array graphs
    const graphData = extractGraph(finalRows, getActiveConfig());

    return {
        success: true,
        summary: summary,
        rowCount: result.rowCount, // real count regardless of payload truncation
        keyFields: keyFields,
        executionTimeMs: Number(result.executionTimeMs),
        generatedSql: rawSql,
        data: finalRows, // actual sliced data bounded effectively
        graph: { nodes: graphData.nodes, edges: graphData.edges },
        graphTruncated: graphData.graphTruncated || false,
        highlightNodes: highlightNodes
    };
}

/**
 * Infers query intent, extracts mentioned entities, and determines execution strategy.
 * Used to populate the explanation object in every SQL/HYBRID response.
 */
function buildExplanation(query, sql) {
    const lower = query.toLowerCase();

    // Infer intent from query keywords
    let intent = 'lookup';
    if (/trace|flow|chain|end.to.end/.test(lower)) intent = 'trace';
    else if (/count|total|sum|average|group|top\s+\d|most|least/.test(lower)) intent = 'aggregation';
    else if (/find|list|show|get/.test(lower)) intent = 'list';
    else if (/why|missing|without|not billed|not delivered/.test(lower)) intent = 'gap-analysis';

    // Extract entities from the NL query text (from active dataset config)
    const entitiesFromQuery = (getActiveConfig().entities || []).filter(e => lower.includes(e.toLowerCase()));

    // Also infer entities from tables referenced in the generated SQL
    const sqlLower = (sql || '').toLowerCase();
    const config = getActiveConfig();
    const tableEntityMap = config.name === 'sap_o2c'
        ? [
            { table: 'sales_order_headers',                       entity: 'sales order' },
            { table: 'outbound_delivery',                         entity: 'delivery' },
            { table: 'billing_document',                          entity: 'billing' },
            { table: 'journal_entry_items_accounts_receivable',   entity: 'journal entry' },
            { table: 'payments_accounts_receivable',              entity: 'payment' },
            { table: 'business_partners',                         entity: 'business partner' },
        ]
        : config.tables.map(t => ({
            table: t.name,
            entity: (t.displayName || t.name.replace(/_/g, ' ')).toLowerCase()
        }));
    const entitiesFromSql = tableEntityMap
        .filter(m => new RegExp(`\\b${m.table}\\b`, 'i').test(sql || ''))
        .map(m => m.entity);

    // Merge, deduplicate, preserve order (query-mentioned first)
    const entities = [...new Set([...entitiesFromQuery, ...entitiesFromSql])];

    // Determine strategy from intent and SQL shape
    let strategy = 'lookup with filters';
    if (intent === 'trace') strategy = config.name === 'sap_o2c' ? 'multi-hop join across O2C flow' : 'multi-hop join across document flow';
    else if (intent === 'aggregation') strategy = 'aggregation query with GROUP BY';
    else if (intent === 'gap-analysis') strategy = 'gap detection using LEFT JOIN with NULL check';
    else if (sql && /JOIN/i.test(sql)) strategy = 'multi-table join query';

    // Build a plain-English explanation of what the system did
    const entityLabel = entities.length > 0 ? entities.join(', ') : (config.displayName || 'dataset');
    const intentTexts = {
        'trace':        `traced the full document flow across ${entityLabel} records`,
        'aggregation':  `computed aggregated totals for ${entityLabel}`,
        'list':         `retrieved a list of matching ${entityLabel} records`,
        'gap-analysis': `checked for missing or incomplete links in the ${entityLabel} flow`,
        'lookup':       `looked up ${entityLabel} records matching your filters`,
    };
    const explanationText = `The system identified this as a ${intent} query and ${intentTexts[intent]}.`;

    return { intent, entities, strategy, explanationText };
}

/**
 * Derives a structured query plan from generated SQL + active config.
 * Exposes which tables were used, which joins were traversed, and why.
 * Pure SQL parsing — no LLM dependency.
 */
function buildQueryPlan(sql, explanation) {
    const config = getActiveConfig();
    if (!sql) {
        return { type: 'UNKNOWN', tablesUsed: [], joinPath: [], reasoning: 'No SQL available.' };
    }

    // Helper: word-boundary match prevents false positives (e.g., "products" inside "product_storage_locations")
    const sqlHasTable = (tableName) => new RegExp(`\\b${tableName}\\b`, 'i').test(sql);

    // 1. Extract tables referenced in SQL (FROM + JOIN clauses)
    const tablesUsed = config.tables
        .filter(t => sqlHasTable(t.name))
        .map(t => t.displayName || t.name);

    // 2. Detect actual join type from SQL (not config default)
    const hasLeftJoin = /LEFT\s+JOIN/i.test(sql);

    // 3. Extract join path from config relationships that match tables in the SQL
    const joinPath = config.relationships
        .filter(r => {
            const fromTable = r.from.split('.')[0];
            const toTable = r.to.split('.')[0];
            return sqlHasTable(fromTable) && sqlHasTable(toTable);
        })
        .map(r => {
            const toTable = r.to.split('.')[0];
            // Check if THIS specific table is LEFT JOINed in the SQL
            const tableLeftJoined = new RegExp(`LEFT\\s+JOIN\\s+${toTable}\\b`, 'i').test(sql);
            return {
                from: r.from,
                to: r.to,
                label: r.label,
                joinType: tableLeftJoined ? 'LEFT' : 'INNER'
            };
        });

    // 4. Classify query plan type
    let type = 'SIMPLE_QUERY';
    if (joinPath.length >= 3) type = 'MULTI_HOP_TRACE';
    else if (joinPath.length >= 1) type = 'MULTI_TABLE_JOIN';
    if (/\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(sql)) type = 'AGGREGATION';
    if (/IS\s+NULL/i.test(sql) && hasLeftJoin) type = 'GAP_ANALYSIS';

    // 5. Build reasoning from explanation context
    const reasoning = joinPath.length > 0
        ? `Traversed ${joinPath.length} relationship(s) across ${tablesUsed.length} table(s): ${joinPath.map(j => j.label).join(' \u2192 ')}`
        : `Direct query against ${tablesUsed.length} table(s): ${tablesUsed.join(', ')}`;

    return { type, tablesUsed, joinPath, reasoning };
}

/**
 * Produces a reliability score (0.0–1.0), a human-readable label, and
 * an array of reasons explaining the score.
 * RAG responses are always 1.0 (direct KB lookup, no SQL uncertainty).
 * SQL/HYBRID scores are reduced by fallback usage, zero rows, or aggregation uncertainty.
 */
function calculateConfidence({ queryType, fallbackApplied, rowCount, isAggregation }) {
    const reasons = [];

    if (queryType === 'RAG') {
        return { score: 1.0, label: 'High', reasons: ['Direct knowledge base lookup'] };
    }

    let score = 1.0;
    reasons.push('Valid SQL generated');

    if (fallbackApplied) {
        score -= 0.2;
        reasons.push('Fallback JOIN relaxation was used');
    } else {
        reasons.push('No fallback used');
    }

    if (rowCount === 0) {
        score -= 0.4;
        reasons.push('Query returned zero rows');
    } else {
        reasons.push(`Non-empty results (${rowCount} rows)`);
    }

    if (isAggregation) {
        score -= 0.1;
        reasons.push('Aggregation query — edge-case rounding possible');
    }

    score = Math.max(0, Math.min(1, parseFloat(score.toFixed(2))));

    let label = 'High';
    if (score < 0.4) label = 'Low';
    else if (score <= 0.75) label = 'Medium';

    return { score, label, reasons };
}

/**
 * Last-resort SQL generation from keyword-to-table matching.
 * Called only when ALL LLM providers fail. Returns a simple SELECT or null.
 */
function tryFallbackSql(query) {
    const config = getActiveConfig();
    const lower = query.toLowerCase();

    // Try to match a table name in the query
    let matchedTable = null;
    for (const t of config.tables) {
        const displayLower = (t.displayName || '').toLowerCase();
        const nameLower = t.name.toLowerCase().replace(/_/g, ' ');
        if (lower.includes(displayLower) || lower.includes(nameLower) || lower.includes(t.name.toLowerCase())) {
            matchedTable = t;
            break;
        }
    }

    if (!matchedTable) return null;

    // Check if query contains a numeric ID we can filter on
    const idMatch = lower.match(/\b(\d{5,})\b/);
    if (idMatch && matchedTable.primaryKey && matchedTable.primaryKey.length === 1) {
        const pk = matchedTable.primaryKey[0];
        return `SELECT * FROM "${matchedTable.name}" WHERE "${pk}" = '${idMatch[1]}' LIMIT 100;`;
    }

    // Check for aggregation keywords
    if (/\b(count|total|how many)\b/.test(lower)) {
        return `SELECT COUNT(*) AS total FROM "${matchedTable.name}";`;
    }

    if (/\b(top|highest|largest|biggest|most)\b/.test(lower)) {
        // Pick a numeric-looking column if available, otherwise just list
        return `SELECT * FROM "${matchedTable.name}" LIMIT 10;`;
    }

    return `SELECT * FROM "${matchedTable.name}" LIMIT 100;`;
}

/**
 * Returns pre-built example queries for the active dataset.
 * Shown to users when all LLM providers are unavailable.
 */
function buildSuggestedQueries() {
    const config = getActiveConfig();

    if (config.name === 'sap_o2c') {
        return [
            'Show all sales order headers',
            'List billing document headers',
            'Show outbound delivery items',
            'Count all sales orders',
            'Find journal entries'
        ];
    }

    // Generic: build diverse suggestions from table names
    const suggestions = [];
    const tables = config.tables.slice(0, 5);
    const patterns = [
        (name) => `Show all ${name}`,
        (name) => `Count all ${name}`,
        (name) => `List ${name} with details`,
    ];
    for (let i = 0; i < tables.length; i++) {
        const display = tables[i].displayName || tables[i].name.replace(/_/g, ' ');
        suggestions.push(patterns[i % patterns.length](display));
    }
    return suggestions;
}

/**
 * Orchestrates the full Natural Language -> SQL -> Result pipeline
 */
async function processQuery(naturalLanguageQuery, requestId = 'dev-local', options = {}, dbConn = null, configOverride = null) {
    const dbInstance = dbConn || require('../db/connection');
    const activeConfig = configOverride || getActiveConfig();
    const tag = `[API-${requestId}]`;
    console.log(`\n${tag} [USER_QUERY] "${naturalLanguageQuery}"`);

    // 0a. Cache check — skip LLM entirely for repeated identical queries
    const tenantId = options.tenantId || null;
    const cached = getCached(naturalLanguageQuery, options.includeSql, tenantId, activeConfig);
    if (cached) {
        console.log(`${tag} [CACHE_HIT] Returning cached response.`);
        return cached;
    }

    // 0b. Check if tenant has uploaded documents (enables RAG for non-domain queries)
    let hasDocuments = false;
    try {
        const { getChunkCount } = require('../rag/vectorStore');
        hasDocuments = (await getChunkCount(dbInstance)) > 0;
    } catch {}

    // 0c. Classify query type — passes document awareness to classifier
    const queryType = classifyQuery(naturalLanguageQuery, { hasDocuments });
    console.log(`${tag} [QUERY_TYPE] ${queryType}${hasDocuments ? ' (documents available)' : ''}`);

    // INVALID path: query has no domain relevance AND no documents to search
    if (queryType === 'INVALID') {
        const dsName = activeConfig.displayName || activeConfig.name;
        console.warn(`${tag} [VALIDATION] Domain check failed at classifier — no domain keywords found.`);
        return {
            success: false,
            dataset: activeConfig.name,
            error: { message: `This system is designed to answer questions related to the ${dsName} dataset only.`, type: 'VALIDATION_ERROR' },
            query: naturalLanguageQuery
        };
    }

    // RAG path: explanation-only, no SQL execution needed
    if (queryType === 'RAG') {
        const context = await retrieveContext(naturalLanguageQuery, dbInstance);
        console.log(`${tag} [RESULT] RAG response dispatched (rowCount: 0).`);
        return {
            success: true,
            dataset: activeConfig.name,
            queryType: 'RAG',
            reason: 'RAG_RESPONSE',
            nlAnswer: context || 'No specific context found for this topic in the knowledge base.',
            rowCount: 0,
            data: [],
            graph: { nodes: [], edges: [] },
            highlightNodes: [],
            summary: 'Explanation retrieved from knowledge base.',
            confidence: 1.0,
            confidenceLabel: 'High',
            confidenceReasons: ['Direct knowledge base lookup'],
            executionPlan: 'RULE_BASED',
            queryPlan: { type: 'RAG_LOOKUP', tablesUsed: [], joinPath: [], reasoning: 'Direct knowledge base lookup — no SQL involved.' },
            explanation: {
                intent: 'concept explanation',
                entities: [],
                strategy: 'knowledge retrieval',
            },
        };
    }

    // 1. Guardrails (bypassed for document-enriched tenants on non-domain queries)
    const intentCheck = isIntentValid(naturalLanguageQuery);
    if (!intentCheck.valid && !hasDocuments) {
        console.warn(`${tag} [VALIDATION] Intent check failed — no recognized business action.`);
        return {
            success: false,
            dataset: activeConfig.name,
            error: { message: intentCheck.message, type: 'VALIDATION_ERROR' },
            query: naturalLanguageQuery
        };
    }

    const domainCheck = isDomainQuery(naturalLanguageQuery);
    if (!domainCheck.valid && !hasDocuments) {
        console.warn(`${tag} [VALIDATION] Domain check failed — query outside dataset scope.`);
        return {
            success: false,
            dataset: activeConfig.name,
            error: { message: domainCheck.message, type: 'VALIDATION_ERROR' },
            query: naturalLanguageQuery
        };
    }
    
    // 2. Rule-based bypass for simple single-table queries (saves LLM cost)
    const ruleBasedResult = await tryRuleBasedQuery(naturalLanguageQuery, tag, options);
    if (ruleBasedResult) {
        console.log(`${tag} [RULE_BASED] Handled without LLM.`);
        setCached(naturalLanguageQuery, options.includeSql, ruleBasedResult, tenantId, activeConfig);
        return ruleBasedResult;
    }

    // 2.5. Classify query complexity for model routing
    const { level: complexity, reason: complexityReason } = classifyComplexity(naturalLanguageQuery);
    console.log(`${tag} [COMPLEXITY] ${complexity} — ${complexityReason}`);

    // 3. Build Prompt
    const prompt = buildPrompt(naturalLanguageQuery);

    // 4. Generate SQL from LLM with timeout protection (routed by complexity)
    let rawSql = null;
    let llmFailed = false;

    try {
        const generatedSql = await withTimeout(getSqlFromLLM(prompt, complexity), 50000, 'LLM Generation');
        rawSql = enforceLimit(generatedSql);
        console.log(`${tag} [SQL_GENERATED]\n${rawSql}`);
        validateSql(rawSql);
        console.log(`${tag} [VALIDATION] SQL passed safety checks.`);
    } catch (llmErr) {
        console.error(`${tag} [LLM_FALLBACK] LLM/validation failed: ${llmErr.message}`);
        llmFailed = true;
    }

    if (llmFailed) {
        // Last resort: try to generate a basic SQL from keyword matching
        const fallbackSql = tryFallbackSql(naturalLanguageQuery);
        if (fallbackSql) {
            console.log(`${tag} [FALLBACK_SQL] Generated: ${fallbackSql}`);
            try {
                validateSql(fallbackSql);
                const fbResult = await withTimeout(executeQuery(fallbackSql, [], dbInstance), 5000, 'Fallback SQL Execution');
                if (fbResult.success && fbResult.rowCount > 0) {
                    console.log(`${tag} [FALLBACK_SQL] Success — ${fbResult.rowCount} rows.`);
                    const response = formatResponse(fbResult, options.includeSql ? fallbackSql : undefined);
                    response.dataset = activeConfig.name;
                    response.queryType = 'SQL';
                    response.reason = fbResult.rowCount > 0 ? 'DATA_FOUND' : 'NO_DATA';
                    response.explanation = buildExplanation(naturalLanguageQuery, fallbackSql);
                    response.confidence = 0.5;
                    response.confidenceLabel = 'Medium';
                    response.confidenceReasons = ['Fallback SQL (no LLM used)', 'Basic keyword-to-table matching'];
                    response.queryPlan = 'FALLBACK_SQL';
                    response.complexity = complexity;
                    response.nlAnswer = null;
                    setCached(naturalLanguageQuery, options.includeSql, response, tenantId, activeConfig);
                    return response;
                }
            } catch (fbErr) {
                console.error(`${tag} [FALLBACK_SQL] Failed:`, fbErr.message);
            }
        }

        const fallbackResponse = {
            success: true,
            dataset: activeConfig.name,
            queryType: 'FALLBACK',
            summary: 'All AI providers are temporarily unavailable. Please try again shortly.',
            reason: 'LLM_UNAVAILABLE',
            message: 'All AI services are temporarily unavailable.',
            rowCount: 0,
            keyFields: [],
            data: [],
            graph: { nodes: [], edges: [] },
            highlightNodes: [],
            explanation: {
                intent: 'unknown',
                entities: [],
                strategy: 'All LLM providers failed',
                explanationText: 'Unable to process query — all AI providers exhausted.'
            },
            confidence: 0.1,
            confidenceLabel: 'Low',
            confidenceReasons: ['All LLM providers failed'],
            executionPlan: 'FALLBACK',
            queryPlan: { type: 'FALLBACK', tablesUsed: [], joinPath: [], reasoning: 'All LLM providers unavailable — returned suggested queries.' },
            complexity,
            nlAnswer: null,
            suggestions: buildSuggestedQueries()
        };
        setCached(naturalLanguageQuery, options.includeSql, fallbackResponse, tenantId, activeConfig);
        return fallbackResponse;
    }

    try {

        // 4.5. Existence checks for referenced document IDs
        let explicitIdChecked = false;
        let explicitCustChecked = false;
        let extractedCustId = null;

        const idChecks = activeConfig.name === 'sap_o2c'
            ? [
                { regex: /billingDocument\s*(?:=|LIKE)\s*['"]?(\d+)['"]?/i, table: 'billing_document_headers', column: 'billingDocument', label: 'Billing document' },
                { regex: /(?:soh\.|sales_order_headers\.)?\bsalesOrder\s*(?:=|LIKE)\s*['"]?(\d+)['"]?/i, table: 'sales_order_headers', column: 'salesOrder', label: 'Sales order' },
                { regex: /deliveryDocument\s*(?:=|LIKE)\s*['"]?(\d+)['"]?/i, table: 'outbound_delivery_headers', column: 'deliveryDocument', label: 'Delivery document' }
            ]
            : buildGenericIdChecks(activeConfig);

        for (const check of idChecks) {
            const match = rawSql.match(check.regex);
            if (match && match[1]) {
                const extractedId = match[1];
                explicitIdChecked = true;
                console.log(`${tag} [VALIDATION] Checking existence of ${check.label} '${extractedId}'...`);
                
                const checkResult = await withTimeout(
                    executeQuery(`SELECT ${check.column} FROM ${check.table} WHERE ${check.column} = ? LIMIT 1`, [extractedId], dbInstance),
                    2000, 'DB Existence Check'
                );
                
                if (checkResult.success && checkResult.rowCount === 0) {
                    console.log(`${tag} [VALIDATION] Invalid ${check.label} ID: ${extractedId}`);
                    const sampleResult = await withTimeout(
                        executeQuery(`SELECT ${check.column} FROM ${check.table} ORDER BY RANDOM() LIMIT 5`, [], dbInstance),
                        2000, 'DB Samples Fetch'
                    );
                    const suggestions = sampleResult.success ? sampleResult.rows.map(r => r[check.column]) : [];
                    
                    return {
                        success: true,
                        dataset: activeConfig.name,
                        queryType,
                        summary: `${check.label} '${extractedId}' was not found in the dataset.`,
                        reason: 'INVALID_ID',
                        message: 'No records found for the given query.',
                        suggestions: suggestions,
                        rowCount: 0,
                        keyFields: [],
                        executionTimeMs: 0,
                        generatedSql: options.includeSql ? rawSql : undefined,
                        data: [],
                        graph: { nodes: [], edges: [] },
                        explanation: buildExplanation(naturalLanguageQuery, rawSql),
                        confidence: 0.3,
                        confidenceLabel: 'Low',
                        confidenceReasons: ['Valid SQL generated', 'Referenced document ID not found in dataset'],
                        executionPlan: 'LLM',
                        queryPlan: buildQueryPlan(rawSql, buildExplanation(naturalLanguageQuery, rawSql))
                    };
                }
                console.log(`${tag} [VALIDATION] ${check.label} '${extractedId}' exists.`);
                break; // Only check the first matched ID type
            }
        }

        // 4.6. Check if specific customer exists in DB (O2C-specific)
        const custMatch = activeConfig.name === 'sap_o2c'
            ? rawSql.match(/(?:soldToParty|\.customer)\s*(?:=|LIKE)\s*['"]?(\d+)['"]?/i)
            : null;

        if (custMatch && custMatch[1]) {
            extractedCustId = custMatch[1];
            explicitCustChecked = true;
            console.log(`${tag} [VALIDATION] Checking existence of customer '${extractedCustId}'...`);

            const custCheckResult = await withTimeout(
                executeQuery(`SELECT salesOrder FROM sales_order_headers WHERE soldToParty = ? LIMIT 1`, [extractedCustId], dbInstance),
                2000, 'DB Customer Check'
            );

            if (custCheckResult.success && custCheckResult.rowCount === 0) {
                console.log(`${tag} [VALIDATION] No records for customer '${extractedCustId}'.`);
                return {
                    success: true,
                    dataset: activeConfig.name,
                    queryType,
                    summary: `No records found for customer '${extractedCustId}' in the dataset.`,
                    reason: 'INVALID_ID',
                    message: 'No records found for the given query.',
                    rowCount: 0,
                    keyFields: [],
                    executionTimeMs: 0,
                    generatedSql: options.includeSql ? rawSql : undefined,
                    data: [],
                    graph: { nodes: [], edges: [] },
                    explanation: buildExplanation(naturalLanguageQuery, rawSql),
                    confidence: 0.3,
                    confidenceLabel: 'Low',
                    confidenceReasons: ['Valid SQL generated', 'Referenced customer not found in dataset'],
                    executionPlan: 'LLM',
                    queryPlan: buildQueryPlan(rawSql, buildExplanation(naturalLanguageQuery, rawSql))
                };
            }
            console.log(`${tag} [VALIDATION] Customer '${extractedCustId}' exists.`);
        }

        // 5. Execute against SQLite with execution timeout
        let dbResult = await withTimeout(executeQuery(rawSql, [], dbInstance), 5000, 'Database Execution');

        if (!dbResult.success) {
             console.error(`${tag} [EXECUTION] DB error:`, dbResult.error);
             return {
                 success: false,
                 dataset: activeConfig.name,
                 error: { message: dbResult.error, type: 'DB_ERROR' },
                 query: naturalLanguageQuery
             };
        }

        // NEW: Fallback join relaxation (silent retry)
        let fallbackApplied = false;

        if (dbResult.rowCount === 0) {
            const upSql = rawSql.toUpperCase();
            const hasAggregations = upSql.includes('GROUP BY') || /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(rawSql);
            const isGapQuery = /IS\s+NULL/i.test(rawSql);

            // Build relaxation table list from config
            const relaxationTables = activeConfig.name === 'sap_o2c'
                ? ['outbound_delivery_items', 'outbound_delivery_headers', 'billing_document_items', 'billing_document_headers', 'sales_order_items', 'payments_accounts_receivable', 'journal_entry_items_accounts_receivable']
                : activeConfig.tables.map(t => t.name);
            const hasFlowTables = relaxationTables.some(t => upSql.includes(t.toUpperCase()));

            if (!hasFlowTables) {
                console.log(`${tag} [FALLBACK_USED] Skipped — non-flow query.`);
            } else if (hasAggregations) {
                console.log(`${tag} [FALLBACK_USED] Skipped — aggregation query.`);
            } else if (isGapQuery) {
                console.log(`${tag} [FALLBACK_USED] Skipped — gap analysis query (IS NULL).`);
            } else if (rawSql.match(/\bJOIN\b/gi)) {
                console.log(`${tag} [FALLBACK_USED] Zero rows — triggering LEFT JOIN relaxation...`);

                let relaxedSql = rawSql;
                // Build regex from relaxation table list
                const tablePattern = relaxationTables.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
                const innerJoinRegex = new RegExp(`\\bINNER\\s+JOIN\\s+(${tablePattern})\\b`, 'gi');
                const joinRegex = new RegExp(`\\bJOIN\\s+(${tablePattern})\\b`, 'gi');

                relaxedSql = relaxedSql.replace(innerJoinRegex, 'JOIN $1');
                relaxedSql = relaxedSql.replace(joinRegex, 'LEFT JOIN $1');

                // Clean up accidental overwrites
                relaxedSql = relaxedSql.replace(/\bLEFT\s+LEFT\s+JOIN\b/gi, 'LEFT JOIN');
                relaxedSql = relaxedSql.replace(/\bRIGHT\s+LEFT\s+JOIN\b/gi, 'RIGHT JOIN');

                if (!/SELECT\s+DISTINCT/i.test(relaxedSql)) {
                    relaxedSql = relaxedSql.replace(/^\s*SELECT/i, 'SELECT DISTINCT');
                }

                if (!/LIMIT\s+\d+/i.test(relaxedSql)) {
                    relaxedSql += ' LIMIT 100';
                }

                const relaxedDbResult = await withTimeout(executeQuery(relaxedSql, [], dbInstance), 5000, 'Database Execution Fallback');
                if (relaxedDbResult.success && relaxedDbResult.rowCount > 0) {
                    console.log(`${tag} [FALLBACK_USED] Success — ${relaxedDbResult.rowCount} rows recovered via relaxed joins.`);
                    dbResult = relaxedDbResult;
                    rawSql = relaxedSql;
                    fallbackApplied = true;
                }
            }
        }

        console.log(`${tag} [EXECUTION] ${dbResult.rowCount} rows fetched in ${dbResult.executionTimeMs}ms`);

        // Clarify zero rows explicitly (if it STILL is 0 after fallback)
        if (dbResult.rowCount === 0) {
            console.log(`${tag} [RESULT] Zero rows after all fallback attempts.`);

            const zeroExplanation = buildExplanation(naturalLanguageQuery, rawSql);
            const isGapIntent = zeroExplanation.intent === 'gap-analysis';
            const isTraceIntent = zeroExplanation.intent === 'trace';

            // Semantic zero-result classification
            let resultStatus, emptySummary, reason;
            if (explicitCustChecked) {
                resultStatus = 'NO_MATCH';
                reason = 'INVALID_ID';
                emptySummary = `No records found for customer '${extractedCustId}' in the dataset.`;
            } else if (isGapIntent) {
                resultStatus = 'NO_GAPS_FOUND';
                reason = 'NO_GAPS';
                emptySummary = 'No gaps detected — all records have complete linked flows.';
            } else if (explicitIdChecked || isTraceIntent) {
                resultStatus = 'INCOMPLETE_FLOW';
                reason = 'INCOMPLETE_FLOW';
                emptySummary = explicitIdChecked
                    ? `The document was found, but no connected flow traversing downstream stages exists.`
                    : `The query executed but the expected document flow is incomplete or missing stages.`;
            } else {
                resultStatus = 'NO_MATCH';
                reason = 'NO_DATA';
                emptySummary = `The query executed correctly, but no matching records were found.`;
            }

            const zeroConfidence = calculateConfidence({
                queryType, fallbackApplied, rowCount: 0, isAggregation: false
            });

            return {
                success: true,
                dataset: activeConfig.name,
                queryType,
                summary: emptySummary,
                resultStatus,
                reason,
                message: emptySummary,
                rowCount: 0,
                keyFields: [],
                executionTimeMs: Number(dbResult.executionTimeMs),
                generatedSql: options.includeSql ? rawSql : undefined,
                data: [],
                graph: { nodes: [], edges: [] },
                explanation: zeroExplanation,
                confidence: zeroConfidence.score,
                confidenceLabel: zeroConfidence.label,
                confidenceReasons: zeroConfidence.reasons,
                executionPlan: fallbackApplied ? 'FALLBACK' : 'LLM',
                queryPlan: buildQueryPlan(rawSql, zeroExplanation)
            };
        }

        // 5.5. For HYBRID queries, retrieve business context to enrich the NL answer.
        // null is handled gracefully by generateNLAnswer — no degradation on KB miss.
        let ragContext = null;
        if (queryType === 'HYBRID') {
            ragContext = await retrieveContext(naturalLanguageQuery, dbInstance);
            console.log(`${tag} [QUERY_TYPE] HYBRID — KB context ${ragContext ? 'found' : 'not found, proceeding with SQL only'}.`);
        }

        // 5.6. Generate Natural Language Answer from results
        let nlAnswer = null;
        try {
            nlAnswer = await withTimeout(
                generateNLAnswer(naturalLanguageQuery, dbResult.rows, dbResult.rowCount, ragContext, complexity, activeConfig.displayName || activeConfig.name),
                50000,
                'NL Answer Generation'
            );
            console.log(`${tag} [RESULT] NL answer generated.`);
        } catch (nlErr) {
            console.warn(`${tag} [RESULT] NL answer generation failed: ${nlErr.message}`);
        }

        // 5.7. Detect Aggregation Queries (CRITICAL UI CONTROL)
        // Use regex to handle optional spaces before parens: COUNT(...), COUNT (...), etc.
        const isAggregation = /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(rawSql) ||
                              /\bGROUP\s+BY\b/i.test(rawSql) ||
                              /\bHAVING\b/i.test(rawSql);
        
        let finalResponse;

        if (isAggregation) {
            console.log(`${tag} [INTERPRETATION] Aggregation query detected — summarized nodes.`);
            
            // Build simple nodes without relationships
            const aggNodes = dbResult.rows.map((row, i) => {
                const keys = Object.keys(row);

                if (keys.length === 0) {
                    return { id: `agg_node_${i}`, label: 'Empty', type: 'Aggregation', properties: row };
                }

                if (keys.length === 1) {
                    const metricKey = keys[0];
                    return {
                        id: `agg_node_${i}`,
                        label: `Total ${metricKey}: ${row[metricKey]}`,
                        type: 'Aggregation',
                        properties: row
                    };
                }

                // Assume last column or one matching SUM/COUNT/TOTAL is the aggregated value
                const aggKey = keys.find(k => k.match(/SUM|COUNT|AVG|MIN|MAX|amount|total/i)) || keys[keys.length - 1];
                const entityKey = keys.find(k => k !== aggKey) || keys[0];

                let nodeType = 'Aggregation';
                const lowerEntity = entityKey.toLowerCase();
                
                if (lowerEntity.includes('customer') || lowerEntity.includes('partner') || lowerEntity.includes('soldtoparty')) {
                    nodeType = 'Customer';
                } else if (lowerEntity.includes('company')) {
                    nodeType = 'Company';
                } else if (lowerEntity.includes('plant')) {
                    nodeType = 'Plant';
                } else if (lowerEntity.includes('material') || lowerEntity.includes('product')) {
                    nodeType = 'Product';
                } else if (lowerEntity.includes('document') || lowerEntity.includes('order')) {
                    nodeType = 'Document';
                } else {
                    nodeType = entityKey.charAt(0).toUpperCase() + entityKey.slice(1);
                }

                const labelStr = `${nodeType} ${row[entityKey]} (${aggKey}: ${row[aggKey]})`;

                return {
                    id: `agg_node_${i}`,
                    label: labelStr,
                    type: nodeType,
                    properties: row
                };
            });

            finalResponse = {
                success: true,
                nlAnswer: nlAnswer,
                summary: nlAnswer || "This query returns aggregated results. Showing summarized nodes instead of relationships.",
                reason: 'AGGREGATION',
                complexity,
                rowCount: dbResult.rowCount,
                keyFields: dbResult.rows.length > 0 ? Object.keys(dbResult.rows[0]) : [],
                executionTimeMs: Number(dbResult.executionTimeMs),
                generatedSql: rawSql,
                data: dbResult.rows,
                graph: { nodes: aggNodes, edges: [] },
                highlightNodes: extractHighlightNodes(rawSql)
            };
        } else {
            // 6. Format structurally backed result natively tracking edges
            finalResponse = formatResponse(dbResult, rawSql);
            finalResponse.nlAnswer = nlAnswer;
            if (nlAnswer) {
                finalResponse.summary = nlAnswer;
            }
        }
        if (fallbackApplied) {
            finalResponse.fallbackApplied = true;
            if (!nlAnswer) {
                if (explicitCustChecked) {
                    finalResponse.summary = `Partial flow found for customer '${extractedCustId}' — some stages (delivery, billing, or payment) are missing.`;
                } else {
                    finalResponse.summary = "Partial flow recovered using relaxed joins";
                }
            }
        }

        // 7. Attach explanation, confidence, queryType to all SQL/HYBRID responses
        finalResponse.explanation = buildExplanation(naturalLanguageQuery, rawSql);
        const confidenceResult = calculateConfidence({
            queryType,
            fallbackApplied: finalResponse.fallbackApplied || false,
            rowCount: finalResponse.rowCount || 0,
            isAggregation: finalResponse.reason === 'AGGREGATION',
        });
        finalResponse.confidence = confidenceResult.score;
        finalResponse.confidenceLabel = confidenceResult.label;
        finalResponse.confidenceReasons = confidenceResult.reasons;
        finalResponse.queryType = queryType; // "SQL" or "HYBRID"
        finalResponse.dataset = activeConfig.name;
        finalResponse.executionPlan = fallbackApplied ? 'FALLBACK' : 'LLM';
        finalResponse.queryPlan = buildQueryPlan(rawSql, finalResponse.explanation);
        finalResponse.complexity = complexity;

        // Strip SQL from response unless caller explicitly requested it
        if (!options.includeSql) {
            delete finalResponse.generatedSql;
        }

        // Structured interpretation log
        console.log(`${tag} [INTERPRETATION] intent=${finalResponse.explanation.intent} | entities=${finalResponse.explanation.entities.join(', ') || 'none'} | strategy=${finalResponse.explanation.strategy}`);

        // Final result summary
        console.log(`${tag} [RESULT] rowCount=${finalResponse.rowCount} | confidence=${finalResponse.confidence} | execTime=${finalResponse.executionTimeMs}ms${fallbackApplied ? ' | fallback=true' : ''}`);

        // Cache successful responses only
        if (finalResponse.success) setCached(naturalLanguageQuery, options.includeSql, finalResponse, tenantId, activeConfig);

        return finalResponse;

    } catch (e) {
         console.error(`${tag} [EXECUTION] Pipeline failure: ${e.message}`);
         return {
             success: false,
             dataset: activeConfig.name,
             error: { message: e.message, type: 'EXECUTION_ERROR' },
             query: naturalLanguageQuery
         };
    }
}

// ----------------------------------------------------
// Local testing execution (when run via `node src/query/queryService.js`)
// ----------------------------------------------------

async function runTests() {
    const testQueries = [
         "Show orders not billed",
         "Show full flow for a billing document 90504248",
         "Top customers by billing amount",
         "What is the capital of France?" // Test Guardrail
    ];

    for (const q of testQueries) {
         const result = await processQuery(q);
         if (result.error) {
             console.log(`Result: ${result.error}`);
         } else {
             console.log(`Summary: ${result.summary}`);
             console.log(`Key Fields: ${result.keyFields.join(', ')}`);
             if (result.rowCount > 0 && result.rowCount <= 5) {
                console.log(`Data Snapshot:`, result.data.slice(0, 3));
             }
         }
         console.log('-'.repeat(50));
    }
}

if (require.main === module) {
    runTests().catch(err => {
         console.error("Test execution failed:", err);
         process.exit(1);
    });
}

/**
 * Clears the response cache. Called on dataset switch to prevent stale results.
 */
function clearCache(tenantId = null) {
    if (!tenantId) {
        responseCache.clear();
        console.log('[CACHE] Response cache cleared (all tenants).');
    } else {
        const prefix = `${tenantId}:`;
        let cleared = 0;
        for (const key of responseCache.keys()) {
            if (key.startsWith(prefix)) {
                responseCache.delete(key);
                cleared++;
            }
        }
        console.log(`[CACHE] Cleared ${cleared} cached entries for tenant: ${tenantId}`);
    }
}

module.exports = {
    processQuery,
    clearCache,
    isDomainQuery // Exported for unit testing
};
