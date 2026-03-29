/**
 * Extracts nodes and edges dynamically from raw SQL result sets.
 * Maps relational column data into Graph representations for Cytoscape.js.
 *
 * Limits: MAX_NODES caps graph size for UI stability.
 * Dedup:  Nodes are only created once per ID (first occurrence wins).
 */

const MAX_NODES = 200;

function extractGraph(rows) {
    const nodeMap = new Map();
    const edgeMap = new Map(); // Use Map to prevent exact duplicate edges
    let nodeLimitReached = false;

    // Helper: only treat non-null, non-empty strings as valid field values
    function valid(val) {
        return val !== null && val !== undefined && val !== '';
    }

    // Helper: add a node only if it doesn't already exist AND we haven't hit the limit
    function addNode(id, type, label, row) {
        if (nodeMap.has(id)) return; // dedup — first occurrence wins
        if (nodeMap.size >= MAX_NODES) {
            nodeLimitReached = true;
            return;
        }
        nodeMap.set(id, { id, type, label, properties: row });
    }

    // Iterate over each raw data row returned by SQLite
    for (const row of rows) {
        // --- NODE EXTRACTION (skip if key field missing) ---

        // 1. Sales Order
        if (valid(row.salesOrder)) {
            addNode(`SO_${row.salesOrder}`, 'SalesOrder', `Sales Order\n${row.salesOrder}`, row);
        }

        // 2. Delivery Document
        if (valid(row.deliveryDocument)) {
            addNode(`DEL_${row.deliveryDocument}`, 'Delivery', `Delivery\n${row.deliveryDocument}`, row);
        }

        // 3. Billing Document
        if (valid(row.billingDocument)) {
            addNode(`BILL_${row.billingDocument}`, 'BillingDocument', `Billing\n${row.billingDocument}`, row);
        }

        // 4. Journal Entry
        if (valid(row.accountingDocument) && row.accountingDocumentType !== 'DZ') {
            addNode(`JE_${row.accountingDocument}`, 'JournalEntry', `Journal Entry\n${row.accountingDocument}`, row);
        }

        // 5. Payment Document
        if (valid(row.clearingAccountingDocument)) {
            addNode(`PAY_${row.clearingAccountingDocument}`, 'Payment', `Payment\n${row.clearingAccountingDocument}`, row);
        }

        // 6. Customer
        const customerId = row.customer || row.soldToParty;
        if (valid(customerId)) {
            addNode(`CUST_${customerId}`, 'Customer', `Customer\n${customerId}`, row);
        }

        // --- EDGE EXTRACTION ---
        // Only create edge if BOTH source and target nodes exist in nodeMap

        function addEdge(source, target, type) {
            if (source && target && nodeMap.has(source) && nodeMap.has(target)) {
                const edgeId = `${source}->${target}[${type}]`;
                if (!edgeMap.has(edgeId)) {
                    edgeMap.set(edgeId, { source, target, type });
                }
            }
        }

        // FULFILLED_BY (SalesOrder -> Delivery)
        if (valid(row.salesOrder) && valid(row.deliveryDocument)) {
            addEdge(`SO_${row.salesOrder}`, `DEL_${row.deliveryDocument}`, 'FULFILLED_BY');
        } else if (valid(row.referenceSdDocument) && valid(row.deliveryDocument) && !valid(row.salesOrder)) {
            addEdge(`SO_${row.referenceSdDocument}`, `DEL_${row.deliveryDocument}`, 'FULFILLED_BY');
        }

        // BILLED_AS (Delivery -> Billing) or BILLED_DIRECTLY (SalesOrder -> Billing)
        if (valid(row.deliveryDocument) && valid(row.billingDocument)) {
            addEdge(`DEL_${row.deliveryDocument}`, `BILL_${row.billingDocument}`, 'BILLED_AS');
        } else if (valid(row.salesOrder) && valid(row.billingDocument) && !valid(row.deliveryDocument)) {
            addEdge(`SO_${row.salesOrder}`, `BILL_${row.billingDocument}`, 'BILLED_DIRECTLY');
        }

        // POSTED_AS (Billing -> Journal Entry)
        if (valid(row.billingDocument) && valid(row.accountingDocument)) {
            addEdge(`BILL_${row.billingDocument}`, `JE_${row.accountingDocument}`, 'POSTED_AS');
        }

        // CLEARED_BY (Journal Entry -> Payment)
        if (valid(row.accountingDocument) && valid(row.clearingAccountingDocument)) {
            addEdge(`JE_${row.accountingDocument}`, `PAY_${row.clearingAccountingDocument}`, 'CLEARED_BY');
        }

        // Customer Links
        const soId = row.salesOrder || row.referenceSdDocument;
        if (valid(soId) && valid(customerId)) addEdge(`CUST_${customerId}`, `SO_${soId}`, 'ORDERED');
        if (valid(row.billingDocument) && valid(customerId)) addEdge(`BILL_${row.billingDocument}`, `CUST_${customerId}`, 'BILLED_TO');
    }

    const edges = Array.from(edgeMap.values());
    let nodes = Array.from(nodeMap.values());

    // Only remove orphan nodes when edges exist (flow traces).
    // For listing queries (no edges), keep all nodes.
    if (edges.length > 0) {
        const connectedNodeIds = new Set();
        edges.forEach(e => {
            connectedNodeIds.add(e.source);
            connectedNodeIds.add(e.target);
        });
        nodes = nodes.filter(n => connectedNodeIds.has(n.id));
    }

    return { nodes, edges, graphTruncated: nodeLimitReached };
}

module.exports = {
    extractGraph
};
