/**
 * Extracts nodes and edges dynamically from raw SQL result sets.
 * Maps relational column data into Graph representations for Cytoscape.js.
 *
 * Dual-path:
 *   - O2C datasets use hardcoded extraction (preserves quality / edge semantics)
 *   - Generic datasets derive nodes/edges from config.relationships at runtime
 *
 * Limits: MAX_NODES caps graph size for UI stability.
 * Dedup:  Nodes are only created once per ID (first occurrence wins).
 */

const MAX_NODES = 200;

// ─── Shared Helpers ──────────────────────────────────────────────────────────

function valid(val: any): boolean {
    return val !== null && val !== undefined && val !== '';
}

function createGraphState(): { nodeMap: Map<string, any>; edgeMap: Map<string, any>; nodeLimitReached: boolean } {
    return {
        nodeMap: new Map(),
        edgeMap: new Map(),
        nodeLimitReached: false
    };
}

function addNode(state: any, id: string, type: string, label: string, row: any): void {
    if (state.nodeMap.has(id)) return;
    if (state.nodeMap.size >= MAX_NODES) {
        state.nodeLimitReached = true;
        return;
    }
    state.nodeMap.set(id, { id, type, label, properties: row });
}

function addEdge(state: any, source: string, target: string, type: string): void {
    if (source && target && state.nodeMap.has(source) && state.nodeMap.has(target)) {
        const edgeId = `${source}->${target}[${type}]`;
        if (!state.edgeMap.has(edgeId)) {
            state.edgeMap.set(edgeId, { source, target, type });
        }
    }
}

function finalizeGraph(state: any): { nodes: any[]; edges: any[]; graphTruncated: boolean } {
    const edges = Array.from(state.edgeMap.values());
    let nodes = Array.from(state.nodeMap.values());

    // Only remove orphan nodes when edges exist (flow traces).
    // For listing queries (no edges), keep all nodes.
    if (edges.length > 0) {
        const connectedNodeIds = new Set<string>();
        edges.forEach((e: any) => {
            connectedNodeIds.add(e.source);
            connectedNodeIds.add(e.target);
        });
        nodes = nodes.filter((n: any) => connectedNodeIds.has(n.id));
    }

    return { nodes, edges, graphTruncated: state.nodeLimitReached };
}

// ─── O2C-Specific Extraction (preserved for quality) ─────────────────────────

function extractGraphO2C(rows: any[]): { nodes: any[]; edges: any[]; graphTruncated: boolean } {
    const state = createGraphState();

    for (const row of rows) {
        // --- NODE EXTRACTION ---
        if (valid(row.salesOrder)) {
            addNode(state, `SO_${row.salesOrder}`, 'SalesOrder', `Sales Order\n${row.salesOrder}`, row);
        }
        if (valid(row.deliveryDocument)) {
            addNode(state, `DEL_${row.deliveryDocument}`, 'Delivery', `Delivery\n${row.deliveryDocument}`, row);
        }
        if (valid(row.billingDocument)) {
            addNode(state, `BILL_${row.billingDocument}`, 'BillingDocument', `Billing\n${row.billingDocument}`, row);
        }
        if (valid(row.accountingDocument) && row.accountingDocumentType !== 'DZ') {
            addNode(state, `JE_${row.accountingDocument}`, 'JournalEntry', `Journal Entry\n${row.accountingDocument}`, row);
        }
        if (valid(row.clearingAccountingDocument)) {
            addNode(state, `PAY_${row.clearingAccountingDocument}`, 'Payment', `Payment\n${row.clearingAccountingDocument}`, row);
        }
        const customerId = row.customer || row.soldToParty;
        if (valid(customerId)) {
            addNode(state, `CUST_${customerId}`, 'Customer', `Customer\n${customerId}`, row);
        }

        // --- EDGE EXTRACTION ---
        if (valid(row.salesOrder) && valid(row.deliveryDocument)) {
            addEdge(state, `SO_${row.salesOrder}`, `DEL_${row.deliveryDocument}`, 'FULFILLED_BY');
        } else if (valid(row.referenceSdDocument) && valid(row.deliveryDocument) && !valid(row.salesOrder)) {
            addEdge(state, `SO_${row.referenceSdDocument}`, `DEL_${row.deliveryDocument}`, 'FULFILLED_BY');
        }

        if (valid(row.deliveryDocument) && valid(row.billingDocument)) {
            addEdge(state, `DEL_${row.deliveryDocument}`, `BILL_${row.billingDocument}`, 'BILLED_AS');
        } else if (valid(row.salesOrder) && valid(row.billingDocument) && !valid(row.deliveryDocument)) {
            addEdge(state, `SO_${row.salesOrder}`, `BILL_${row.billingDocument}`, 'BILLED_DIRECTLY');
        }

        if (valid(row.billingDocument) && valid(row.accountingDocument)) {
            addEdge(state, `BILL_${row.billingDocument}`, `JE_${row.accountingDocument}`, 'POSTED_AS');
        }

        if (valid(row.accountingDocument) && valid(row.clearingAccountingDocument)) {
            addEdge(state, `JE_${row.accountingDocument}`, `PAY_${row.clearingAccountingDocument}`, 'CLEARED_BY');
        }

        const soId = row.salesOrder || row.referenceSdDocument;
        if (valid(soId) && valid(customerId)) addEdge(state, `CUST_${customerId}`, `SO_${soId}`, 'ORDERED');
        if (valid(row.billingDocument) && valid(customerId)) addEdge(state, `BILL_${row.billingDocument}`, `CUST_${customerId}`, 'BILLED_TO');
    }

    return finalizeGraph(state);
}

// ─── Generic Extraction (config-driven) ──────────────────────────────────────

/**
 * Parses relationship endpoints into { table, cols } pairs.
 * "orders.order_id" → { table: "orders", cols: ["order_id"] }
 * "items.doc+item"  → { table: "items", cols: ["doc", "item"] }
 */
function parseRelRef(ref: string): { table: string; cols: string[] } | null {
    const dotIdx = ref.indexOf('.');
    if (dotIdx === -1) return null;
    const table = ref.substring(0, dotIdx);
    const cols = ref.substring(dotIdx + 1).split('+');
    return { table, cols };
}

function extractGraphGeneric(rows: any[], config: any): { nodes: any[]; edges: any[]; graphTruncated: boolean } {
    const state = createGraphState();

    // Build table display name lookup
    const tableDisplayNames = new Map<string, string>();
    for (const t of config.tables) {
        tableDisplayNames.set(t.name, t.displayName || t.name);
    }

    // Parse relationships into usable form
    const rels = (config.relationships || []).map((r: any) => {
        const from = parseRelRef(r.from);
        const to = parseRelRef(r.to);
        if (!from || !to) return null;
        return { from, to, label: r.label || 'LINKS_TO' };
    }).filter(Boolean);

    // Collect all table+column pairs that participate in relationships
    // so we know which columns to use for node creation
    const nodeColumns = new Map<string, Set<string>>(); // tableName → Set of column names
    for (const rel of rels) {
        for (const side of [rel.from, rel.to]) {
            if (!nodeColumns.has(side.table)) nodeColumns.set(side.table, new Set());
            for (const col of side.cols) {
                nodeColumns.get(side.table)!.add(col);
            }
        }
    }

    for (const row of rows) {
        // Create nodes for each relationship column that has a value in this row
        for (const [tableName, cols] of nodeColumns) {
            for (const col of cols) {
                if (!valid(row[col])) continue;
                const nodeId = `${tableName}_${col}_${row[col]}`;
                const displayName = tableDisplayNames.get(tableName) || tableName;
                addNode(state, nodeId, displayName, `${displayName}\n${row[col]}`, row);
            }
        }

        // Create edges based on relationships
        for (const rel of rels) {
            // Build composite key for from-side and to-side
            const fromVals = rel.from.cols.map((c: string) => row[c]);
            const toVals = rel.to.cols.map((c: string) => row[c]);

            // Skip if any value is missing
            if (fromVals.some((v: any) => !valid(v)) || toVals.some((v: any) => !valid(v))) continue;

            // For single-column keys, use the simple node ID
            // For composite keys, use the first column as the node identifier
            const fromNodeId = `${rel.from.table}_${rel.from.cols[0]}_${fromVals[0]}`;
            const toNodeId = `${rel.to.table}_${rel.to.cols[0]}_${toVals[0]}`;

            addEdge(state, fromNodeId, toNodeId, rel.label);
        }
    }

    return finalizeGraph(state);
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Extracts graph from result rows.
 * Uses O2C-specific logic for the default SAP dataset, generic logic for all others.
 *
 * @param rows - SQL result rows
 * @param config - Active dataset config (null = O2C default)
 * @returns {{ nodes, edges, graphTruncated }}
 */
function extractGraph(rows: any[], config: any = null): { nodes: any[]; edges: any[]; graphTruncated: boolean } {
    if (!rows || rows.length === 0) {
        return { nodes: [], edges: [], graphTruncated: false };
    }

    if (!config || config.name === 'sap_o2c') {
        return extractGraphO2C(rows);
    }

    return extractGraphGeneric(rows, config);
}

export { extractGraph };
