/**
 * Knowledge base with dual-path retrieval:
 * 1. Vector search — if documents have been uploaded, embed the query and search chunks
 * 2. Keyword fallback — curated SAP O2C dictionary with word-boundary matching
 *
 * retrieveContext(query) → Promise<string | null>
 */

const { getChunkCount, searchSimilar } = require('./vectorStore');
const { embed } = require('./embeddingService');

const KB = [
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

/**
 * Retrieves context for a query using vector search (if documents exist) or keyword matching.
 * @param {string} query
 * @returns {Promise<string | null>}
 */
async function retrieveContext(query) {
    // 1. Try vector search if documents have been uploaded
    try {
        const chunkCount = getChunkCount();
        if (chunkCount > 0) {
            const queryEmbedding = await embed(query);
            const results = searchSimilar(queryEmbedding, 5, 0.3);
            if (results.length > 0) {
                console.log(`[RAG] Vector search returned ${results.length} chunks (top score: ${results[0].score.toFixed(3)})`);
                return results.map(r => r.text).join('\n\n');
            }
        }
    } catch (err) {
        console.warn('[RAG] Vector search failed, falling back to keyword KB:', err.message);
    }

    // 2. Fall back to keyword matching
    const lower = query.toLowerCase();
    for (const entry of KB) {
        if (entry.keywords.some(kw => {
            const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`\\b${escaped}\\b`).test(lower);
        })) {
            return entry.context;
        }
    }
    return null;
}

module.exports = { retrieveContext };
