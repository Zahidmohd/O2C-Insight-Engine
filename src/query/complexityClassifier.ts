/**
 * Query Complexity Classifier
 * Classifies natural language queries into SIMPLE / MODERATE / COMPLEX
 * to drive model routing: small model for simple, large model for complex.
 */

const { getActiveConfig } = require('../config/activeDataset');

/**
 * SIMPLE: Single-table listing, basic lookups, no JOINs/aggregations
 * MODERATE: Single JOIN, basic aggregation, filtered lookups
 * COMPLEX: Multi-JOIN, trace/flow, subqueries, advanced aggregations, comparisons
 */

const COMPLEX_SIGNALS: RegExp[] = [
    /\b(trace|flow|chain|end.to.end|lifecycle|journey)\b/i,
    /\b(compare|comparison|versus|vs\.?)\b/i,
    /\b(subquer|nested|correlated)\b/i,
    /\b(having|union|intersect|except)\b/i,
    /\b(between\s+\w+\s+and\s+\w+)\b/i,
    /\b(rank|dense_rank|row_number|partition\s+by|window)\b/i,
    /\b(trend|over\s+time|month.over.month|year.over.year|growth)\b/i,
    /\b(percent|percentage|ratio|rate)\b/i,
    /\b(missing|incomplete|broken|not\s+(?:billed|delivered|paid|shipped))\b/i,
    /\b(multi|across\s+(?:all|multiple)|cross)\b/i,
];

const MODERATE_SIGNALS: RegExp[] = [
    /\b(top\s+\d+|bottom\s+\d+|highest|lowest|most|least|best|worst)\b/i,
    /\b(count|total|sum|average|avg|min|max)\b/i,
    /\b(group\s+by|grouped|per\s+\w+)\b/i,
    /\b(where|filter|condition|greater|less|more\s+than|above|below)\b/i,
    /\b(join|relationship|linked|connected|related)\b/i,
    /\b(sort|order\s+by|sorted|ascending|descending)\b/i,
    /\b(between|range|from\s+\d|date)\b/i,
    /\b(specific|particular|given)\b/i,
];

const SIMPLE_SIGNALS: RegExp[] = [
    /^(show|list|get|find|fetch|display|give)\b/i,
    /\b(all|every)\s+\w+s?\b/i,
];

/**
 * Classifies query complexity for model routing.
 * @param query - Natural language query
 * @returns {{ level: 'SIMPLE'|'MODERATE'|'COMPLEX', reason: string }}
 */
function classifyComplexity(query: string): { level: string; reason: string } {
    const lower = query.toLowerCase().trim();

    // Count signals
    let complexScore = 0;
    let moderateScore = 0;
    let simpleScore = 0;
    const reasons: string[] = [];

    for (const pattern of COMPLEX_SIGNALS) {
        if (pattern.test(lower)) {
            complexScore++;
            reasons.push(`complex:${pattern.source.slice(0, 30)}`);
        }
    }

    for (const pattern of MODERATE_SIGNALS) {
        if (pattern.test(lower)) {
            moderateScore++;
            reasons.push(`moderate:${pattern.source.slice(0, 30)}`);
        }
    }

    for (const pattern of SIMPLE_SIGNALS) {
        if (pattern.test(lower)) {
            simpleScore++;
        }
    }

    // Word count heuristic — longer queries tend to be more complex
    const wordCount = lower.split(/\s+/).length;
    if (wordCount > 15) {
        moderateScore++;
        reasons.push('long query (>15 words)');
    }
    if (wordCount > 25) {
        complexScore++;
        reasons.push('very long query (>25 words)');
    }

    // Multiple entity references suggest JOINs — derive from active config
    const config = getActiveConfig();
    const entityNames: string[] = (config.entities || []).map((e: string) => e.toLowerCase());
    const tableNames: string[] = (config.tables || []).map((t: any) => (t.displayName || t.name.replace(/_/g, ' ')).toLowerCase());
    const allEntities = [...new Set([...entityNames, ...tableNames])];

    const uniqueEntities = new Set<string>();
    for (const entity of allEntities) {
        if (lower.includes(entity)) uniqueEntities.add(entity);
    }
    if (uniqueEntities.size >= 3) {
        complexScore++;
        reasons.push(`${uniqueEntities.size} entity types mentioned`);
    } else if (uniqueEntities.size === 2) {
        moderateScore++;
        reasons.push('2 entity types mentioned');
    }

    // Decision
    if (complexScore >= 2) {
        return { level: 'COMPLEX', reason: reasons.join(', ') };
    }
    if (complexScore === 1 && moderateScore >= 1) {
        return { level: 'COMPLEX', reason: reasons.join(', ') };
    }
    if (moderateScore >= 2) {
        return { level: 'MODERATE', reason: reasons.join(', ') };
    }
    if (moderateScore === 1) {
        return { level: 'MODERATE', reason: reasons.join(', ') };
    }

    return { level: 'SIMPLE', reason: simpleScore > 0 ? 'simple listing pattern' : 'no complexity signals' };
}

export { classifyComplexity };
