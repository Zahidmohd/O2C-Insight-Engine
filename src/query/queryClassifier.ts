/**
 * Keyword-based query classifier.
 * Returns "SQL" | "RAG" | "HYBRID" | "INVALID" based on query intent signals.
 *
 * IMPORTANT: Domain check runs FIRST — off-topic queries are rejected before
 * any intent classification. HYBRID is checked BEFORE RAG to prevent misclassification.
 * Example: "Explain why order is not billed" contains both "explain" (RAG signal)
 * and "why" (HYBRID signal) — must route to HYBRID so SQL still executes.
 */

const { getActiveConfig } = require('../config/activeDataset');

const HYBRID_KEYWORDS: string[] = [
    'why', 'reason', 'context', 'background', 'tell me about'
];

const RAG_KEYWORDS: string[] = [
    'what is', 'define', 'explain', 'how does', 'describe',
    'overview', 'concept of', 'what are'
];

// Schema exploration queries — always route to RAG (answered by dynamic KB)
const SCHEMA_KEYWORDS: string[] = [
    'what tables', 'which tables', 'list tables', 'show tables',
    'how are', 'how is', 'connected', 'relationship', 'relationships',
    'schema', 'structure', 'columns in', 'fields in',
    'about the dataset', 'about this dataset', 'data flow'
];

/**
 * @param query
 * @param opts
 * @param opts.hasDocuments - Whether the tenant has uploaded documents
 */
function classifyQuery(query: string, opts: { hasDocuments?: boolean } = {}): string {
    const config = getActiveConfig();
    const lower = query.toLowerCase();

    const hasDomainMatch = config.domainKeywords.some((kw: string) => lower.includes(kw));

    // Schema exploration queries always go to RAG (answered by dynamic KB)
    if (SCHEMA_KEYWORDS.some(kw => lower.includes(kw))) return 'RAG';

    // If query matches domain keywords, classify normally
    if (hasDomainMatch) {
        if (HYBRID_KEYWORDS.some(kw => lower.includes(kw))) return 'HYBRID';
        if (RAG_KEYWORDS.some(kw => lower.includes(kw))) return 'RAG';
        return 'SQL';
    }

    // No domain match — but if documents exist, route to RAG (search uploaded content)
    if (opts.hasDocuments) {
        return 'RAG';
    }

    // No domain match, no documents — reject
    return 'INVALID';
}

export { classifyQuery };
