/**
 * Dataset configuration for the SAP O2C domain.
 *
 * Single source of truth for:
 *   - Table definitions (names, columns, primary keys, transforms)
 *   - Validated join relationships between tables
 *   - Domain keywords for query classification and guardrails
 *   - Entity types for explanation extraction
 *   - Relationship labels for graph context
 *
 * Consumed by: promptBuilder, queryClassifier, queryService, loader, init.
 */

export const datasetConfig: any = {
    name: 'sap_o2c',
    displayName: 'SAP Order-to-Cash',
    description: 'SAP O2C flow: Sales Order -> Delivery -> Billing -> Journal Entry -> Payment',
    dataDir: '../../sap-o2c-data',

    tables: [
        {
            name: 'sales_order_headers',
            displayName: 'Sales Order',
            directory: 'sales_order_headers',
            columns: [
                'salesOrder', 'salesOrderType', 'salesOrganization', 'distributionChannel',
                'organizationDivision', 'salesGroup', 'salesOffice', 'soldToParty',
                'creationDate', 'createdByUser', 'lastChangeDateTime', 'totalNetAmount',
                'overallDeliveryStatus', 'overallOrdReltdBillgStatus', 'overallSdDocReferenceStatus',
                'transactionCurrency', 'pricingDate', 'requestedDeliveryDate',
                'headerBillingBlockReason', 'deliveryBlockReason', 'incotermsClassification',
                'incotermsLocation1', 'customerPaymentTerms', 'totalCreditCheckStatus'
            ],
            primaryKey: ['salesOrder']
        },
        {
            name: 'sales_order_items',
            displayName: 'Sales Order Item',
            directory: 'sales_order_items',
            columns: [
                'salesOrder', 'salesOrderItem', 'salesOrderItemCategory', 'material',
                'requestedQuantity', 'requestedQuantityUnit', 'transactionCurrency',
                'netAmount', 'materialGroup', 'productionPlant', 'storageLocation',
                'salesDocumentRjcnReason', 'itemBillingBlockReason'
            ],
            primaryKey: ['salesOrder', 'salesOrderItem'],
            transforms: {
                salesOrderItem: (val: any) => (typeof val === 'string' && val ? val.padStart(6, '0') : val)
            }
        },
        {
            name: 'sales_order_schedule_lines',
            displayName: 'Sales Order Schedule Line',
            directory: 'sales_order_schedule_lines',
            columns: [
                'salesOrder', 'salesOrderItem', 'scheduleLine',
                'confirmedDeliveryDate', 'orderQuantityUnit', 'confdOrderQtyByMatlAvailCheck'
            ],
            primaryKey: ['salesOrder', 'salesOrderItem', 'scheduleLine']
        },
        {
            name: 'outbound_delivery_headers',
            displayName: 'Outbound Delivery',
            directory: 'outbound_delivery_headers',
            columns: [
                'deliveryDocument', 'actualGoodsMovementDate', 'actualGoodsMovementTime',
                'creationDate', 'creationTime', 'deliveryBlockReason',
                'hdrGeneralIncompletionStatus', 'headerBillingBlockReason', 'lastChangeDate',
                'overallGoodsMovementStatus', 'overallPickingStatus',
                'overallProofOfDeliveryStatus', 'shippingPoint'
            ],
            primaryKey: ['deliveryDocument']
        },
        {
            name: 'outbound_delivery_items',
            displayName: 'Outbound Delivery Item',
            directory: 'outbound_delivery_items',
            columns: [
                'deliveryDocument', 'deliveryDocumentItem', 'actualDeliveryQuantity',
                'batch', 'deliveryQuantityUnit', 'itemBillingBlockReason', 'lastChangeDate',
                'plant', 'referenceSdDocument', 'referenceSdDocumentItem', 'storageLocation'
            ],
            primaryKey: ['deliveryDocument', 'deliveryDocumentItem']
        },
        {
            name: 'billing_document_headers',
            displayName: 'Billing Document',
            directory: 'billing_document_headers',
            columns: [
                'billingDocument', 'billingDocumentType', 'creationDate', 'creationTime',
                'lastChangeDateTime', 'billingDocumentDate', 'billingDocumentIsCancelled',
                'cancelledBillingDocument', 'totalNetAmount', 'transactionCurrency',
                'companyCode', 'fiscalYear', 'accountingDocument', 'soldToParty'
            ],
            primaryKey: ['billingDocument']
        },
        {
            name: 'billing_document_items',
            displayName: 'Billing Document Item',
            directory: 'billing_document_items',
            columns: [
                'billingDocument', 'billingDocumentItem', 'material', 'billingQuantity',
                'billingQuantityUnit', 'netAmount', 'transactionCurrency',
                'referenceSdDocument', 'referenceSdDocumentItem'
            ],
            primaryKey: ['billingDocument', 'billingDocumentItem'],
            transforms: {
                referenceSdDocumentItem: (val: any) => (typeof val === 'string' && val ? val.padStart(6, '0') : val)
            }
        },
        {
            name: 'billing_document_cancellations',
            displayName: 'Billing Document Cancellation',
            directory: 'billing_document_cancellations',
            columns: [
                'billingDocument', 'billingDocumentType', 'creationDate', 'creationTime',
                'lastChangeDateTime', 'billingDocumentDate', 'billingDocumentIsCancelled',
                'cancelledBillingDocument', 'totalNetAmount', 'transactionCurrency',
                'companyCode', 'fiscalYear', 'accountingDocument', 'soldToParty'
            ],
            primaryKey: ['billingDocument']
        },
        {
            name: 'journal_entry_items_accounts_receivable',
            displayName: 'Journal Entry (AR)',
            directory: 'journal_entry_items_accounts_receivable',
            columns: [
                'companyCode', 'fiscalYear', 'accountingDocument', 'accountingDocumentItem',
                'glAccount', 'referenceDocument', 'costCenter', 'profitCenter',
                'transactionCurrency', 'amountInTransactionCurrency', 'companyCodeCurrency',
                'amountInCompanyCodeCurrency', 'postingDate', 'documentDate',
                'accountingDocumentType', 'assignmentReference', 'lastChangeDateTime',
                'customer', 'financialAccountType', 'clearingDate',
                'clearingAccountingDocument', 'clearingDocFiscalYear'
            ],
            primaryKey: ['companyCode', 'fiscalYear', 'accountingDocument', 'accountingDocumentItem']
        },
        {
            name: 'payments_accounts_receivable',
            displayName: 'Payment (AR)',
            directory: 'payments_accounts_receivable',
            columns: [
                'companyCode', 'fiscalYear', 'accountingDocument', 'accountingDocumentItem',
                'clearingDate', 'clearingAccountingDocument', 'clearingDocFiscalYear',
                'amountInTransactionCurrency', 'transactionCurrency',
                'amountInCompanyCodeCurrency', 'companyCodeCurrency', 'customer',
                'invoiceReference', 'invoiceReferenceFiscalYear', 'salesDocument',
                'salesDocumentItem', 'postingDate', 'documentDate', 'assignmentReference',
                'glAccount', 'financialAccountType', 'profitCenter', 'costCenter'
            ],
            primaryKey: ['companyCode', 'fiscalYear', 'accountingDocument', 'accountingDocumentItem']
        },
        {
            name: 'business_partners',
            displayName: 'Business Partner',
            directory: 'business_partners',
            columns: [
                'businessPartner', 'customer', 'businessPartnerCategory',
                'businessPartnerFullName', 'businessPartnerGrouping', 'businessPartnerName',
                'correspondenceLanguage', 'createdByUser', 'creationDate', 'creationTime',
                'firstName', 'formOfAddress', 'industry', 'lastChangeDate', 'lastName',
                'organizationBpName1', 'organizationBpName2',
                'businessPartnerIsBlocked', 'isMarkedForArchiving'
            ],
            primaryKey: ['businessPartner']
        },
        {
            name: 'business_partner_addresses',
            displayName: 'Business Partner Address',
            directory: 'business_partner_addresses',
            columns: [
                'businessPartner', 'addressId', 'validityStartDate', 'validityEndDate',
                'addressUuid', 'addressTimeZone', 'cityName', 'country', 'poBox',
                'poBoxDeviatingCityName', 'poBoxDeviatingCountry', 'poBoxDeviatingRegion',
                'poBoxIsWithoutNumber', 'poBoxLobbyName', 'poBoxPostalCode', 'postalCode',
                'region', 'streetName', 'taxJurisdiction', 'transportZone'
            ],
            primaryKey: ['businessPartner', 'addressId']
        },
        {
            name: 'customer_company_assignments',
            displayName: 'Customer Company Assignment',
            directory: 'customer_company_assignments',
            columns: [
                'customer', 'companyCode', 'accountingClerk', 'accountingClerkFaxNumber',
                'accountingClerkInternetAddress', 'accountingClerkPhoneNumber',
                'alternativePayerAccount', 'paymentBlockingReason', 'paymentMethodsList',
                'paymentTerms', 'reconciliationAccount', 'deletionIndicator',
                'customerAccountGroup'
            ],
            primaryKey: ['customer', 'companyCode']
        },
        {
            name: 'customer_sales_area_assignments',
            displayName: 'Customer Sales Area Assignment',
            directory: 'customer_sales_area_assignments',
            columns: [
                'customer', 'salesOrganization', 'distributionChannel', 'division',
                'billingIsBlockedForCustomer', 'completeDeliveryIsDefined', 'creditControlArea',
                'currency', 'customerPaymentTerms', 'deliveryPriority',
                'incotermsClassification', 'incotermsLocation1', 'salesGroup', 'salesOffice',
                'shippingCondition', 'slsUnlmtdOvrdelivIsAllwd', 'supplyingPlant',
                'salesDistrict', 'exchangeRateType'
            ],
            primaryKey: ['customer', 'salesOrganization', 'distributionChannel', 'division']
        },
        {
            name: 'products',
            displayName: 'Product',
            directory: 'products',
            columns: [
                'product', 'productType', 'crossPlantStatus', 'crossPlantStatusValidityDate',
                'creationDate', 'createdByUser', 'lastChangeDate', 'lastChangeDateTime',
                'isMarkedForDeletion', 'productOldId', 'grossWeight', 'weightUnit',
                'netWeight', 'productGroup', 'baseUnit', 'division', 'industrySector'
            ],
            primaryKey: ['product']
        },
        {
            name: 'product_descriptions',
            displayName: 'Product Description',
            directory: 'product_descriptions',
            columns: ['product', 'language', 'productDescription'],
            primaryKey: ['product', 'language']
        },
        {
            name: 'product_plants',
            displayName: 'Product Plant',
            directory: 'product_plants',
            columns: [
                'product', 'plant', 'countryOfOrigin', 'regionOfOrigin',
                'productionInvtryManagedLoc', 'availabilityCheckType',
                'fiscalYearVariant', 'profitCenter', 'mrpType'
            ],
            primaryKey: ['product', 'plant']
        },
        {
            name: 'product_storage_locations',
            displayName: 'Product Storage Location',
            directory: 'product_storage_locations',
            columns: [
                'product', 'plant', 'storageLocation',
                'physicalInventoryBlockInd', 'dateOfLastPostedCntUnRstrcdStk'
            ],
            primaryKey: ['product', 'plant', 'storageLocation']
        },
        {
            name: 'plants',
            displayName: 'Plant',
            directory: 'plants',
            columns: [
                'plant', 'plantName', 'valuationArea', 'plantCustomer', 'plantSupplier',
                'factoryCalendar', 'defaultPurchasingOrganization', 'salesOrganization',
                'addressId', 'plantCategory', 'distributionChannel', 'division',
                'language', 'isMarkedForArchiving'
            ],
            primaryKey: ['plant']
        },
    ],

    relationships: [
        { from: 'sales_order_headers.salesOrder', to: 'outbound_delivery_items.referenceSdDocument', label: 'FULFILLED_BY', joinType: 'JOIN', description: 'Sales Order to Delivery' },
        { from: 'outbound_delivery_items.deliveryDocument+deliveryDocumentItem', to: 'billing_document_items.referenceSdDocument+referenceSdDocumentItem', label: 'BILLED_AS', joinType: 'JOIN', description: 'Delivery to Billing' },
        { from: 'billing_document_headers.accountingDocument+companyCode+fiscalYear', to: 'journal_entry_items_accounts_receivable.accountingDocument+companyCode+fiscalYear', label: 'POSTED_AS', joinType: 'LEFT JOIN', description: 'Billing to Journal Entry' },
        { from: 'journal_entry_items_accounts_receivable.clearingAccountingDocument+companyCode', to: 'payments_accounts_receivable.clearingAccountingDocument+companyCode', label: 'CLEARED_BY', joinType: 'LEFT JOIN', description: 'Journal Entry to Payment' },
        { from: 'billing_document_headers.soldToParty', to: 'business_partners.customer', label: 'BILLED_TO', joinType: 'JOIN', description: 'Documents to Customer' },
    ],

    domainKeywords: [
        'order', 'sales', 'delivery', 'bill', 'invoice',
        'journal', 'payment', 'customer', 'product', 'plant',
        'document', 'item', 'amount', 'clearing', 'flow',
        'company', 'fiscal', 'accounting', 'partner',
        'trace', 'material', 'address', 'status', 'cancelled',
        'billed', 'delivered', 'posted', 'cleared', 'entry',
        'shipping', 'quantity', 'currency', 'net', 'total',
        'o2c', 'sap', 'transaction', 'record', 'data'
    ],

    entities: [
        'sales order', 'delivery', 'billing', 'invoice',
        'journal', 'journal entry', 'payment', 'customer',
        'product', 'plant', 'material', 'business partner'
    ],

    relationshipLabels: [
        'FULFILLED_BY', 'BILLED_AS', 'BILLED_DIRECTLY',
        'POSTED_AS', 'CLEARED_BY', 'ORDERED', 'BILLED_TO',
        'CONTAINS_PRODUCT', 'PRODUCED_AT', 'SHIPS_FROM', 'CANCELS'
    ],

    rules: `- PREFER header-level joins when possible.
- Use item-level joins ONLY when explicitly necessary.
- Avoid unnecessary joins to sales_order_items unless item-level granularity is literally requested.
- STRICT RULE: Do NOT use subqueries or nested SELECT statements inside JOIN conditions.
- STRICT RULE: For reverse traces starting from a Billing Document, strictly follow: billing_document_headers -> billing_document_items -> outbound_delivery_items -> sales_order_headers.
- STRICT RULE: When filtering by customer (soldToParty) or showing a customer's full flow, use LEFT JOIN for ALL downstream tables (outbound_delivery_items, billing_document_items, billing_document_headers, journal entries, payments) so partial flows are returned.
- STRICT RULE: For "delivered but not billed" queries, always join billing_document_items to outbound_delivery_items using: bdi.referenceSdDocument = odi.deliveryDocument AND bdi.referenceSdDocumentItem = odi.deliveryDocumentItem. Never use odi.referenceSdDocument for this join.`,

    examples: `Example 1: "Trace the full flow for billing document 90504204"
SELECT DISTINCT
  soh.salesOrder, soh.soldToParty, soh.creationDate, soh.totalNetAmount AS orderAmount,
  odh.deliveryDocument, odh.actualGoodsMovementDate,
  bdh.billingDocument, bdh.billingDocumentDate, bdh.totalNetAmount, bdh.billingDocumentIsCancelled,
  je.accountingDocument, je.accountingDocumentItem AS accountingDocumentType, je.amountInTransactionCurrency AS jeAmount, je.customer,
  pay.clearingAccountingDocument, pay.postingDate AS paymentDate, pay.amountInTransactionCurrency AS paymentAmount
FROM billing_document_headers bdh
JOIN billing_document_items bdi ON bdi.billingDocument = bdh.billingDocument
JOIN outbound_delivery_items odi ON odi.deliveryDocument = bdi.referenceSdDocument AND odi.deliveryDocumentItem = bdi.referenceSdDocumentItem
JOIN outbound_delivery_headers odh ON odh.deliveryDocument = odi.deliveryDocument
JOIN sales_order_headers soh ON soh.salesOrder = odi.referenceSdDocument
LEFT JOIN journal_entry_items_accounts_receivable je ON je.accountingDocument = bdh.accountingDocument AND je.companyCode = bdh.companyCode AND je.fiscalYear = bdh.fiscalYear
LEFT JOIN payments_accounts_receivable pay ON pay.clearingAccountingDocument = je.clearingAccountingDocument AND pay.companyCode = je.companyCode
WHERE bdh.billingDocument = '90504204'
LIMIT 100

Example 2: "Which products have the most billing documents?"
SELECT pd.productDescription, bdi.material, COUNT(DISTINCT bdi.billingDocument) AS billingCount
FROM billing_document_items bdi
LEFT JOIN product_descriptions pd ON pd.product = bdi.material AND pd.language = 'EN'
GROUP BY bdi.material
ORDER BY billingCount DESC
LIMIT 10

Example 3: "Find sales orders delivered but not billed"
SELECT DISTINCT soh.salesOrder, soh.soldToParty, soh.totalNetAmount,
  odi.deliveryDocument
FROM sales_order_headers soh
JOIN outbound_delivery_items odi ON odi.referenceSdDocument = soh.salesOrder
JOIN outbound_delivery_headers odh ON odh.deliveryDocument = odi.deliveryDocument
LEFT JOIN billing_document_items bdi ON bdi.referenceSdDocument = odi.deliveryDocument AND bdi.referenceSdDocumentItem = odi.deliveryDocumentItem
WHERE bdi.billingDocument IS NULL
LIMIT 100`,
};

// Backward-compatible flat exports
export const { domainKeywords, entities } = datasetConfig;
export const relationships = datasetConfig.relationshipLabels;
