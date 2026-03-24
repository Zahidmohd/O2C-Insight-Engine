/**
 * Smoke Test Suite — Graph-Based Data Modeling and Query System
 * 
 * Tests core query pipeline: guardrails, traces, aggregations, 
 * invalid IDs, broken flows, and listing queries.
 * 
 * Usage: node tests/smokeTest.js
 * Requires: Backend server running on http://localhost:3000
 */

const http = require('http');

const API_URL = 'http://localhost:3000/api/query';

function post(query) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ query });
        const opts = {
            hostname: 'localhost',
            port: 3000,
            path: '/api/query',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        };
        const req = http.request(opts, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function assert(condition, msg) {
    if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const tests = [
    {
        name: 'Guardrail — Off-topic query rejected',
        query: 'What is the capital of France?',
        validate: (res) => {
            assert(res.status === 400, `Expected 400, got ${res.status}`);
            assert(res.body.success === false, 'Expected success=false');
            assert(res.body.error.type === 'VALIDATION_ERROR', 'Expected VALIDATION_ERROR');
        }
    },
    {
        name: 'Guardrail — Creative writing rejected',
        query: 'Write me a poem about flowers',
        validate: (res) => {
            assert(res.status === 400, `Expected 400, got ${res.status}`);
            assert(res.body.success === false, 'Expected success=false');
        }
    },
    {
        name: 'Guardrail — Empty query rejected',
        query: '',
        validate: (res) => {
            assert(res.status === 400, `Expected 400, got ${res.status}`);
            assert(res.body.error.message.includes('missing'), 'Expected missing query error');
        }
    },
    {
        name: 'Full trace — Billing document flow',
        query: 'Trace full flow for billing document 90504248',
        validate: (res) => {
            assert(res.status === 200, `Expected 200, got ${res.status}`);
            assert(res.body.success === true, 'Expected success=true');
            assert(res.body.rowCount > 0, 'Expected rows > 0');
            assert(res.body.graph.nodes.length >= 4, `Expected >= 4 nodes, got ${res.body.graph.nodes.length}`);
            assert(res.body.graph.edges.length >= 3, `Expected >= 3 edges, got ${res.body.graph.edges.length}`);
            assert(res.body.highlightNodes.includes('BILL_90504248'), 'Expected billing doc highlighted');
            assert(res.body.nlAnswer, 'Expected NL answer');
        }
    },
    {
        name: 'Full trace — Sales order flow',
        query: 'Trace full flow for sales order 740552',
        validate: (res) => {
            assert(res.status === 200, `Expected 200, got ${res.status}`);
            assert(res.body.rowCount > 0, 'Expected rows > 0');
            assert(res.body.graph.nodes.length >= 4, `Expected >= 4 nodes, got ${res.body.graph.nodes.length}`);
            assert(res.body.highlightNodes.includes('SO_740552'), 'Expected sales order highlighted');
        }
    },
    {
        name: 'Invalid ID — Non-existent billing document',
        query: 'Trace full flow for billing document 99999999',
        validate: (res) => {
            assert(res.status === 200, `Expected 200, got ${res.status}`);
            assert(res.body.reason === 'INVALID_ID', `Expected INVALID_ID, got ${res.body.reason}`);
            assert(res.body.suggestions && res.body.suggestions.length > 0, 'Expected suggestions');
            assert(res.body.summary.includes('not found'), 'Expected not-found message');
        }
    },
    {
        name: 'Invalid ID — Non-existent sales order',
        query: 'Trace full flow for sales order 999999',
        validate: (res) => {
            assert(res.status === 200, `Expected 200, got ${res.status}`);
            assert(res.body.reason === 'INVALID_ID', `Expected INVALID_ID, got ${res.body.reason}`);
            assert(res.body.suggestions.length > 0, 'Expected suggestions');
        }
    },
    {
        name: 'Aggregation — Products by billing count',
        query: 'Which products have the most billing documents?',
        validate: (res) => {
            assert(res.status === 200, `Expected 200, got ${res.status}`);
            assert(res.body.rowCount > 0, 'Expected rows > 0');
            assert(res.body.reason === 'AGGREGATION', `Expected AGGREGATION, got ${res.body.reason}`);
            assert(res.body.nlAnswer, 'Expected NL answer');
        }
    },
    {
        name: 'Aggregation — Top customers by billing amount',
        query: 'Top 5 customers by total billing amount',
        validate: (res) => {
            assert(res.status === 200, `Expected 200, got ${res.status}`);
            assert(res.body.reason === 'AGGREGATION', `Expected AGGREGATION, got ${res.body.reason}`);
        }
    },
    {
        name: 'Broken flows — Delivered but not billed',
        query: 'Find sales orders that were delivered but not billed',
        validate: (res) => {
            assert(res.status === 200, `Expected 200, got ${res.status}`);
            assert(res.body.success === true, 'Expected success=true');
            assert(res.body.nlAnswer, 'Expected NL answer');
        }
    },
    {
        name: 'Listing — Cancelled billing documents',
        query: 'Show all cancelled billing documents',
        validate: (res) => {
            assert(res.status === 200, `Expected 200, got ${res.status}`);
            assert(res.body.rowCount > 0, `Expected rows > 0, got ${res.body.rowCount}`);
            assert(res.body.graph.nodes.length > 0, 'Expected nodes in graph');
        }
    },
    {
        name: 'Customer query — Valid customer',
        query: 'Show all orders for customer 320000083',
        validate: (res) => {
            assert(res.status === 200, `Expected 200, got ${res.status}`);
            assert(res.body.rowCount > 0, 'Expected rows > 0');
            assert(res.body.graph.nodes.length > 0, 'Expected nodes');
        }
    },
];

async function runTests() {
    console.log('='.repeat(60));
    console.log('  SMOKE TEST SUITE — SAP O2C Graph Query System');
    console.log('='.repeat(60));
    console.log();

    let passed = 0;
    let failed = 0;

    for (const test of tests) {
        process.stdout.write(`  ${test.name} ... `);
        try {
            const res = await post(test.query);
            test.validate(res);
            console.log('✅ PASS');
            passed++;
        } catch (err) {
            console.log(`❌ FAIL — ${err.message}`);
            failed++;
        }
    }

    console.log();
    console.log('-'.repeat(60));
    console.log(`  Results: ${passed} passed, ${failed} failed, ${tests.length} total`);
    console.log('-'.repeat(60));

    if (failed > 0) process.exit(1);
}

runTests().catch(err => {
    console.error('Test runner error:', err.message);
    process.exit(1);
});
