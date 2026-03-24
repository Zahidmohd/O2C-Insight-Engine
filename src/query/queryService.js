const { buildPrompt } = require('./promptBuilder');
const { getSqlFromLLM, generateNLAnswer } = require('./llmClient');
const { validateSql } = require('./validator');
const { executeQuery } = require('./sqlExecutor');
const { extractGraph } = require('./graphExtractor');

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
        'who', 'where', 'when', 'many', 'much'
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
    
    // Improved Domain Guardrail List
    const mandatoryDomainKeywords = [
        'order', 'sales', 'delivery', 'bill', 'invoice', 
        'journal', 'payment', 'customer', 'product', 'plant',
        'document', 'item', 'amount', 'clearing', 'flow',
        'company', 'fiscal', 'accounting', 'partner',
        'trace', 'material', 'address', 'status', 'cancelled',
        'billed', 'delivered', 'posted', 'cleared', 'entry',
        'shipping', 'quantity', 'currency', 'net', 'total',
        'o2c', 'sap', 'transaction', 'record', 'data'
    ];
    
    // Check if query contains at least one domain keyword
    const matchedKeywords = mandatoryDomainKeywords.filter(kw => queryLower.includes(kw));

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
        graph: graphData,
        highlightNodes: highlightNodes
    };
}

/**
 * Orchestrates the full Natural Language -> SQL -> Result pipeline
 */
async function processQuery(naturalLanguageQuery, requestId = 'dev-local') {
    console.log(`\n[API-${requestId}] Query Service Evaluation: "${naturalLanguageQuery}"`);

    // 1. Guardrails
    const intentCheck = isIntentValid(naturalLanguageQuery);
    if (!intentCheck.valid) {
        console.warn(`[API-${requestId}] Intent Check Failed: Missing Business Action`);
        return {
            success: false,
            error: { message: intentCheck.message, type: 'VALIDATION_ERROR' },
            query: naturalLanguageQuery
        };
    }

    const domainCheck = isDomainQuery(naturalLanguageQuery);
    if (!domainCheck.valid) {
        console.warn(`[API-${requestId}] Domain Check Failed / Guardrail Prevented Engine Spawn`);
        return {
            success: false,
            error: { message: domainCheck.message, type: 'VALIDATION_ERROR' },
            query: naturalLanguageQuery
        };
    }
    
    // 2. Build Prompt
    const prompt = buildPrompt(naturalLanguageQuery);

    try {
        // 3. Generate SQL from LLM with timeout protection
        const generatedSql = await withTimeout(getSqlFromLLM(prompt), 15000, 'LLM Generation');
        
        // Ensure LIMIT 100 explicitly
        let rawSql = enforceLimit(generatedSql);
        
        console.log(`[API-${requestId}] Engine Generated SQL:\n${rawSql}\n`);

        // 4. Validate output
        validateSql(rawSql); // Throws Error if unsafe

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
                console.log(`[API-${requestId}] Check: Testing existence of ${check.label} '${extractedId}'...`);
                
                const checkResult = await withTimeout(
                    executeQuery(`SELECT ${check.column} FROM ${check.table} WHERE ${check.column} = '${extractedId}' LIMIT 1`),
                    2000, 'DB Existence Check'
                );
                
                if (checkResult.success && checkResult.rowCount === 0) {
                    console.log(`[API-${requestId}] Check: Invalid ${check.label} ID: ${extractedId}`);
                    const sampleResult = await withTimeout(
                        executeQuery(`SELECT ${check.column} FROM ${check.table} ORDER BY RANDOM() LIMIT 5`),
                        2000, 'DB Samples Fetch'
                    );
                    const suggestions = sampleResult.success ? sampleResult.rows.map(r => r[check.column]) : [];
                    
                    return {
                        success: true,
                        summary: `${check.label} '${extractedId}' was not found in the dataset.`,
                        reason: 'INVALID_ID',
                        suggestions: suggestions,
                        rowCount: 0,
                        keyFields: [],
                        executionTimeMs: 0,
                        generatedSql: rawSql,
                        data: [],
                        graph: { nodes: [], edges: [] }
                    };
                }
                console.log(`[API-${requestId}] Check: ${check.label} '${extractedId}' exists. Proceeding.`);
                break; // Only check the first matched ID type
            }
        }

        // 4.6. Check if specific customer exists in DB
        const custMatch = rawSql.match(/soldToParty\s*(?:=|LIKE)\s*['"]?(\d+)['"]?/i);

        if (custMatch && custMatch[1]) {
            extractedCustId = custMatch[1];
            explicitCustChecked = true;
            console.log(`[API-${requestId}] Check: Testing existence of customer '${extractedCustId}'...`);

            const custCheckResult = await withTimeout(
                executeQuery(`SELECT salesOrder FROM sales_order_headers WHERE soldToParty = '${extractedCustId}' LIMIT 1`),
                2000, 'DB Customer Check'
            );

            if (custCheckResult.success && custCheckResult.rowCount === 0) {
                console.log(`[API-${requestId}] Check: No records for customer '${extractedCustId}'.`);
                return {
                    success: true,
                    summary: `No records found for customer '${extractedCustId}' in the dataset.`,
                    reason: 'INVALID_ID',
                    rowCount: 0,
                    keyFields: [],
                    executionTimeMs: 0,
                    generatedSql: rawSql,
                    data: [],
                    graph: { nodes: [], edges: [] }
                };
            }
            console.log(`[API-${requestId}] Check: Customer '${extractedCustId}' exists. Proceeding.`);
        }

        // 5. Execute against SQLite with execution timeout
        let dbResult = await withTimeout(executeQuery(rawSql), 5000, 'Database Execution');

        if (!dbResult.success) {
             console.error(`[API-${requestId}] execution evaluation Error boundary trigger:`, dbResult.error);
             return { 
                 success: false, 
                 error: { message: dbResult.error, type: 'DB_ERROR' }, 
                 query: naturalLanguageQuery 
             };
        }

        // NEW: Fallback join relaxation (silent retry)
        let fallbackApplied = false;

        if (dbResult.rowCount === 0) {
            const upSql = rawSql.toUpperCase();
            const hasFlowTables = upSql.includes('SALES_ORDER') || upSql.includes('OUTBOUND_DELIVERY') || upSql.includes('BILLING_DOCUMENT');
            const hasAggregations = upSql.includes('GROUP BY') || upSql.includes('COUNT(') || upSql.includes('SUM(');

            if (!hasFlowTables) {
                console.log(`[API-${requestId}] Check: Fallback skipped (non-flow query)`);
            } else if (hasAggregations) {
                console.log(`[API-${requestId}] Check: Fallback skipped (aggregation query)`);
            } else if (rawSql.match(/\bJOIN\b/gi)) {
                console.log(`[API-${requestId}] Check: Zero rows returned. Fallback triggered (Targeted LEFT JOIN)...`);
                
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
                    console.log(`[API-${requestId}] Check: Fallback successful! Fetched ${relaxedDbResult.rowCount} rows via relaxed boundary graphs.`);
                    dbResult = relaxedDbResult;
                    rawSql = relaxedSql;
                    fallbackApplied = true;
                }
            }
        }

        console.log(`[API-${requestId}] Success bounds: ${dbResult.rowCount} payload fetched in ${dbResult.executionTimeMs}ms`);

        // Clarify zero rows explicitly (if it STILL is 0 after fallback)
        if (dbResult.rowCount === 0) {
            console.log(`[API-${requestId}] Check: Zero rows returned after fallback routines.`);
            let emptySummary;
            if (explicitCustChecked) {
                emptySummary = `No records found for customer '${extractedCustId}' in the dataset.`;
            } else if (explicitIdChecked) {
                emptySummary = `The document was found, but no connected flow traversing outbound nodes exists.`;
            } else {
                emptySummary = `The query executed correctly, but no matching connected records were found.`;
            }

            return {
                success: true,
                summary: emptySummary,
                reason: 'NO_FLOW',
                rowCount: 0,
                keyFields: [],
                executionTimeMs: Number(dbResult.executionTimeMs),
                generatedSql: rawSql,
                data: [],
                graph: { nodes: [], edges: [] }
            };
        }

        // 5.5. Generate Natural Language Answer from results
        let nlAnswer = null;
        try {
            nlAnswer = await withTimeout(
                generateNLAnswer(naturalLanguageQuery, dbResult.rows, dbResult.rowCount),
                20000,
                'NL Answer Generation'
            );
            console.log(`[API-${requestId}] NL Answer: ${nlAnswer}`);
        } catch (nlErr) {
            console.warn(`[API-${requestId}] NL answer generation failed:`, nlErr.message);
        }

        // 5.6. Detect Aggregation Queries (CRITICAL UI CONTROL)
        const upperSql = rawSql.toUpperCase();
        const isAggregation = upperSql.includes('COUNT(') || 
                              upperSql.includes('SUM(') || 
                              upperSql.includes('AVG(') || 
                              upperSql.includes('MIN(') || 
                              upperSql.includes('MAX(') || 
                              upperSql.includes('GROUP BY') ||
                              upperSql.includes('HAVING');
        
        let finalResponse;

        if (isAggregation) {
            console.log(`[API-${requestId}] Check: Aggregation query detected. Showing summarized nodes.`);
            
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

        // Required Final Logging Check 
        console.log(`[API-${requestId}] Request completed.`);
        console.log(`- Query: ${naturalLanguageQuery}`);
        console.log(`- SQL: ${rawSql.replace(/\n/g, ' ')}`);
        console.log(`- Execution Time: ${finalResponse.executionTimeMs} ms`);
        console.log(`- Row Count: ${finalResponse.rowCount}`);

        return finalResponse;

    } catch (e) {
         console.error(`[API-${requestId}] Pipeline Failure caught:`, e.message);
         // Classify validation vs LLM errors simplistically based on thrown origin
         const type = e.message.includes('Validation') ? 'VALIDATION_ERROR' : 'LLM_ERROR';
         return {
             success: false,
             error: { message: e.message, type: type },
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

module.exports = {
    processQuery,
    isDomainQuery // Exported for unit testing
};
