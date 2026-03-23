const { buildPrompt } = require('./promptBuilder');
const { getSqlFromLLM } = require('./llmClient');
const { validateSql } = require('./validator');
const { executeQuery } = require('./sqlExecutor');
const { extractGraph } = require('./graphExtractor');

/**
 * Validates domain safety before spending API tokens
 * Rejects questions wildly outside the SAP O2C domain
 */
function isDomainQuery(query) {
    const queryLower = query.toLowerCase();
    
    // Improved Domain Guardrail List
    const mandatoryDomainKeywords = [
        'order', 'sales', 'delivery', 'bill', 'invoice', 
        'journal', 'payment', 'customer', 'product', 'plant',
        'document', 'item', 'amount', 'clearing', 'flow',
        'company', 'fiscal', 'accounting', 'partner'
    ];
    
    // Check if query contains at least one domain keyword
    const matchedKeywords = mandatoryDomainKeywords.filter(kw => queryLower.includes(kw));

    if (matchedKeywords.length === 0) {
        return {
            valid: false,
            message: "This system is designed to answer questions related to the provided dataset only (e.g., SAP Order-to-Cash, Customers, Products, Payments)."
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
        graph: graphData
    };
}

/**
 * Orchestrates the full Natural Language -> SQL -> Result pipeline
 */
async function processQuery(naturalLanguageQuery, requestId = 'dev-local') {
    console.log(`\n[API-${requestId}] Query Service Evaluation: "${naturalLanguageQuery}"`);

    // 1. Guardrails
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
        const rawSql = enforceLimit(generatedSql);
        
        console.log(`[API-${requestId}] Engine Generated SQL:\n${rawSql}\n`);

        // 4. Validate output
        validateSql(rawSql); // Throws Error if unsafe

        // 4.5. Check if specific billing document exists in DB
        const idMatch = rawSql.match(/billingDocument\s*(?:=|LIKE)\s*['"](\d+)['"]/i);
        let explicitIdChecked = false;
        
        if (idMatch && idMatch[1]) {
            const extractedId = idMatch[1];
            explicitIdChecked = true;
            console.log(`[API-${requestId}] Check: Testing existence of billing document '${extractedId}'...`);
            
            const checkQuery = `SELECT billingDocument FROM billing_document_headers WHERE billingDocument = '${extractedId}' LIMIT 1;`;
            const checkResult = await withTimeout(executeQuery(checkQuery), 2000, 'DB Existence Check');
            
            if (checkResult.success && checkResult.rowCount === 0) {
                console.log(`[API-${requestId}] Check: Invalid billing ID detected: ${extractedId}`);
                
                // Fetch ~5 valid samples
                const sampleQuery = `SELECT billingDocument FROM billing_document_headers LIMIT 5;`;
                const sampleResult = await withTimeout(executeQuery(sampleQuery), 2000, 'DB Samples Fetch');
                const suggestions = sampleResult.success ? sampleResult.rows.map(r => r.billingDocument) : [];
                
                return {
                    success: true,
                    summary: `Billing document '${extractedId}' was not found in the dataset.`,
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
            console.log(`[API-${requestId}] Check: Billing document '${extractedId}' exists. Proceeding to evaluate flow.`);
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
        // If query executed but returned 0 rows, relax all strict JOINs down to LEFT JOIN
        // to natively recover and map partial graph pipelines automatically.
        if (dbResult.rowCount === 0 && rawSql.match(/\bJOIN\b/gi)) {
            console.log(`[API-${requestId}] Check: Zero rows returned. Attempting silent relaxed retry (LEFT JOIN fallback)...`);
            
            let relaxedSql = rawSql;
            relaxedSql = relaxedSql.replace(/\bINNER\s+JOIN\b/gi, 'JOIN'); // Normalize first
            relaxedSql = relaxedSql.replace(/\bJOIN\b/gi, 'LEFT JOIN');
            // Clean up accidental overwrites logically
            relaxedSql = relaxedSql.replace(/\bLEFT\s+LEFT\s+JOIN\b/gi, 'LEFT JOIN');
            relaxedSql = relaxedSql.replace(/\bRIGHT\s+LEFT\s+JOIN\b/gi, 'RIGHT JOIN');
            relaxedSql = relaxedSql.replace(/\bFULL\s+LEFT\s+JOIN\b/gi, 'FULL JOIN');
            relaxedSql = relaxedSql.replace(/\bCROSS\s+LEFT\s+JOIN\b/gi, 'CROSS JOIN');

            const relaxedDbResult = await withTimeout(executeQuery(relaxedSql), 5000, 'Database Execution Fallback');
            if (relaxedDbResult.success && relaxedDbResult.rowCount > 0) {
                console.log(`[API-${requestId}] Check: Fallback successful! Fetched ${relaxedDbResult.rowCount} rows via relaxed boundary graphs.`);
                dbResult = relaxedDbResult;
                rawSql = relaxedSql;
            }
        }

        console.log(`[API-${requestId}] Success bounds: ${dbResult.rowCount} payload fetched in ${dbResult.executionTimeMs}ms`);

        // Clarify zero rows explicitly (if it STILL is 0 after fallback)
        if (dbResult.rowCount === 0) {
            console.log(`[API-${requestId}] Check: Zero rows returned after fallback routines.`);
            const emptySummary = explicitIdChecked 
                ? `The document was found, but no connected flow traversing outbound nodes exists.`
                : `The query executed correctly, but no matching connected records were found.`;

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

        // 6. Format structurally backed result
        const finalResponse = formatResponse(dbResult, rawSql);

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
