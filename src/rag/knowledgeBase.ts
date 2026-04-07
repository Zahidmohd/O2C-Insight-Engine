/**
 * Knowledge base with triple-path retrieval:
 * 1. Vector search — if documents have been uploaded, embed the query and search chunks
 * 2. Auto-generated KB — built dynamically from the active dataset's schema + relationships
 * 3. Hardcoded KB — curated SAP O2C dictionary (only for sap_o2c dataset)
 *
 * retrieveContext(query) → Promise<string | null>
 */

import { getChunkCount, searchSimilar } from './vectorStore';
import { embed } from './embeddingService';
import { getActiveConfig } from '../config/activeDataset';

// ─── Types ──────────────────────────────────────────────────────────────────

interface KBEntry {
    keywords: string[];
    context: string;
}

// ─── Hardcoded SAP O2C KB (kept for the default dataset) ─────────────────────

const O2C_KB: KBEntry[] = [
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
function buildDynamicKB(config: any): KBEntry[] {
    if (!config || !config.tables) return [];

    const entries: KBEntry[] = [];
    const dsName: string = config.displayName || config.name || 'this dataset';

    // 1. Dataset overview entry
    const tableNames = config.tables.map((t: any) => t.displayName || t.name.replace(/_/g, ' '));
    entries.push({
        keywords: [config.name, ...(config.domainKeywords || []).slice(0, 5), 'dataset', 'overview', 'about', 'tables'],
        context: `The "${dsName}" dataset contains ${config.tables.length} tables: ${tableNames.join(', ')}. ${config.description || ''}`
    });

    // 2. One entry per table
    for (const table of config.tables) {
        const name: string = table.displayName || table.name.replace(/_/g, ' ');
        const nameLower: string = name.toLowerCase();
        const cols: string[] = table.columns || [];
        const pk: string = table.primaryKey && table.primaryKey.length > 0 ? table.primaryKey.join(', ') : 'none detected';

        // Find relationships involving this table
        const rels = (config.relationships || []).filter((r: any) => {
            const fromTable = r.from.split('.')[0];
            const toTable = r.to.split('.')[0];
            return fromTable === table.name || toTable === table.name;
        });

        let relDesc = '';
        if (rels.length > 0) {
            const relParts = rels.map((r: any) => {
                const from = r.from.split('.')[0].replace(/_/g, ' ');
                const to = r.to.split('.')[0].replace(/_/g, ' ');
                return `${from} → ${to} (${r.label || r.joinType || 'JOIN'})`;
            });
            relDesc = ` It connects to: ${relParts.join('; ')}.`;
        }

        // Generate keywords from table name and column names
        const keywords: string[] = [
            nameLower,
            table.name.toLowerCase(),
            ...nameLower.split(' ').filter((w: string) => w.length > 2),
        ];

        entries.push({
            keywords: [...new Set(keywords)],
            context: `The "${name}" table has ${cols.length} columns: ${cols.slice(0, 10).join(', ')}${cols.length > 10 ? ` (+${cols.length - 10} more)` : ''}. Primary key: ${pk}.${relDesc}`
        });
    }

    // 3. Relationships overview entry
    if (config.relationships && config.relationships.length > 0) {
        const relNames = config.relationships.map((r: any) => {
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

// ─── Embed KB Entries as Vector Chunks ──────────────────────────────────────

/**
 * Embeds auto-generated KB entries and stores them as vector chunks.
 * This makes schema knowledge searchable via vector similarity —
 * so "Which table has customer payment info?" finds the payments table
 * even if the user's words don't exactly match any keyword.
 *
 * Called after dataset upload, alongside document embedding.
 * Uses a special document_id = -1 to distinguish KB chunks from user documents.
 */
async function embedKBEntries(config: any, dbConn: any): Promise<number> {
    if (!config || !config.tables) return 0;

    const dynamicEntries = buildDynamicKB(config);
    const o2cEntries = (config.name === 'sap_o2c') ? O2C_KB : [];
    const allEntries = [...dynamicEntries, ...o2cEntries];

    if (allEntries.length === 0) return 0;

    // Check if KB chunks already exist (avoid re-embedding on every query)
    try {
        const existing = await dbConn.getAsync(
            "SELECT COUNT(*) as count FROM document_chunks WHERE document_id = -1"
        );
        if (existing && existing.count > 0) {
            console.log(`[KB] ${existing.count} KB vector chunks already exist, skipping re-embed.`);
            return existing.count;
        }
    } catch (_: any) {
        // Table might not exist yet — that's fine, insertChunks will handle it
    }

    // Embed all KB entry contexts
    const texts = allEntries.map(e => e.context);
    let embeddings: number[][];
    try {
        const { embedBatch } = await import('./embeddingService');
        embeddings = await embedBatch(texts);
    } catch (err: any) {
        console.warn('[KB] Embedding failed, KB will use keyword matching only:', err.message);
        return 0;
    }

    // Store as chunks with document_id = -1 (special marker for KB entries)
    const { insertChunks } = await import('./vectorStore');
    const chunks = allEntries.map((entry, i) => ({
        index: i,
        text: entry.context,
        embedding: embeddings[i],
    }));

    try {
        await insertChunks(dbConn, -1, chunks);
        console.log(`[KB] Embedded and stored ${chunks.length} KB entries as vector chunks.`);
    } catch (err: any) {
        console.warn('[KB] Failed to store KB vectors:', err.message);
        return 0;
    }

    return chunks.length;
}

// ─── Retrieval ───────────────────────────────────────────────────────────────

/**
 * Retrieves context for a query using:
 * 1. Vector search (searches BOTH uploaded documents AND embedded KB entries)
 * 2. Dynamic KB keyword match (fallback if vector search misses)
 * 3. Hardcoded O2C KB (only for sap_o2c dataset)
 */
async function retrieveContext(query: string, dbConn: any = null): Promise<string | null> {
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
                return results.map((r: any) => r.text).join('\n\n');
            }
        }
    } catch (err: any) {
        console.warn('[RAG] Vector search failed, falling back to KB:', err.message);
    }

    // 2. Try dynamic KB (works for ANY dataset)
    const dynamicKB = buildDynamicKB(config);
    const lower = query.toLowerCase();

    for (const entry of dynamicKB) {
        if (entry.keywords.some((kw: string) => {
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
            if (entry.keywords.some((kw: string) => {
                const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp(`\\b${escaped}\\b`).test(lower);
            })) {
                return entry.context;
            }
        }
    }

    return null;
}

export { retrieveContext, buildDynamicKB, embedKBEntries };
