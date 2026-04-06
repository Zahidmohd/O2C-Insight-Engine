/**
 * Deterministic relationship inference between tables.
 * Uses column name matching, value overlap scoring, and cardinality heuristics.
 *
 * inferRelationships(tables) -> [{from, to, label, joinType, confidence, reason, description}]
 */

const SAMPLE_SIZE = 200;
const MIN_CONFIDENCE = 0.5;
const MAX_SUGGESTIONS = 20;

// --- Column Name Matching ----------------------------------------------------

/** Suffixes that suggest a column is a foreign key or identifier */
const ID_PATTERNS: string[] = ['id', '_id', 'key', 'code', 'ref', 'number', 'no', 'num'];

/**
 * Scores column name similarity between two columns from different tables.
 */
function scoreNameMatch(colA: string, colB: string): { score: number; reason: string } | null {
    const lowerA = colA.toLowerCase();
    const lowerB = colB.toLowerCase();

    // Exact match (case-insensitive)
    if (lowerA === lowerB) {
        return { score: 0.5, reason: 'Exact column name match' };
    }

    // One column contains the other as a suffix/prefix component
    // e.g., "customerId" in table A matches "customer_id" in table B
    const normalizedA = lowerA.replace(/_/g, '');
    const normalizedB = lowerB.replace(/_/g, '');
    if (normalizedA === normalizedB) {
        return { score: 0.45, reason: 'Column name match (after normalization)' };
    }

    // Check if one column's base matches the other
    // e.g., "orderId" in orders matches "orderId" in order_items
    for (const pattern of ID_PATTERNS) {
        const baseA = lowerA.replace(new RegExp(`${pattern}$`, 'i'), '');
        const baseB = lowerB.replace(new RegExp(`${pattern}$`, 'i'), '');
        if (baseA && baseB && baseA === baseB && lowerA !== baseA && lowerB !== baseB) {
            return { score: 0.3, reason: `Shared base name "${baseA}" with ID suffix` };
        }
    }

    return null;
}

// --- Value Overlap Scoring ---------------------------------------------------

/**
 * Computes value overlap between two columns across two tables.
 * Returns the ratio of intersection to the smaller set.
 */
function computeValueOverlap(recordsA: any[], colA: string, recordsB: any[], colB: string): { ratio: number; checked: number } {
    const sampleA = recordsA.slice(0, SAMPLE_SIZE);
    const sampleB = recordsB.slice(0, SAMPLE_SIZE);

    const valuesA = new Set<string>();
    for (const r of sampleA) {
        const v = r[colA];
        if (v !== null && v !== undefined && v !== '') valuesA.add(String(v));
    }

    const valuesB = new Set<string>();
    for (const r of sampleB) {
        const v = r[colB];
        if (v !== null && v !== undefined && v !== '') valuesB.add(String(v));
    }

    if (valuesA.size === 0 || valuesB.size === 0) {
        return { ratio: 0, checked: 0 };
    }

    // Count intersection
    let intersection = 0;
    const smaller = valuesA.size <= valuesB.size ? valuesA : valuesB;
    const larger = valuesA.size <= valuesB.size ? valuesB : valuesA;

    for (const v of smaller) {
        if (larger.has(v)) intersection++;
    }

    const ratio = intersection / smaller.size;
    return { ratio, checked: smaller.size };
}

// --- Cardinality Inference ---------------------------------------------------

/**
 * Infers cardinality between two columns.
 */
function inferCardinality(recordsA: any[], colA: string, recordsB: any[], colB: string): '1:1' | '1:N' | 'N:1' | 'N:M' {
    const sampleA = recordsA.slice(0, SAMPLE_SIZE);
    const sampleB = recordsB.slice(0, SAMPLE_SIZE);

    const valsA = sampleA.map((r: any) => r[colA]).filter((v: any) => v != null && v !== '');
    const valsB = sampleB.map((r: any) => r[colB]).filter((v: any) => v != null && v !== '');

    const uniqueA = new Set(valsA.map(String));
    const uniqueB = new Set(valsB.map(String));

    const aIsUnique = uniqueA.size === valsA.length;
    const bIsUnique = uniqueB.size === valsB.length;

    if (aIsUnique && bIsUnique) return '1:1';
    if (aIsUnique && !bIsUnique) return '1:N';
    if (!aIsUnique && bIsUnique) return 'N:1';
    return 'N:M';
}

// --- Join Type Suggestion ----------------------------------------------------

/**
 * Suggests a join type based on overlap ratio.
 * High overlap (>=0.7) -> JOIN; lower -> LEFT JOIN.
 */
function suggestJoinType(overlapRatio: number): string {
    return overlapRatio >= 0.7 ? 'JOIN' : 'LEFT JOIN';
}

// --- Relationship Label Generation -------------------------------------------

/**
 * Generates a human-readable relationship label.
 */
function generateLabel(fromTable: string, toTable: string): string {
    // Check for common parent-child patterns
    if (toTable.includes(fromTable) || toTable.startsWith(fromTable.split('_')[0])) {
        return 'HAS_ITEMS';
    }
    if (fromTable.includes(toTable) || fromTable.startsWith(toTable.split('_')[0])) {
        return 'BELONGS_TO';
    }
    return 'LINKS_TO';
}

// --- Data Type Detection -----------------------------------------------------

/**
 * Infers the dominant data type of a column from sample values.
 * Returns 'number' if >80% of non-null samples are numeric, else 'string'.
 */
function inferColumnType(records: any[], col: string): 'number' | 'string' | 'unknown' {
    const sample = records.slice(0, SAMPLE_SIZE);
    let numericCount = 0;
    let total = 0;

    for (const r of sample) {
        const v = r[col];
        if (v === null || v === undefined || v === '') continue;
        total++;
        if (!isNaN(v) && String(v).trim() !== '') numericCount++;
    }

    if (total === 0) return 'unknown';
    return (numericCount / total) > 0.8 ? 'number' : 'string';
}

// --- Many-to-Many Detection --------------------------------------------------

const M2M_DUP_THRESHOLD = 0.5;

/**
 * Checks whether both sides of a column pair have high value duplication,
 * indicating a many-to-many relationship that should be rejected.
 */
function isManyToMany(recordsA: any[], colA: string, recordsB: any[], colB: string): boolean {
    const freqA = new Map<string, number>();
    const freqB = new Map<string, number>();

    for (const r of recordsA.slice(0, SAMPLE_SIZE)) {
        const v = r[colA];
        if (v != null && v !== '') {
            const key = String(v);
            freqA.set(key, (freqA.get(key) || 0) + 1);
        }
    }

    for (const r of recordsB.slice(0, SAMPLE_SIZE)) {
        const v = r[colB];
        if (v != null && v !== '') {
            const key = String(v);
            freqB.set(key, (freqB.get(key) || 0) + 1);
        }
    }

    if (freqA.size === 0 || freqB.size === 0) return false;

    const dupRatioA = [...freqA.values()].filter((c: number) => c > 1).length / freqA.size;
    const dupRatioB = [...freqB.values()].filter((c: number) => c > 1).length / freqB.size;

    return dupRatioA > M2M_DUP_THRESHOLD && dupRatioB > M2M_DUP_THRESHOLD;
}

// --- Score a Relationship Candidate ------------------------------------------

/**
 * Computes a combined confidence score for a column pair across tables.
 */
function scoreRelationship(
    tableA: string, colA: string,
    tableB: string, colB: string,
    recordsA: any[], recordsB: any[]
): { confidence: number; reason: string } | null {
    // Skip self-references
    if (tableA === tableB) return null;

    // Skip columns with mismatched data types (e.g., numeric ID vs. text name)
    const typeA = inferColumnType(recordsA, colA);
    const typeB = inferColumnType(recordsB, colB);
    if (typeA !== 'unknown' && typeB !== 'unknown' && typeA !== typeB) return null;

    // Skip many-to-many pairs (both sides have high duplication)
    if (isManyToMany(recordsA, colA, recordsB, colB)) return null;

    let totalScore = 0;
    const reasons: string[] = [];

    // 1. Column name matching
    const nameMatch = scoreNameMatch(colA, colB);
    if (nameMatch) {
        totalScore += nameMatch.score;
        reasons.push(nameMatch.reason);
    }

    // 2. Value overlap -- weighted higher (0.6) so strong overlap alone can pass threshold
    const overlap = computeValueOverlap(recordsA, colA, recordsB, colB);
    if (overlap.checked > 0 && overlap.ratio > 0) {
        const overlapScore = overlap.ratio * 0.6;
        totalScore += overlapScore;
        reasons.push(`${Math.round(overlap.ratio * 100)}% value overlap (${overlap.checked} values checked)`);
    }

    // Require at least name match OR significant value overlap
    if (totalScore < MIN_CONFIDENCE) return null;

    // Cap at 1.0
    const confidence = Math.min(1.0, parseFloat(totalScore.toFixed(2)));

    return {
        confidence,
        reason: reasons.join(' + ')
    };
}

// --- Main Entry Point --------------------------------------------------------

interface TableInput {
    name: string;
    columns: string[];
    records: any[];
}

interface InferredRelationship {
    from: string;
    to: string;
    label: string;
    joinType: string;
    confidence: number;
    level: string;
    reason: string;
    description: string;
}

/**
 * Infers relationships across all table pairs.
 */
function inferRelationships(tables: TableInput[]): InferredRelationship[] {
    if (!tables || tables.length < 2) return [];

    const candidates: InferredRelationship[] = [];
    const seen = new Set<string>(); // Deduplicate bidirectional matches

    for (let i = 0; i < tables.length; i++) {
        for (let j = 0; j < tables.length; j++) {
            if (i === j) continue;

            const tA = tables[i];
            const tB = tables[j];

            for (const colA of tA.columns) {
                for (const colB of tB.columns) {
                    const result = scoreRelationship(
                        tA.name, colA, tB.name, colB,
                        tA.records, tB.records
                    );

                    if (!result) continue;

                    // Deduplicate: A.x->B.y and B.y->A.x -- keep higher confidence
                    const pairKey = [
                        `${tA.name}.${colA}`,
                        `${tB.name}.${colB}`
                    ].sort().join('\u2194');

                    if (seen.has(pairKey)) continue;
                    seen.add(pairKey);

                    // Orient: put 1-side as "from", N-side as "to"
                    const cardinality = inferCardinality(tA.records, colA, tB.records, colB);
                    let fromRef: string, toRef: string, fromTable: string, toTable: string;

                    if (cardinality === 'N:1') {
                        // A is N-side, B is 1-side -> from=B, to=A
                        fromRef = `${tB.name}.${colB}`;
                        toRef = `${tA.name}.${colA}`;
                        fromTable = tB.name;
                        toTable = tA.name;
                    } else {
                        // Default: A is 1-side (or equal), B is N-side
                        fromRef = `${tA.name}.${colA}`;
                        toRef = `${tB.name}.${colB}`;
                        fromTable = tA.name;
                        toTable = tB.name;
                    }

                    const overlap = computeValueOverlap(tA.records, colA, tB.records, colB);

                    candidates.push({
                        from: fromRef,
                        to: toRef,
                        label: generateLabel(fromTable, toTable),
                        joinType: suggestJoinType(overlap.ratio),
                        confidence: result.confidence,
                        level: result.confidence >= 0.8 ? 'strong' : 'medium',
                        reason: result.reason,
                        description: `${fromTable} to ${toTable}`
                    });
                }
            }
        }
    }

    // Sort by confidence descending, return top N
    candidates.sort((a, b) => b.confidence - a.confidence);
    return candidates.slice(0, MAX_SUGGESTIONS);
}

export {
    scoreNameMatch,
    computeValueOverlap,
    inferCardinality,
    inferRelationships
};
