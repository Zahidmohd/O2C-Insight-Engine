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

const HYBRID_KEYWORDS = [
    'why', 'reason', 'context', 'background', 'tell me about'
];

const RAG_KEYWORDS = [
    'what is', 'define', 'explain', 'how does', 'describe',
    'overview', 'concept of', 'what are'
];

/**
 * @param {string} query
 * @param {object} opts
 * @param {boolean} opts.hasDocuments - Whether the tenant has uploaded documents
 */
function classifyQuery(query, opts = {}) {
    const config = getActiveConfig();
    const lower = query.toLowerCase();

    const hasDomainMatch = config.domainKeywords.some(kw => lower.includes(kw));

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

module.exports = { classifyQuery };
