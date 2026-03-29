const { buildPrompt } = require('./promptBuilder');
const { getSqlFromLLM, generateNLAnswer } = require('./llmClient');
const { validateSql } = require('./validator');
const { executeQuery } = require('./sqlExecutor');
const { extractGraph } = require('./graphExtractor');
const { classifyQuery } = require('./queryClassifier');
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

function cacheKey(query, includeSql) {
    const config = getActiveConfig();
    const dsKey = `${config.name}:${config.version || 'default'}`;
    return `${dsKey}:${normalizeQuery(query)}${includeSql ? ':sql' : ''}`;
}

function getCached(query, includeSql) {
    const key = cacheKey(query, includeSql);
    const entry = responseCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
        responseCache.delete(key);
        return null;
    }
    return entry.response;
}

function setCached(query, includeSql, response) {
    const key = cacheKey(query, includeSql);
    if (responseCache.size >= MAX_CACHE_SIZE) {
        const oldestKey = responseCache.keys().next().value;
        responseCache.delete(oldestKey);
    }
    responseCache.set(key, { response, timestamp: Date.now() });
}

/**
 * Validates domain safety before spending API tokens
 * Rejects questions wildly outside the SAP O2C domain
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
    const highlights = [];
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
    const graphData = extractGraph(finalRows);

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
    const tableEntityMap = [
        { table: 'sales_order_headers',                       entity: 'sales order' },
        { table: 'outbound_delivery',                         entity: 'delivery' },
        { table: 'billing_document',                          entity: 'billing' },
        { table: 'journal_entry_items_accounts_receivable',   entity: 'journal entry' },
        { table: 'payments_accounts_receivable',              entity: 'payment' },
        { table: 'business_partners',                         entity: 'business partner' },
    ];
    const entitiesFromSql = tableEntityMap
        .filter(m => sqlLower.includes(m.table))
        .map(m => m.entity);

    // Merge, deduplicate, preserve order (query-mentioned first)
    const entities = [...new Set([...entitiesFromQuery, ...entitiesFromSql])];

    // Determine strategy from intent and SQL shape
    let strategy = 'lookup with filters';
    if (intent === 'trace') strategy = 'multi-hop join across O2C flow';
    else if (intent === 'aggregation') strategy = 'aggregation query with GROUP BY';
    else if (intent === 'gap-analysis') strategy = 'gap detection using LEFT JOIN with NULL check';
    else if (sql && /JOIN/i.test(sql)) strategy = 'multi-table join query';

    // Build a plain-English explanation of what the system did
    const entityLabel = entities.length > 0 ? entities.join(', ') : 'O2C data';
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
 * Orchestrates the full Natural Language -> SQL -> Result pipeline
 */
async function processQuery(naturalLanguageQuery, requestId = 'dev-local', options = {}) {
    const tag = `[API-${requestId}]`;
    console.log(`\n${tag} [USER_QUERY] "${naturalLanguageQuery}"`);

    // 0a. Cache check — skip LLM entirely for repeated identical queries
    const cached = getCached(naturalLanguageQuery, options.includeSql);
    if (cached) {
        console.log(`${tag} [CACHE_HIT] Returning cached response.`);
        return cached;
    }

    // 0b. Classify query type — HYBRID checked before RAG to avoid misrouting
    const queryType = classifyQuery(naturalLanguageQuery);
    console.log(`${tag} [QUERY_TYPE] ${queryType}`);

    // INVALID path: query has no O2C domain relevance
    if (queryType === 'INVALID') {
        console.warn(`${tag} [VALIDATION] Domain check failed at classifier — no O2C keywords found.`);
        return {
            success: false,
            dataset: getActiveConfig().name,
            error: { message: 'This system is designed to answer questions related to the SAP Order-to-Cash dataset only.', type: 'VALIDATION_ERROR' },
            query: naturalLanguageQuery
        };
    }

    // RAG path: explanation-only, no SQL execution needed
    if (queryType === 'RAG') {
        // Guard: reject off-topic RAG queries that contain no O2C domain keywords
        const ragDomainCheck = isDomainQuery(naturalLanguageQuery);
        if (!ragDomainCheck.valid) {
            console.warn(`${tag} [VALIDATION] RAG domain check failed — off-topic query blocked.`);
            return {
                success: false,
                dataset: getActiveConfig().name,
                error: { message: ragDomainCheck.message, type: 'VALIDATION_ERROR' },
                query: naturalLanguageQuery
            };
        }
        const context = retrieveContext(naturalLanguageQuery);
        console.log(`${tag} [RESULT] RAG response dispatched (rowCount: 0).`);
        return {
            success: true,
            dataset: getActiveConfig().name,
            queryType: 'RAG',
            reason: 'RAG_RESPONSE',
            nlAnswer: context || 'No specific context found for this topic in the O2C knowledge base.',
            rowCount: 0,
            data: [],
            graph: { nodes: [], edges: [] },
            highlightNodes: [],
            summary: 'Explanation retrieved from knowledge base.',
            confidence: 1.0,
            confidenceLabel: 'High',
            confidenceReasons: ['Direct knowledge base lookup'],
            queryPlan: 'RULE_BASED',
            explanation: {
                intent: 'concept explanation',
                entities: [],
                strategy: 'knowledge retrieval',
            },
        };
    }

    // 1. Guardrails
    const intentCheck = isIntentValid(naturalLanguageQuery);
    if (!intentCheck.valid) {
        console.warn(`${tag} [VALIDATION] Intent check failed — no recognized business action.`);
        return {
            success: false,
            dataset: getActiveConfig().name,
            error: { message: intentCheck.message, type: 'VALIDATION_ERROR' },
            query: naturalLanguageQuery
        };
    }

    const domainCheck = isDomainQuery(naturalLanguageQuery);
    if (!domainCheck.valid) {
        console.warn(`${tag} [VALIDATION] Domain check failed — query outside O2C scope.`);
        return {
            success: false,
            dataset: getActiveConfig().name,
            error: { message: domainCheck.message, type: 'VALIDATION_ERROR' },
            query: naturalLanguageQuery
        };
    }
    
    // 2. Build Prompt
    const prompt = buildPrompt(naturalLanguageQuery);

    // 3. Generate SQL from LLM with timeout protection
    let rawSql = null;
    let llmFailed = false;

    try {
        const generatedSql = await withTimeout(getSqlFromLLM(prompt), 45000, 'LLM Generation');
        rawSql = enforceLimit(generatedSql);
        console.log(`${tag} [SQL_GENERATED]\n${rawSql}`);
        validateSql(rawSql);
        console.log(`${tag} [VALIDATION] SQL passed safety checks.`);
    } catch (llmErr) {
        console.error(`${tag} [LLM_FALLBACK] LLM/validation failed: ${llmErr.message}`);
        llmFailed = true;
    }

    if (llmFailed) {
        const fallbackResponse = {
            success: true,
            dataset: getActiveConfig().name,
            queryType: 'FALLBACK',
            summary: 'Unable to process your query due to an AI service issue. Please try again shortly.',
            reason: 'LLM_UNAVAILABLE',
            message: 'The AI service is temporarily unavailable.',
            rowCount: 0,
            keyFields: [],
            data: [],
            graph: { nodes: [], edges: [] },
            highlightNodes: [],
            explanation: {
                intent: 'unknown',
                entities: [],
                strategy: 'LLM failed, fallback response',
                explanationText: 'Unable to process query due to AI service issue.'
            },
            confidence: 0.2,
            confidenceLabel: 'Low',
            confidenceReasons: ['LLM unavailable — both Groq and OpenRouter failed'],
            queryPlan: 'FALLBACK',
            nlAnswer: null
        };
        setCached(naturalLanguageQuery, options.includeSql, fallbackResponse);
        return fallbackResponse;
    }

    try {

        // 4.5. Existence checks for referenced document IDs
        let explicitIdChecked = false;
        let explicitCustChecked = false;
        let extractedCustId = null;

        const idChecks = [
            { regex: /billingDocument\s*(?:=|LIKE)\s*['"]?(\d+)['"]?/i, table: 'billing_document_headers', column: 'billingDocument', label: 'Billing document' },
            { regex: /(?:soh\.|sales_order_headers\.)?\bsalesOrder\s*(?:=|LIKE)\s*['"]?(\d+)['"]?/i, table: 'sales_order_headers', column: 'salesOrder', label: 'Sales order' },
            { regex: /deliveryDocument\s*(?:=|LIKE)\s*['"]?(\d+)['"]?/i, table: 'outbound_delivery_headers', column: 'deliveryDocument', label: 'Delivery document' }
        ];

        for (const check of idChecks) {
            const match = rawSql.match(check.regex);
            if (match && match[1]) {
                const extractedId = match[1];
                explicitIdChecked = true;
                console.log(`${tag} [VALIDATION] Checking existence of ${check.label} '${extractedId}'...`);
                
                const checkResult = await withTimeout(
                    executeQuery(`SELECT ${check.column} FROM ${check.table} WHERE ${check.column} = ? LIMIT 1`, [extractedId]),
                    2000, 'DB Existence Check'
                );
                
                if (checkResult.success && checkResult.rowCount === 0) {
                    console.log(`${tag} [VALIDATION] Invalid ${check.label} ID: ${extractedId}`);
                    const sampleResult = await withTimeout(
                        executeQuery(`SELECT ${check.column} FROM ${check.table} ORDER BY RANDOM() LIMIT 5`),
                        2000, 'DB Samples Fetch'
                    );
                    const suggestions = sampleResult.success ? sampleResult.rows.map(r => r[check.column]) : [];
                    
                    return {
                        success: true,
                        dataset: getActiveConfig().name,
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
                        queryPlan: 'LLM'
                    };
                }
                console.log(`${tag} [VALIDATION] ${check.label} '${extractedId}' exists.`);
                break; // Only check the first matched ID type
            }
        }

        // 4.6. Check if specific customer exists in DB
        const custMatch = rawSql.match(/(?:soldToParty|\.customer)\s*(?:=|LIKE)\s*['"]?(\d+)['"]?/i);

        if (custMatch && custMatch[1]) {
            extractedCustId = custMatch[1];
            explicitCustChecked = true;
            console.log(`${tag} [VALIDATION] Checking existence of customer '${extractedCustId}'...`);

            const custCheckResult = await withTimeout(
                executeQuery(`SELECT salesOrder FROM sales_order_headers WHERE soldToParty = ? LIMIT 1`, [extractedCustId]),
                2000, 'DB Customer Check'
            );

            if (custCheckResult.success && custCheckResult.rowCount === 0) {
                console.log(`${tag} [VALIDATION] No records for customer '${extractedCustId}'.`);
                return {
                    success: true,
                    dataset: getActiveConfig().name,
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
                    queryPlan: 'LLM'
                };
            }
            console.log(`${tag} [VALIDATION] Customer '${extractedCustId}' exists.`);
        }

        // 5. Execute against SQLite with execution timeout
        let dbResult = await withTimeout(executeQuery(rawSql), 5000, 'Database Execution');

        if (!dbResult.success) {
             console.error(`${tag} [EXECUTION] DB error:`, dbResult.error);
             return {
                 success: false,
                 dataset: getActiveConfig().name,
                 error: { message: dbResult.error, type: 'DB_ERROR' },
                 query: naturalLanguageQuery
             };
        }

        // NEW: Fallback join relaxation (silent retry)
        let fallbackApplied = false;

        if (dbResult.rowCount === 0) {
            const upSql = rawSql.toUpperCase();
            const hasFlowTables = upSql.includes('SALES_ORDER') || upSql.includes('OUTBOUND_DELIVERY') || upSql.includes('BILLING_DOCUMENT');
            const hasAggregations = upSql.includes('GROUP BY') || /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(rawSql);
            const isGapQuery = /IS\s+NULL/i.test(rawSql);

            if (!hasFlowTables) {
                console.log(`${tag} [FALLBACK_USED] Skipped — non-flow query.`);
            } else if (hasAggregations) {
                console.log(`${tag} [FALLBACK_USED] Skipped — aggregation query.`);
            } else if (isGapQuery) {
                console.log(`${tag} [FALLBACK_USED] Skipped — gap analysis query (IS NULL).`);
            } else if (rawSql.match(/\bJOIN\b/gi)) {
                console.log(`${tag} [FALLBACK_USED] Zero rows — triggering LEFT JOIN relaxation...`);
                
                let relaxedSql = rawSql;
                // Target explicitly safe mapping pipelines natively
                relaxedSql = relaxedSql.replace(/\bINNER\s+JOIN\s+(outbound_delivery_items|outbound_delivery_headers|billing_document_items|billing_document_headers|sales_order_items|payments_accounts_receivable|journal_entry_items_accounts_receivable)\b/gi, 'JOIN $1');
                relaxedSql = relaxedSql.replace(/\bJOIN\s+(outbound_delivery_items|outbound_delivery_headers|billing_document_items|billing_document_headers|sales_order_items|payments_accounts_receivable|journal_entry_items_accounts_receivable)\b/gi, 'LEFT JOIN $1');
                
                // Clean up accidental overwrites logically
                relaxedSql = relaxedSql.replace(/\bLEFT\s+LEFT\s+JOIN\b/gi, 'LEFT JOIN');
                relaxedSql = relaxedSql.replace(/\bRIGHT\s+LEFT\s+JOIN\b/gi, 'RIGHT JOIN');

                if (!/SELECT\s+DISTINCT/i.test(relaxedSql)) {
                    relaxedSql = relaxedSql.replace(/^\s*SELECT/i, 'SELECT DISTINCT');
                }

                if (!/LIMIT\s+\d+/i.test(relaxedSql)) {
                    relaxedSql += ' LIMIT 100';
                }

                const relaxedDbResult = await withTimeout(executeQuery(relaxedSql), 5000, 'Database Execution Fallback');
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
            let emptySummary;
            if (explicitCustChecked) {
                emptySummary = `No records found for customer '${extractedCustId}' in the dataset.`;
            } else if (explicitIdChecked) {
                emptySummary = `The document was found, but no connected flow traversing outbound nodes exists.`;
            } else {
                emptySummary = `The query executed correctly, but no matching connected records were found.`;
            }

            const zeroExplanation = buildExplanation(naturalLanguageQuery, rawSql);
            const zeroConfidence = calculateConfidence({
                queryType, fallbackApplied, rowCount: 0, isAggregation: false
            });

            return {
                success: true,
                dataset: getActiveConfig().name,
                queryType,
                summary: emptySummary,
                reason: 'NO_FLOW',
                message: 'No records found for the given query.',
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
                queryPlan: fallbackApplied ? 'FALLBACK' : 'LLM'
            };
        }

        // 5.5. For HYBRID queries, retrieve business context to enrich the NL answer.
        // null is handled gracefully by generateNLAnswer — no degradation on KB miss.
        let ragContext = null;
        if (queryType === 'HYBRID') {
            ragContext = retrieveContext(naturalLanguageQuery);
            console.log(`${tag} [QUERY_TYPE] HYBRID — KB context ${ragContext ? 'found' : 'not found, proceeding with SQL only'}.`);
        }

        // 5.6. Generate Natural Language Answer from results
        let nlAnswer = null;
        try {
            nlAnswer = await withTimeout(
                generateNLAnswer(naturalLanguageQuery, dbResult.rows, dbResult.rowCount, ragContext),
                45000,
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
        finalResponse.dataset = getActiveConfig().name;
        finalResponse.queryPlan = fallbackApplied ? 'FALLBACK' : 'LLM';

        // Strip SQL from response unless caller explicitly requested it
        if (!options.includeSql) {
            delete finalResponse.generatedSql;
        }

        // Structured interpretation log
        console.log(`${tag} [INTERPRETATION] intent=${finalResponse.explanation.intent} | entities=${finalResponse.explanation.entities.join(', ') || 'none'} | strategy=${finalResponse.explanation.strategy}`);

        // Final result summary
        console.log(`${tag} [RESULT] rowCount=${finalResponse.rowCount} | confidence=${finalResponse.confidence} | execTime=${finalResponse.executionTimeMs}ms${fallbackApplied ? ' | fallback=true' : ''}`);

        // Cache successful responses only
        if (finalResponse.success) setCached(naturalLanguageQuery, options.includeSql, finalResponse);

        return finalResponse;

    } catch (e) {
         console.error(`${tag} [EXECUTION] Pipeline failure: ${e.message}`);
         return {
             success: false,
             dataset: getActiveConfig().name,
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
function clearCache() {
    responseCache.clear();
    console.log('[CACHE] Response cache cleared.');
}

module.exports = {
    processQuery,
    clearCache,
    isDomainQuery // Exported for unit testing
};
