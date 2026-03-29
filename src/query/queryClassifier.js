/**
 * Keyword-based query classifier.
 * Returns "SQL" | "RAG" | "HYBRID" | "INVALID" based on query intent signals.
 *
 * IMPORTANT: Domain check runs FIRST — off-topic queries are rejected before
 * any intent classification. HYBRID is checked BEFORE RAG to prevent misclassification.
 * Example: "Explain why order is not billed" contains both "explain" (RAG signal)
 * and "why" (HYBRID signal) — must route to HYBRID so SQL still executes.
 */

const { domainKeywords } = require('../config/datasetConfig');

const HYBRID_KEYWORDS = [
    'why', 'reason', 'context', 'background', 'tell me about'
];

const RAG_KEYWORDS = [
    'what is', 'define', 'explain', 'how does', 'describe',
    'overview', 'concept of', 'what are'
];

function classifyQuery(query) {
    const lower = query.toLowerCase();

    // Domain gate — reject queries with no O2C relevance
    if (!domainKeywords.some(kw => lower.includes(kw))) return 'INVALID';

    // HYBRID first — these queries need both SQL data AND business context
    if (HYBRID_KEYWORDS.some(kw => lower.includes(kw))) return 'HYBRID';

    // RAG second — explanation-only queries with no document-level data needed
    if (RAG_KEYWORDS.some(kw => lower.includes(kw))) return 'RAG';

    // Default — standard SQL generation path
    return 'SQL';
}

module.exports = { classifyQuery };
