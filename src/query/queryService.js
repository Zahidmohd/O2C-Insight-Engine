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
        summary: summary,
        rowCount: result.rowCount, // real count regardless of payload truncation
        keyFields: keyFields,
        executionTimeMs: result.executionTimeMs,
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
            error: domainCheck.message,
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

        // 5. Execute against SQLite with execution timeout
        const dbResult = await withTimeout(executeQuery(rawSql), 5000, 'Database Execution');

        if (!dbResult.success) {
             console.error(`[API-${requestId}] execution evaluation Error boundary trigger: ${dbResult.error}`);
             return { error: 'Failed to execute query safely', message: dbResult.error, sql: rawSql };
        }

        console.log(`[API-${requestId}] Success bounds: ${dbResult.rowCount} payload fetched in ${dbResult.executionTimeMs}ms`);

        // 6. Format structurally backed result
        const finalResponse = formatResponse(dbResult, rawSql);
        return finalResponse;

    } catch (e) {
         console.error(`[API-${requestId}] Pipeline Failure caught:`, e.message);
         return {
             error: e.message,
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
