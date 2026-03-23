const { buildPrompt } = require('./promptBuilder');
const { getSqlFromLLM } = require('./llmClient');
const { validateSql } = require('./validator');
const { executeQuery } = require('./sqlExecutor');

/**
 * Validates domain safety before spending API tokens
 * Rejects questions wildly outside the SAP O2C domain
 */
function isDomainQuery(query) {
    const queryLower = query.toLowerCase();
    
    // Simple heuristic domain guardrail
    const keywords = [
        'order', 'sales', 'delivery', 'bill', 'invoice', 
        'journal', 'payment', 'customer', 'product', 'plant',
        'document', 'item', 'amount', 'clearing', 'flow'
    ];
    
    const containsKeyword = keywords.some(kw => queryLower.includes(kw));

    if (!containsKeyword) {
        return {
            valid: false,
            message: "This system is designed to answer questions related to the provided dataset only (SAP Order-to-Cash, Customers, Products, Payments)."
        };
    }
    return { valid: true };
}

/**
 * Formats the final structural response output
 */
function formatResponse(result, rawSql) {
    // Determine summary based on row count
    let summary = `Query returned ${result.rowCount} row(s) in ${result.executionTimeMs}ms.`;
    
    if (result.rowCount === 0) {
        summary = `No records found matching your query in the dataset. Execution took ${result.executionTimeMs}ms.`;
    }

    // Capture column headers from the first row if available
    const keyFields = result.rows && result.rows.length > 0 
        ? Object.keys(result.rows[0])
        : [];

    return {
        summary: summary,
        rowCount: result.rowCount,
        keyFields: keyFields,
        executionTimeMs: result.executionTimeMs,
        generatedSql: rawSql,
        data: result.rows
    };
}

/**
 * Orchestrates the full Natural Language -> SQL -> Result pipeline
 */
async function processQuery(naturalLanguageQuery) {
    console.log(`\n[QueryService] Processing: "${naturalLanguageQuery}"`);

    // 1. Guardrails
    const domainCheck = isDomainQuery(naturalLanguageQuery);
    if (!domainCheck.valid) {
        console.warn(`[QueryService] Domain Check Failed`);
        return {
            error: domainCheck.message,
            query: naturalLanguageQuery
        };
    }
    
    // 2. Build Prompt
    const prompt = buildPrompt(naturalLanguageQuery);

    try {
        // 3. Generate SQL from LLM
        const rawSql = await getSqlFromLLM(prompt);
        console.log(`[QueryService] Generated SQL:\n${rawSql}\n`);

        // 4. Validate output
        validateSql(rawSql); // Throws Error if unsafe

        // 5. Execute against SQLite
        const dbResult = await executeQuery(rawSql);

        if (!dbResult.success) {
             console.error(`[QueryService] SQL Error: ${dbResult.error}`);
             return { error: 'Failed to execute query safely', message: dbResult.error, sql: rawSql };
        }

        // 6. Format structurally backed result
        const finalResponse = formatResponse(dbResult, rawSql);
        return finalResponse;

    } catch (e) {
         console.error(`[QueryService] Pipeline Failure:`, e.message);
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
