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
                label: `Sales Order\n${row.salesOrder}`
            });
        }

        // 2. Delivery Document
        if (row.deliveryDocument) {
            const id = `DEL_${row.deliveryDocument}`;
            nodeMap.set(id, {
                id,
                type: 'Delivery',
                label: `Delivery\n${row.deliveryDocument}`
            });
        }

        // 3. Billing Document
        if (row.billingDocument) {
            const id = `BILL_${row.billingDocument}`;
            nodeMap.set(id, {
                id,
                type: 'BillingDocument',
                label: `Billing\n${row.billingDocument}`
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
                label: `Journal Entry\n${row.accountingDocument}`
            });
        }

        // 5. Payment Document
        if (row.clearingAccountingDocument) {
            const id = `PAY_${row.clearingAccountingDocument}`;
            nodeMap.set(id, {
                id,
                type: 'Payment',
                label: `Payment\n${row.clearingAccountingDocument}`
            });
        }

        // 6. Customer
        const customerId = row.customer || row.soldToParty;
        if (customerId) {
            const id = `CUST_${customerId}`;
            nodeMap.set(id, {
                id,
                type: 'Customer',
                label: `Customer\n${customerId}`
            });
        }

        // 7. Product
        if (row.material || row.product) {
            const prod = row.material || row.product;
            const id = `PROD_${prod}`;
            nodeMap.set(id, {
                id,
                type: 'Product',
                label: `Product\n${prod}`
            });
        }

        // 8. Plant
        const plantId = row.plant || row.productionPlant;
        if (plantId) {
            const id = `PLANT_${plantId}`;
            nodeMap.set(id, {
                id,
                type: 'Plant',
                label: `Plant\n${plantId}`
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
        // Happens if we have both SO and DEL in the row, or via explicit ref fields
        const soId = row.referenceSdDocument || row.salesOrder;
        if (soId && row.deliveryDocument) {
            addEdge(`SO_${soId}`, `DEL_${row.deliveryDocument}`, 'FULFILLED_BY');
        }

        // BILLED_AS (Delivery -> Billing)
        if (row.referenceSdDocument && row.billingDocument) {
            // Because referenceSdDocument might be a delivery doc
            // (We assume if BOTH exist on the same row returned by the LLM, they represent the BILLED_AS path)
            addEdge(`DEL_${row.referenceSdDocument}`, `BILL_${row.billingDocument}`, 'BILLED_AS');
        } else if (row.deliveryDocument && row.billingDocument) {
            addEdge(`DEL_${row.deliveryDocument}`, `BILL_${row.billingDocument}`, 'BILLED_AS');
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
        if (soId && customerId) addEdge(`CUST_${customerId}`, `SO_${soId}`, 'ORDERED');
        if (row.billingDocument && customerId) addEdge(`BILL_${row.billingDocument}`, `CUST_${customerId}`, 'BILLED_TO');
    });

    return {
        nodes: Array.from(nodeMap.values()),
        edges: Array.from(edgeMap.values())
    };
}

module.exports = {
    extractGraph
};
