/**
 * Knowledge base with triple-path retrieval:
 * 1. Vector search — if documents have been uploaded, embed the query and search chunks
 * 2. Auto-generated KB — built dynamically from the active dataset's schema + relationships
 * 3. Hardcoded KB — curated SAP O2C dictionary (only for sap_o2c dataset)
 *
 * retrieveContext(query) → Promise<string | null>
 */

const { getChunkCount, searchSimilar } = require('./vectorStore');
const { embed } = require('./embeddingService');
const { getActiveConfig } = require('../config/activeDataset');

// ─── Hardcoded SAP O2C KB (kept for the default dataset) ─────────────────────

const O2C_KB = [
    {
        keywords: ['o2c', 'order to cash', 'order-to-cash'],
        context: 'Order-to-Cash (O2C) is the end-to-end SAP business process that begins with a customer placing a Sales Order, followed by Outbound Delivery (goods shipment), Billing Document (invoice generation), Journal Entry (accounts receivable posting), and finally Payment (cash clearing). Each stage is linked by document references and accounting keys.'
    },
    {
        keywords: ['sales order'],
        context: 'A Sales Order (SO) in SAP captures a customer purchase request. It records the customer (soldToParty), ordered materials, quantities, prices, and delivery schedules. It is the starting document of the O2C flow and links downstream to delivery and billing documents.'
    },
    {
        keywords: ['delivery', 'outbound delivery'],
        context: 'An Outbound Delivery document in SAP records the physical shipment of goods against a Sales Order. It captures the delivery date, shipping point, plant, and actual quantities dispatched. It links back to the Sales Order via referenceSdDocument and forward to Billing via the delivery document number.'
    },
    {
        keywords: ['billing', 'invoice', 'billing document'],
        context: 'A Billing Document in SAP represents the customer invoice generated after goods are delivered. It records the billed amount, billing date, company code, and fiscal year. It links to the Delivery via referenceSdDocument and triggers a Journal Entry posting in accounts receivable. Cancelled billing documents have billingDocumentIsCancelled = 1.'
    },
    {
        keywords: ['journal entry', 'journal', 'accounts receivable', 'accounting document'],
        context: 'A Journal Entry in SAP records the accounts receivable (AR) posting created when a Billing Document is finalised. It captures the accounting document number, company code, fiscal year, and the amount in transaction currency. The clearingAccountingDocument field links it to the incoming Payment that settles the balance.'
    },
    {
        keywords: ['payment', 'clearing', 'cash'],
        context: 'A Payment (Accounts Receivable clearing) in SAP records the receipt of cash from the customer. It is matched to a Journal Entry via the clearingAccountingDocument key, completing the O2C cycle. The postingDate and amountInTransactionCurrency confirm when and how much was received.'
    },
    {
        keywords: ['customer', 'business partner', 'sold to party'],
        context: 'A Customer in SAP is represented as a Business Partner. The soldToParty field on Sales Orders and Billing Documents links transactions to the customer master. Business partner data includes name, address, and sales area assignments that determine pricing and shipping conditions.'
    },
    {
        keywords: ['plant'],
        context: 'A Plant in SAP is a manufacturing or distribution facility. It appears on Sales Order items (productionPlant) and Delivery items (plant) to indicate where goods are produced or shipped from. Plants are linked to products via the product_plants table.'
    },
    {
        keywords: ['product', 'material'],
        context: 'A Product (Material) in SAP is the goods or service being sold. Products appear on Sales Order items, Delivery items, and Billing items via the material field. Product master data includes product type, product group, and multilingual descriptions stored in product_descriptions.'
    },
    {
        keywords: ['cancellation', 'cancelled', 'cancel'],
        context: 'In SAP, a cancelled Billing Document has billingDocumentIsCancelled = 1 and an associated cancellation memo. Cancellations reverse the financial impact of the original billing and create offsetting Journal Entries. The billing_document_cancellations table links cancellation documents to their original billing documents.'
    }
];

// ─── Auto-Generated KB from Dataset Config ───────────────────────────────────

/**
 * Builds KB entries dynamically from the active dataset's tables and relationships.
 * Works for ANY uploaded dataset — not just SAP O2C.
 */
function buildDynamicKB(config) {
    if (!config || !config.tables) return [];

    const entries = [];
    const dsName = config.displayName || config.name || 'this dataset';

    // 1. Dataset overview entry
    const tableNames = config.tables.map(t => t.displayName || t.name.replace(/_/g, ' '));
    entries.push({
        keywords: [config.name, ...(config.domainKeywords || []).slice(0, 5), 'dataset', 'overview', 'about', 'tables'],
        context: `The "${dsName}" dataset contains ${config.tables.length} tables: ${tableNames.join(', ')}. ${config.description || ''}`
    });

    // 2. One entry per table
    for (const table of config.tables) {
        const name = table.displayName || table.name.replace(/_/g, ' ');
        const nameLower = name.toLowerCase();
        const cols = table.columns || [];
        const pk = table.primaryKey && table.primaryKey.length > 0 ? table.primaryKey.join(', ') : 'none detected';

        // Find relationships involving this table
        const rels = (config.relationships || []).filter(r => {
            const fromTable = r.from.split('.')[0];
            const toTable = r.to.split('.')[0];
            return fromTable === table.name || toTable === table.name;
        });

        let relDesc = '';
        if (rels.length > 0) {
            const relParts = rels.map(r => {
                const from = r.from.split('.')[0].replace(/_/g, ' ');
                const to = r.to.split('.')[0].replace(/_/g, ' ');
                return `${from} → ${to} (${r.label || r.joinType || 'JOIN'})`;
            });
            relDesc = ` It connects to: ${relParts.join('; ')}.`;
        }

        // Generate keywords from table name and column names
        const keywords = [
            nameLower,
            table.name.toLowerCase(),
            ...nameLower.split(' ').filter(w => w.length > 2),
        ];

        entries.push({
            keywords: [...new Set(keywords)],
            context: `The "${name}" table has ${cols.length} columns: ${cols.slice(0, 10).join(', ')}${cols.length > 10 ? ` (+${cols.length - 10} more)` : ''}. Primary key: ${pk}.${relDesc}`
        });
    }

    // 3. Relationships overview entry
    if (config.relationships && config.relationships.length > 0) {
        const relNames = config.relationships.map(r => {
            const from = r.from.split('.')[0].replace(/_/g, ' ');
            const to = r.to.split('.')[0].replace(/_/g, ' ');
            return `${from} → ${to}`;
        });
        entries.push({
            keywords: ['relationship', 'relationships', 'join', 'joins', 'connected', 'linked', 'flow', 'how'],
            context: `The "${dsName}" dataset has ${config.relationships.length} relationships: ${relNames.join(', ')}. These define how tables connect and enable multi-hop trace queries across the data flow.`
        });
    }

    return entries;
}

// ─── Retrieval ───────────────────────────────────────────────────────────────

/**
 * Retrieves context for a query using:
 * 1. Vector search (uploaded documents)
 * 2. Dynamic KB (auto-generated from dataset schema)
 * 3. Hardcoded O2C KB (only for sap_o2c)
 */
async function retrieveContext(query, dbConn = null) {
    const db = dbConn || require('../db/connection');
    const config = getActiveConfig();

    // 1. Try vector search if documents have been uploaded
    try {
        const chunkCount = await getChunkCount(db);
        if (chunkCount > 0) {
            const queryEmbedding = await embed(query);
            const results = await searchSimilar(db, queryEmbedding, 5, 0.3);
            if (results.length > 0) {
                console.log(`[RAG] Vector search returned ${results.length} chunks (top score: ${results[0].score.toFixed(3)})`);
                return results.map(r => r.text).join('\n\n');
            }
        }
    } catch (err) {
        console.warn('[RAG] Vector search failed, falling back to KB:', err.message);
    }

    // 2. Try dynamic KB (works for ANY dataset)
    const dynamicKB = buildDynamicKB(config);
    const lower = query.toLowerCase();

    for (const entry of dynamicKB) {
        if (entry.keywords.some(kw => {
            const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`\\b${escaped}\\b`).test(lower);
        })) {
            console.log('[RAG] Dynamic KB match found for query.');
            return entry.context;
        }
    }

    // 3. Fall back to hardcoded O2C KB (only for sap_o2c dataset)
    if (config && config.name === 'sap_o2c') {
        for (const entry of O2C_KB) {
            if (entry.keywords.some(kw => {
                const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp(`\\b${escaped}\\b`).test(lower);
            })) {
                return entry.context;
            }
        }
    }

    return null;
}

module.exports = { retrieveContext, buildDynamicKB };
