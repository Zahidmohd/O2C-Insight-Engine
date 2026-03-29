/**
 * O2C-Insight-Engine — API Test Suite
 * Run against the local backend: node test-api.js
 * Server must be running: npm run dev (or npm start)
 */

const BASE_URL = process.env.API_URL || 'http://localhost:3000';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const RESET  = '\x1b[0m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';

let passed = 0;
let failed = 0;
let skipped = 0;

async function post(body) {
    const res = await fetch(`${BASE_URL}/api/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return { status: res.status, data: await res.json() };
}

function assert(condition, label) {
    if (condition) {
        console.log(`  ${GREEN}✓${RESET} ${label}`);
        return true;
    } else {
        console.log(`  ${RED}✗${RESET} ${label}`);
        return false;
    }
}

async function runTest(name, body, checks, { retries = 0 } = {}) {
    console.log(`\n${BOLD}${CYAN}▸ ${name}${RESET}`);
    console.log(`${DIM}  POST /api/query ${JSON.stringify(body)}${RESET}`);

    let res;
    let attempt = 0;
    const maxAttempts = 1 + retries;

    while (attempt < maxAttempts) {
        attempt++;
        try {
            res = await post(body);
        } catch (e) {
            if (attempt < maxAttempts) {
                console.log(`  ${YELLOW}⟳ Attempt ${attempt} failed (${e.message}), retrying...${RESET}`);
                continue;
            }
            console.log(`  ${RED}✗ Connection failed: ${e.message}${RESET}`);
            console.log(`  ${YELLOW}  Is the server running at ${BASE_URL}?${RESET}`);
            failed++;
            return;
        }

        // Retry on LLM timeouts (HTTP 400 with LLM_ERROR) if retries remain
        if (attempt < maxAttempts && res.status === 400 && res.data?.error?.type === 'LLM_ERROR') {
            console.log(`  ${YELLOW}⟳ Attempt ${attempt} got LLM_ERROR, retrying...${RESET}`);
            continue;
        }
        break;
    }

    const d = res.data;
    console.log(`${DIM}  HTTP ${res.status} | success=${d.success} | reason=${d.reason || '-'} | queryType=${d.queryType || '-'} | rowCount=${d.rowCount ?? '-'}${attempt > 1 ? ` | attempt=${attempt}` : ''}${RESET}`);

    let allPassed = true;
    for (const [label, fn] of checks) {
        const ok = assert(fn(res, d), label);
        if (!ok) allPassed = false;
    }

    if (allPassed) passed++; else failed++;
}

// ─── Test Cases ───────────────────────────────────────────────────────────────

async function main() {
    console.log(`\n${BOLD}O2C-Insight-Engine — API Test Suite${RESET}`);
    console.log(`${DIM}Target: ${BASE_URL}${RESET}`);
    console.log('─'.repeat(55));

    // ── 1. INPUT VALIDATION ───────────────────────────────────

    await runTest('Validation: missing query field', {}, [
        ['HTTP 400',       (r) => r.status === 400],
        ['success=false',  (_, d) => d.success === false],
        ['VALIDATION_ERROR type', (_, d) => d.error?.type === 'VALIDATION_ERROR'],
    ]);

    await runTest('Validation: empty string', { query: '   ' }, [
        ['HTTP 400',       (r) => r.status === 400],
        ['success=false',  (_, d) => d.success === false],
        ['VALIDATION_ERROR type', (_, d) => d.error?.type === 'VALIDATION_ERROR'],
    ]);

    await runTest('Validation: query exceeds 500 chars', { query: 'a'.repeat(501) }, [
        ['HTTP 400',       (r) => r.status === 400],
        ['success=false',  (_, d) => d.success === false],
        ['VALIDATION_ERROR type', (_, d) => d.error?.type === 'VALIDATION_ERROR'],
    ]);

    // ── 2. GUARDRAILS ─────────────────────────────────────────

    // NOTE: The classifier runs a domain gate FIRST — "capital of France" has no O2C
    // keywords, so it is rejected as INVALID before RAG classification fires.
    await runTest('Off-topic "what is" blocked by domain gate', { query: 'What is the capital of France?' }, [
        ['success=false',          (_, d) => d.success === false],
        ['VALIDATION_ERROR type',  (_, d) => d.error?.type === 'VALIDATION_ERROR'],
    ]);

    await runTest('Guardrail: no intent word blocked', { query: 'xyzzy frobble wumpus' }, [
        ['success=false',        (_, d) => d.success === false],
        ['VALIDATION_ERROR type',(_, d) => d.error?.type === 'VALIDATION_ERROR'],
    ]);

    // ── 3. RAG QUERIES ────────────────────────────────────────

    await runTest('RAG: "What is order to cash?"', { query: 'What is order to cash?' }, [
        ['success=true',         (_, d) => d.success === true],
        ['queryType=RAG',        (_, d) => d.queryType === 'RAG'],
        ['reason=RAG_RESPONSE',  (_, d) => d.reason === 'RAG_RESPONSE'],
        ['nlAnswer non-empty',   (_, d) => typeof d.nlAnswer === 'string' && d.nlAnswer.length > 0],
        ['confidence=1',         (_, d) => d.confidence === 1],
        ['no sql field',         (_, d) => d.sql === undefined || d.sql === null],
        ['rowCount=0',           (_, d) => d.rowCount === 0],
        ['explanation.strategy=knowledge retrieval', (_, d) => d.explanation?.strategy === 'knowledge retrieval'],
    ]);

    await runTest('RAG: "Describe the billing process"', { query: 'Describe the billing process' }, [
        ['success=true',        (_, d) => d.success === true],
        ['queryType=RAG',       (_, d) => d.queryType === 'RAG'],
        ['confidence=1',        (_, d) => d.confidence === 1],
    ]);

    // ── 4. HYBRID QUERIES ─────────────────────────────────────

    await runTest('HYBRID: "Why is the billing document not cleared?"', { query: 'Why is the billing document not cleared?' }, [
        ['success=true',        (_, d) => d.success === true],
        ['queryType=HYBRID',    (_, d) => d.queryType === 'HYBRID'],
        ['explanation exists',  (_, d) => d.explanation != null],
        ['confidence is number',(_, d) => typeof d.confidence === 'number'],
        ['no sql (default)',    (_, d) => d.sql === undefined || d.sql === null],
    ], { retries: 2 });

    // ── 5. SQL QUERIES ────────────────────────────────────────

    await runTest('SQL: List sales orders (no SQL by default)', { query: 'List all sales orders' }, [
        ['success=true',         (_, d) => d.success === true],
        ['queryType=SQL',        (_, d) => d.queryType === 'SQL'],
        ['rowCount > 0',         (_, d) => d.rowCount > 0],
        ['sql hidden by default',(_, d) => d.sql === undefined || d.sql === null],
        ['explanation.intent exists', (_, d) => typeof d.explanation?.intent === 'string'],
        ['confidence is number', (_, d) => typeof d.confidence === 'number'],
        ['graph.nodes exists',   (_, d) => Array.isArray(d.graph?.nodes)],
    ]);

    await runTest('SQL: List sales orders WITH SQL visible', { query: 'List all sales orders', includeSql: true }, [
        ['success=true',         (_, d) => d.success === true],
        ['sql field present',    (_, d) => typeof d.sql === 'string' && d.sql.length > 0],
        ['sql starts with SELECT',(_, d) => d.sql?.trim().toUpperCase().startsWith('SELECT')],
    ]);

    await runTest('SQL: Count billing documents (aggregation)', { query: 'Count all billing documents' }, [
        ['success=true',          (_, d) => d.success === true],
        ['reason=AGGREGATION',    (_, d) => d.reason === 'AGGREGATION'],
        ['rowCount > 0',          (_, d) => d.rowCount > 0],
        ['confidence <= 0.9',     (_, d) => d.confidence <= 0.9],
    ]);

    await runTest('SQL: Full flow trace for valid billing doc', { query: 'Trace full flow for billing document 90504204' }, [
        ['success=true',          (_, d) => d.success === true],
        ['rowCount > 0',          (_, d) => d.rowCount > 0],
        ['graph has nodes',       (_, d) => d.graph?.nodes?.length > 0],
        ['graph has edges',       (_, d) => d.graph?.edges?.length > 0],
        ['explanation.intent=trace', (_, d) => d.explanation?.intent === 'trace'],
        ['strategy=multi-hop join',  (_, d) => d.explanation?.strategy?.includes('multi-hop')],
    ], { retries: 2 });

    await runTest('SQL: Top customers by billing amount', { query: 'Top 5 customers by total billing amount' }, [
        ['success=true',    (_, d) => d.success === true],
        ['rowCount > 0',    (_, d) => d.rowCount > 0],
        ['confidence <= 0.9',(_, d) => d.confidence <= 0.9],
    ]);

    // ── 6. INVALID ID HANDLING ────────────────────────────────

    await runTest('Invalid billing document ID', { query: 'Trace flow for billing document 99999999' }, [
        ['success=true',         (_, d) => d.success === true],
        ['reason=INVALID_ID',    (_, d) => d.reason === 'INVALID_ID'],
        ['suggestions present',  (_, d) => Array.isArray(d.suggestions) && d.suggestions.length > 0],
        ['rowCount=0',           (_, d) => d.rowCount === 0],
        ['message present',      (_, d) => typeof d.message === 'string'],
    ], { retries: 2 });

    // ── 7. SQL VISIBILITY CONTROL ─────────────────────────────

    await runTest('SQL hidden when includeSql omitted', { query: 'Show all sales orders' }, [
        ['sql is null/undefined', (_, d) => d.sql == null],
    ]);

    await runTest('SQL visible when includeSql=true', { query: 'Show all sales orders', includeSql: true }, [
        ['sql is string',    (_, d) => typeof d.sql === 'string'],
        ['sql non-empty',    (_, d) => d.sql?.length > 0],
    ]);

    await runTest('SQL hidden when includeSql=false explicitly', { query: 'Show all sales orders', includeSql: false }, [
        ['sql is null/undefined', (_, d) => d.sql == null],
    ]);

    // ── 8. RESPONSE SHAPE ─────────────────────────────────────

    await runTest('Response shape: all new fields present on SQL query', { query: 'List all customers' }, [
        ['queryType field',    (_, d) => 'queryType' in d],
        ['explanation field',  (_, d) => 'explanation' in d],
        ['confidence field',   (_, d) => 'confidence' in d],
        ['requestId field',    (_, d) => typeof d.requestId === 'string'],
        ['graph field',        (_, d) => 'graph' in d],
        ['explanation.intent', (_, d) => typeof d.explanation?.intent === 'string'],
        ['explanation.entities is array', (_, d) => Array.isArray(d.explanation?.entities)],
        ['explanation.strategy', (_, d) => typeof d.explanation?.strategy === 'string'],
    ]);

    // ── 9. CONFIDENCE SCORING ─────────────────────────────────

    await runTest('Confidence: RAG always 1.0', { query: 'What is a sales order?' }, [
        ['queryType=RAG',    (_, d) => d.queryType === 'RAG'],
        ['confidence=1',     (_, d) => d.confidence === 1],
    ]);

    // "deliveries" (plural) does not substring-match "delivery" in domain keywords — blocked.
    // Use "delivery" to ensure domain match.
    await runTest('Confidence: aggregation reduces score', { query: 'How many delivery documents are there?' }, [
        ['success=true',          (_, d) => d.success === true],
        ['confidence < 1',        (_, d) => d.confidence < 1],
    ]);

    // ── 10. DATASET METADATA ENDPOINT ──────────────────────────

    console.log(`\n${BOLD}${CYAN}▸ Dataset metadata endpoint${RESET}`);
    console.log(`${DIM}  GET /api/dataset${RESET}`);

    let datasetRes;
    try {
        const r = await fetch(`${BASE_URL}/api/dataset`);
        datasetRes = { status: r.status, data: await r.json() };
    } catch (e) {
        console.log(`  ${RED}✗ Connection failed: ${e.message}${RESET}`);
        failed++;
        datasetRes = null;
    }

    if (datasetRes) {
        const dd = datasetRes.data;
        console.log(`${DIM}  HTTP ${datasetRes.status} | name=${dd.name} | tables=${dd.tableCount}${RESET}`);

        let allPassed = true;
        for (const [label, fn] of [
            ['HTTP 200',                   () => datasetRes.status === 200],
            ['name is sap_o2c',            () => dd.name === 'sap_o2c'],
            ['displayName present',        () => typeof dd.displayName === 'string' && dd.displayName.length > 0],
            ['tables is array',            () => Array.isArray(dd.tables) && dd.tables.length > 0],
            ['tableCount matches',         () => dd.tableCount === dd.tables.length],
            ['relationships is array',     () => Array.isArray(dd.relationships) && dd.relationships.length > 0],
            ['first table has columns',    () => Array.isArray(dd.tables[0]?.columns) && dd.tables[0].columns.length > 0],
            ['first table has primaryKey', () => Array.isArray(dd.tables[0]?.primaryKey) && dd.tables[0].primaryKey.length > 0],
        ]) {
            const ok = assert(fn(), label);
            if (!ok) allPassed = false;
        }
        if (allPassed) passed++; else failed++;
    }

    // ── 11. DATASET FIELD IN QUERY RESPONSE ──────────────────

    await runTest('Response includes dataset field', { query: 'List all sales orders' }, [
        ['success=true',         (_, d) => d.success === true],
        ['dataset=sap_o2c',      (_, d) => d.dataset === 'sap_o2c'],
    ]);

    // ── 12. DATASET UPLOAD ENDPOINT ─────────────────────────────

    // Helper for POST /api/dataset/upload
    async function postUpload(body) {
        const r = await fetch(`${BASE_URL}/api/dataset/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return { status: r.status, data: await r.json() };
    }

    // 12a. Validation: missing config object
    console.log(`\n${BOLD}${CYAN}▸ Upload: missing config object${RESET}`);
    console.log(`${DIM}  POST /api/dataset/upload {}${RESET}`);
    try {
        const r = await postUpload({});
        console.log(`${DIM}  HTTP ${r.status}${RESET}`);
        let allPassed = true;
        for (const [label, fn] of [
            ['HTTP 400',            () => r.status === 400],
            ['success=false',       () => r.data.success === false],
            ['VALIDATION_ERROR',    () => r.data.error?.type === 'VALIDATION_ERROR'],
        ]) { if (!assert(fn(), label)) allPassed = false; }
        if (allPassed) passed++; else failed++;
    } catch (e) {
        console.log(`  ${RED}✗ Connection failed: ${e.message}${RESET}`);
        failed++;
    }

    // 12b. Validation: config missing name
    console.log(`\n${BOLD}${CYAN}▸ Upload: config missing name${RESET}`);
    console.log(`${DIM}  POST /api/dataset/upload { config: { tables: [...] } }${RESET}`);
    try {
        const r = await postUpload({ config: { tables: [{ name: 'x', columns: ['a'] }], relationships: [{}], domainKeywords: ['x'] } });
        console.log(`${DIM}  HTTP ${r.status}${RESET}`);
        let allPassed = true;
        for (const [label, fn] of [
            ['HTTP 400',            () => r.status === 400],
            ['VALIDATION_ERROR',    () => r.data.error?.type === 'VALIDATION_ERROR'],
        ]) { if (!assert(fn(), label)) allPassed = false; }
        if (allPassed) passed++; else failed++;
    } catch (e) {
        console.log(`  ${RED}✗ Connection failed: ${e.message}${RESET}`);
        failed++;
    }

    // 12c. Validation: empty tables array
    console.log(`\n${BOLD}${CYAN}▸ Upload: empty tables array${RESET}`);
    console.log(`${DIM}  POST /api/dataset/upload { config: { name: 'x', tables: [] } }${RESET}`);
    try {
        const r = await postUpload({ config: { name: 'x', tables: [], relationships: [{}], domainKeywords: ['x'] } });
        console.log(`${DIM}  HTTP ${r.status}${RESET}`);
        let allPassed = true;
        for (const [label, fn] of [
            ['HTTP 400',            () => r.status === 400],
            ['VALIDATION_ERROR',    () => r.data.error?.type === 'VALIDATION_ERROR'],
        ]) { if (!assert(fn(), label)) allPassed = false; }
        if (allPassed) passed++; else failed++;
    } catch (e) {
        console.log(`  ${RED}✗ Connection failed: ${e.message}${RESET}`);
        failed++;
    }

    // 12d. Validation: table missing columns
    console.log(`\n${BOLD}${CYAN}▸ Upload: table missing columns${RESET}`);
    console.log(`${DIM}  POST /api/dataset/upload { config: { ... table without columns } }${RESET}`);
    try {
        const r = await postUpload({ config: { name: 'x', tables: [{ name: 't1' }], relationships: [{}], domainKeywords: ['x'] } });
        console.log(`${DIM}  HTTP ${r.status}${RESET}`);
        let allPassed = true;
        for (const [label, fn] of [
            ['HTTP 400',            () => r.status === 400],
            ['VALIDATION_ERROR',    () => r.data.error?.type === 'VALIDATION_ERROR'],
        ]) { if (!assert(fn(), label)) allPassed = false; }
        if (allPassed) passed++; else failed++;
    } catch (e) {
        console.log(`  ${RED}✗ Connection failed: ${e.message}${RESET}`);
        failed++;
    }

    // 12e. Validation: missing relationships
    console.log(`\n${BOLD}${CYAN}▸ Upload: missing relationships${RESET}`);
    console.log(`${DIM}  POST /api/dataset/upload { config: { ... no relationships } }${RESET}`);
    try {
        const r = await postUpload({ config: { name: 'x', tables: [{ name: 't1', columns: ['a'] }], relationships: [], domainKeywords: ['x'] } });
        console.log(`${DIM}  HTTP ${r.status}${RESET}`);
        let allPassed = true;
        for (const [label, fn] of [
            ['HTTP 400',            () => r.status === 400],
            ['VALIDATION_ERROR',    () => r.data.error?.type === 'VALIDATION_ERROR'],
        ]) { if (!assert(fn(), label)) allPassed = false; }
        if (allPassed) passed++; else failed++;
    } catch (e) {
        console.log(`  ${RED}✗ Connection failed: ${e.message}${RESET}`);
        failed++;
    }

    // 12f. Validation: missing domainKeywords
    console.log(`\n${BOLD}${CYAN}▸ Upload: missing domainKeywords${RESET}`);
    console.log(`${DIM}  POST /api/dataset/upload { config: { ... no domainKeywords } }${RESET}`);
    try {
        const r = await postUpload({ config: { name: 'x', tables: [{ name: 't1', columns: ['a'] }], relationships: [{ from: 'a', to: 'b' }] } });
        console.log(`${DIM}  HTTP ${r.status}${RESET}`);
        let allPassed = true;
        for (const [label, fn] of [
            ['HTTP 400',            () => r.status === 400],
            ['VALIDATION_ERROR',    () => r.data.error?.type === 'VALIDATION_ERROR'],
        ]) { if (!assert(fn(), label)) allPassed = false; }
        if (allPassed) passed++; else failed++;
    } catch (e) {
        console.log(`  ${RED}✗ Connection failed: ${e.message}${RESET}`);
        failed++;
    }

    // 12g. Re-upload SAP config — verifies activation flow works end-to-end
    // After this, the system should be back to the SAP dataset and queries should still work
    console.log(`\n${BOLD}${CYAN}▸ Upload: re-upload SAP O2C config (activation flow)${RESET}`);
    console.log(`${DIM}  POST /api/dataset/upload { config: sapConfig }${RESET}`);
    try {
        // Build a minimal SAP config that exercises the full activation path
        // We use the GET /api/dataset endpoint to fetch the current config shape
        const metaRes = await fetch(`${BASE_URL}/api/dataset`);
        const meta = await metaRes.json();

        const sapConfig = {
            name: meta.name,
            displayName: meta.displayName,
            description: meta.description,
            tables: meta.tables,
            relationships: meta.relationships,
            domainKeywords: ['order', 'sales', 'billing', 'delivery', 'invoice', 'customer'],
            dataDir: '../../sap-o2c-data'
        };

        const r = await postUpload({ config: sapConfig });
        console.log(`${DIM}  HTTP ${r.status} | ${JSON.stringify(r.data).slice(0, 120)}${RESET}`);

        let allPassed = true;
        for (const [label, fn] of [
            ['HTTP 200',                () => r.status === 200],
            ['success=true',            () => r.data.success === true],
            ['dataset=sap_o2c',         () => r.data.dataset === 'sap_o2c'],
            ['tablesCreated > 0',       () => r.data.tablesCreated > 0],
            ['rowsLoaded >= 0',         () => r.data.rowsLoaded >= 0],
        ]) { if (!assert(fn(), label)) allPassed = false; }
        if (allPassed) passed++; else failed++;
    } catch (e) {
        console.log(`  ${RED}✗ Connection failed: ${e.message}${RESET}`);
        failed++;
    }

    // 12h. After re-upload, verify queries still work
    await runTest('Post-upload: query still works', { query: 'List all sales orders' }, [
        ['success=true',        (_, d) => d.success === true],
        ['dataset=sap_o2c',     (_, d) => d.dataset === 'sap_o2c'],
        ['rowCount > 0',        (_, d) => d.rowCount > 0],
    ]);

    // ── SUMMARY ───────────────────────────────────────────────

    const total = passed + failed;
    console.log('\n' + '─'.repeat(55));
    console.log(`${BOLD}Results: ${GREEN}${passed} passed${RESET}${BOLD}, ${failed > 0 ? RED : ''}${failed} failed${RESET}${BOLD} / ${total} total${RESET}`);
    if (skipped > 0) console.log(`${YELLOW}${skipped} skipped${RESET}`);
    console.log('');

    if (failed > 0) process.exit(1);
}

main().catch(e => {
    console.error(`\n${RED}Fatal error:${RESET}`, e.message);
    console.log(`${YELLOW}Make sure the server is running: npm run dev${RESET}\n`);
    process.exit(1);
});
