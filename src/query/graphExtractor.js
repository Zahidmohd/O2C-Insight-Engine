/**
 * Extracts nodes and edges dynamically from raw SQL result sets.
 * Maps relational column data into Graph representations for Cytoscape.js.
 */

function extractGraph(rows) {
    const nodeMap = new Map();
    const edgeMap = new Map(); // Use Map to prevent exact duplicate edges

    // Iterate over each raw data row returned by SQLite
    rows.forEach(row => {
        // --- NODE EXTRACTION ---

        // 1. Sales Order
        if (row.salesOrder) {
            const id = `SO_${row.salesOrder}`;
            nodeMap.set(id, {
                id,
                type: 'SalesOrder',
                label: `Sales Order\n${row.salesOrder}`,
                properties: row
            });
        }

        // 2. Delivery Document
        if (row.deliveryDocument) {
            const id = `DEL_${row.deliveryDocument}`;
            nodeMap.set(id, {
                id,
                type: 'Delivery',
                label: `Delivery\n${row.deliveryDocument}`,
                properties: row
            });
        }

        // 3. Billing Document
        if (row.billingDocument) {
            const id = `BILL_${row.billingDocument}`;
            nodeMap.set(id, {
                id,
                type: 'BillingDocument',
                label: `Billing\n${row.billingDocument}`,
                properties: row
            });
        }

        // 4. Journal Entry
        if (row.accountingDocument && row.accountingDocumentType !== 'DZ') { 
            // Often RV is billing, DZ is payment, but we will classify based on context if we can.
            // If it came from billing_document_headers -> accountingDocument, it's a JE.
            const id = `JE_${row.accountingDocument}`;
            nodeMap.set(id, {
                id,
                type: 'JournalEntry',
                label: `Journal Entry\n${row.accountingDocument}`,
                properties: row
            });
        }

        // 5. Payment Document
        if (row.clearingAccountingDocument) {
            const id = `PAY_${row.clearingAccountingDocument}`;
            nodeMap.set(id, {
                id,
                type: 'Payment',
                label: `Payment\n${row.clearingAccountingDocument}`,
                properties: row
            });
        }

        // 6. Customer
        const customerId = row.customer || row.soldToParty;
        if (customerId) {
            const id = `CUST_${customerId}`;
            nodeMap.set(id, {
                id,
                type: 'Customer',
                label: `Customer\n${customerId}`,
                properties: row
            });
        }



        // --- EDGE EXTRACTION ---
        // Generates an edge key to prevent duplicate edges

        function addEdge(source, target, type) {
            if (source && target) {
                const edgeId = `${source}->${target}[${type}]`;
                if (!edgeMap.has(edgeId)) {
                    edgeMap.set(edgeId, { source, target, type });
                }
            }
        }

        // FULFILLED_BY (SalesOrder -> Delivery)
        if (row.salesOrder && row.deliveryDocument) {
            addEdge(`SO_${row.salesOrder}`, `DEL_${row.deliveryDocument}`, 'FULFILLED_BY');
        } else if (row.referenceSdDocument && row.deliveryDocument && !row.salesOrder) {
            // Pure fallback if Sales Order is entirely omitted but a generic reference exists natively.
            addEdge(`SO_${row.referenceSdDocument}`, `DEL_${row.deliveryDocument}`, 'FULFILLED_BY');
        }

        // BILLED_AS (Delivery -> Billing) or BILLED_DIRECTLY (SalesOrder -> Billing)
        if (row.deliveryDocument && row.billingDocument) {
            addEdge(`DEL_${row.deliveryDocument}`, `BILL_${row.billingDocument}`, 'BILLED_AS');
        } else if (row.salesOrder && row.billingDocument && !row.deliveryDocument) {
            addEdge(`SO_${row.salesOrder}`, `BILL_${row.billingDocument}`, 'BILLED_DIRECTLY');
        }

        // POSTED_AS (Billing -> Journal Entry)
        if (row.billingDocument && row.accountingDocument) {
            addEdge(`BILL_${row.billingDocument}`, `JE_${row.accountingDocument}`, 'POSTED_AS');
        }

        // CLEARED_BY (Journal Entry -> Payment)
        if (row.accountingDocument && row.clearingAccountingDocument) {
            addEdge(`JE_${row.accountingDocument}`, `PAY_${row.clearingAccountingDocument}`, 'CLEARED_BY');
        }

        // Customer Links
        const soId = row.salesOrder || row.referenceSdDocument; // fallback correctly
        if (soId && customerId) addEdge(`CUST_${customerId}`, `SO_${soId}`, 'ORDERED');
        if (row.billingDocument && customerId) addEdge(`BILL_${row.billingDocument}`, `CUST_${customerId}`, 'BILLED_TO');
    });

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

    return { nodes, edges };
}

module.exports = {
    extractGraph
};
