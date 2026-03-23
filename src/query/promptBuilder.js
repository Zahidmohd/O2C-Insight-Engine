/**
 * Prompts construction for the natural language to SQL engine.
 */

// This schema omits unnecessary tables or columns to save context window tokens,
// focusing on the validated core O2C flow and critical master data.
const SCHEMA_CONTEXT = `
You are a database expert generating SQL for an SAP Order-to-Cash (O2C) system.
The database is SQLite. Do NOT use MySQL, PostgreSQL, or SQL Server specific syntax.

--- DATABASE SCHEMA ---

1. sales_order_headers (salesOrder PK, soldToParty, creationDate, totalNetAmount, transactionCurrency)
2. sales_order_items (salesOrder, salesOrderItem, material, requestedQuantity, netAmount, productionPlant)
3. outbound_delivery_headers (deliveryDocument PK, actualGoodsMovementDate, shippingPoint)
4. outbound_delivery_items (deliveryDocument, deliveryDocumentItem, actualDeliveryQuantity, plant, referenceSdDocument, referenceSdDocumentItem)
5. billing_document_headers (billingDocument PK, billingDocumentDate, totalNetAmount, companyCode, fiscalYear, accountingDocument, soldToParty, billingDocumentIsCancelled)
6. billing_document_items (billingDocument, billingDocumentItem, material, billingQuantity, netAmount, referenceSdDocument, referenceSdDocumentItem)
7. journal_entry_items_accounts_receivable (companyCode, fiscalYear, accountingDocument, accountingDocumentItem, customer, amountInTransactionCurrency, clearingAccountingDocument)
8. payments_accounts_receivable (companyCode, fiscalYear, accountingDocument, accountingDocumentItem, clearingAccountingDocument, amountInTransactionCurrency, customer, postingDate)
9. business_partners (businessPartner PK, customer, businessPartnerName)
10. products (product PK, productType, productGroup)
11. product_descriptions (product, language, productDescription)

--- VALIDATED JOIN RELATIONSHIPS (MUST USE THESE) ---

1. Sales Order to Delivery (FULFILLED_BY):
   JOIN outbound_delivery_items odi 
     ON odi.referenceSdDocument = so_items.salesOrder 
    AND odi.referenceSdDocumentItem = so_items.salesOrderItem

2. Delivery to Billing (BILLED_AS):
   JOIN billing_document_items bdi 
     ON bdi.referenceSdDocument = odi.deliveryDocument
    AND bdi.referenceSdDocumentItem = odi.deliveryDocumentItem
   *CRITICAL NOTE: Do NOT use printf() or padding in SQL for this join. 
    The padding mismatch was safely resolved during data ingestion!*

3. Billing to Journal Entry (POSTED_AS):
   JOIN journal_entry_items_accounts_receivable je 
     ON je.accountingDocument = bdh.accountingDocument
    AND je.companyCode = bdh.companyCode
    AND je.fiscalYear = bdh.fiscalYear

4. Journal Entry to Payment (CLEARED_BY):
   JOIN payments_accounts_receivable pay 
     ON pay.clearingAccountingDocument = je.clearingAccountingDocument
    AND pay.companyCode = je.companyCode

5. Documents to Customer:
   JOIN business_partners bp ON bp.customer = [table].soldToParty (or customer)

--- INSTRUCTIONS ---
- Respond with standard SQLite SQL ONLY.
- No markdown formatting wrappers like \`\`\`sql. Just the raw SQL string.
- Only SELECT queries. Never DELETE, UPDATE, DROP, PRAGMA.
- Do not make up tables. Use only the provided schema.
- Try to answer the user's question as accurately and simply as possible.
`;

function buildPrompt(userQuery) {
    return `${SCHEMA_CONTEXT}\n\nUser Question: ${userQuery}\n\nGenerate the SQL query to answer this question.`;
}

module.exports = {
    buildPrompt,
    SCHEMA_CONTEXT
};
