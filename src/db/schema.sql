-- Core O2C Tables
CREATE TABLE IF NOT EXISTS sales_order_headers (
    salesOrder                    TEXT PRIMARY KEY,
    salesOrderType                TEXT,
    salesOrganization             TEXT,
    distributionChannel           TEXT,
    organizationDivision          TEXT,
    salesGroup                    TEXT,
    salesOffice                   TEXT,
    soldToParty                   TEXT,
    creationDate                  TEXT,
    createdByUser                 TEXT,
    lastChangeDateTime            TEXT,
    totalNetAmount                TEXT,
    overallDeliveryStatus         TEXT,
    overallOrdReltdBillgStatus    TEXT,
    overallSdDocReferenceStatus   TEXT,
    transactionCurrency           TEXT,
    pricingDate                   TEXT,
    requestedDeliveryDate         TEXT,
    headerBillingBlockReason      TEXT,
    deliveryBlockReason           TEXT,
    incotermsClassification       TEXT,
    incotermsLocation1            TEXT,
    customerPaymentTerms          TEXT,
    totalCreditCheckStatus        TEXT
);

CREATE TABLE IF NOT EXISTS sales_order_items (
    salesOrder                    TEXT NOT NULL,
    salesOrderItem                TEXT NOT NULL,
    salesOrderItemCategory        TEXT,
    material                      TEXT,
    requestedQuantity             TEXT,
    requestedQuantityUnit         TEXT,
    transactionCurrency           TEXT,
    netAmount                     TEXT,
    materialGroup                 TEXT,
    productionPlant               TEXT,
    storageLocation               TEXT,
    salesDocumentRjcnReason       TEXT,
    itemBillingBlockReason        TEXT,
    PRIMARY KEY (salesOrder, salesOrderItem)
);

CREATE TABLE IF NOT EXISTS sales_order_schedule_lines (
    salesOrder                        TEXT NOT NULL,
    salesOrderItem                    TEXT NOT NULL,
    scheduleLine                      TEXT NOT NULL,
    confirmedDeliveryDate             TEXT,
    orderQuantityUnit                 TEXT,
    confdOrderQtyByMatlAvailCheck     TEXT,
    PRIMARY KEY (salesOrder, salesOrderItem, scheduleLine)
);

CREATE TABLE IF NOT EXISTS outbound_delivery_headers (
    deliveryDocument                  TEXT PRIMARY KEY,
    actualGoodsMovementDate           TEXT,
    actualGoodsMovementTime           TEXT,
    creationDate                      TEXT,
    creationTime                      TEXT,
    deliveryBlockReason               TEXT,
    hdrGeneralIncompletionStatus      TEXT,
    headerBillingBlockReason          TEXT,
    lastChangeDate                    TEXT,
    overallGoodsMovementStatus        TEXT,
    overallPickingStatus              TEXT,
    overallProofOfDeliveryStatus      TEXT,
    shippingPoint                     TEXT
);

CREATE TABLE IF NOT EXISTS outbound_delivery_items (
    deliveryDocument              TEXT NOT NULL,
    deliveryDocumentItem          TEXT NOT NULL,
    actualDeliveryQuantity        TEXT,
    batch                         TEXT,
    deliveryQuantityUnit          TEXT,
    itemBillingBlockReason        TEXT,
    lastChangeDate                TEXT,
    plant                         TEXT,
    referenceSdDocument           TEXT,
    referenceSdDocumentItem       TEXT,
    storageLocation               TEXT,
    PRIMARY KEY (deliveryDocument, deliveryDocumentItem)
);

CREATE TABLE IF NOT EXISTS billing_document_headers (
    billingDocument               TEXT PRIMARY KEY,
    billingDocumentType           TEXT,
    creationDate                  TEXT,
    creationTime                  TEXT,
    lastChangeDateTime            TEXT,
    billingDocumentDate           TEXT,
    billingDocumentIsCancelled    TEXT,
    cancelledBillingDocument      TEXT,
    totalNetAmount                TEXT,
    transactionCurrency           TEXT,
    companyCode                   TEXT,
    fiscalYear                    TEXT,
    accountingDocument            TEXT,
    soldToParty                   TEXT
);

CREATE TABLE IF NOT EXISTS billing_document_items (
    billingDocument               TEXT NOT NULL,
    billingDocumentItem           TEXT NOT NULL,
    material                      TEXT,
    billingQuantity               TEXT,
    billingQuantityUnit           TEXT,
    netAmount                     TEXT,
    transactionCurrency           TEXT,
    referenceSdDocument           TEXT,
    referenceSdDocumentItem       TEXT,
    PRIMARY KEY (billingDocument, billingDocumentItem)
);

CREATE TABLE IF NOT EXISTS billing_document_cancellations (
    billingDocument               TEXT PRIMARY KEY,
    billingDocumentType           TEXT,
    creationDate                  TEXT,
    creationTime                  TEXT,
    lastChangeDateTime            TEXT,
    billingDocumentDate           TEXT,
    billingDocumentIsCancelled    TEXT,
    cancelledBillingDocument      TEXT,
    totalNetAmount                TEXT,
    transactionCurrency           TEXT,
    companyCode                   TEXT,
    fiscalYear                    TEXT,
    accountingDocument            TEXT,
    soldToParty                   TEXT
);

CREATE TABLE IF NOT EXISTS journal_entry_items_accounts_receivable (
    companyCode                   TEXT NOT NULL,
    fiscalYear                    TEXT NOT NULL,
    accountingDocument            TEXT NOT NULL,
    accountingDocumentItem        TEXT NOT NULL,
    glAccount                     TEXT,
    referenceDocument             TEXT,
    costCenter                    TEXT,
    profitCenter                  TEXT,
    transactionCurrency           TEXT,
    amountInTransactionCurrency   TEXT,
    companyCodeCurrency           TEXT,
    amountInCompanyCodeCurrency   TEXT,
    postingDate                   TEXT,
    documentDate                  TEXT,
    accountingDocumentType        TEXT,
    assignmentReference           TEXT,
    lastChangeDateTime            TEXT,
    customer                      TEXT,
    financialAccountType          TEXT,
    clearingDate                  TEXT,
    clearingAccountingDocument    TEXT,
    clearingDocFiscalYear         TEXT,
    PRIMARY KEY (companyCode, fiscalYear, accountingDocument, accountingDocumentItem)
);

CREATE TABLE IF NOT EXISTS payments_accounts_receivable (
    companyCode                   TEXT NOT NULL,
    fiscalYear                    TEXT NOT NULL,
    accountingDocument            TEXT NOT NULL,
    accountingDocumentItem        TEXT NOT NULL,
    clearingDate                  TEXT,
    clearingAccountingDocument    TEXT,
    clearingDocFiscalYear         TEXT,
    amountInTransactionCurrency   TEXT,
    transactionCurrency           TEXT,
    amountInCompanyCodeCurrency   TEXT,
    companyCodeCurrency           TEXT,
    customer                      TEXT,
    invoiceReference              TEXT,
    invoiceReferenceFiscalYear    TEXT,
    salesDocument                 TEXT,
    salesDocumentItem             TEXT,
    postingDate                   TEXT,
    documentDate                  TEXT,
    assignmentReference           TEXT,
    glAccount                     TEXT,
    financialAccountType          TEXT,
    profitCenter                  TEXT,
    costCenter                    TEXT,
    PRIMARY KEY (companyCode, fiscalYear, accountingDocument, accountingDocumentItem)
);

-- Master Data Tables
CREATE TABLE IF NOT EXISTS business_partners (
    businessPartner               TEXT PRIMARY KEY,
    customer                      TEXT,
    businessPartnerCategory       TEXT,
    businessPartnerFullName       TEXT,
    businessPartnerGrouping       TEXT,
    businessPartnerName           TEXT,
    correspondenceLanguage        TEXT,
    createdByUser                 TEXT,
    creationDate                  TEXT,
    creationTime                  TEXT,
    firstName                     TEXT,
    formOfAddress                 TEXT,
    industry                      TEXT,
    lastChangeDate                TEXT,
    lastName                      TEXT,
    organizationBpName1           TEXT,
    organizationBpName2           TEXT,
    businessPartnerIsBlocked      TEXT,
    isMarkedForArchiving          TEXT
);

CREATE TABLE IF NOT EXISTS business_partner_addresses (
    businessPartner               TEXT NOT NULL,
    addressId                     TEXT NOT NULL,
    validityStartDate             TEXT,
    validityEndDate               TEXT,
    addressUuid                   TEXT,
    addressTimeZone               TEXT,
    cityName                      TEXT,
    country                       TEXT,
    poBox                         TEXT,
    poBoxDeviatingCityName        TEXT,
    poBoxDeviatingCountry         TEXT,
    poBoxDeviatingRegion          TEXT,
    poBoxIsWithoutNumber          TEXT,
    poBoxLobbyName                TEXT,
    poBoxPostalCode               TEXT,
    postalCode                    TEXT,
    region                        TEXT,
    streetName                    TEXT,
    taxJurisdiction               TEXT,
    transportZone                 TEXT,
    PRIMARY KEY (businessPartner, addressId)
);

CREATE TABLE IF NOT EXISTS customer_company_assignments (
    customer                      TEXT NOT NULL,
    companyCode                   TEXT NOT NULL,
    accountingClerk               TEXT,
    accountingClerkFaxNumber      TEXT,
    accountingClerkInternetAddress TEXT,
    accountingClerkPhoneNumber    TEXT,
    alternativePayerAccount       TEXT,
    paymentBlockingReason         TEXT,
    paymentMethodsList            TEXT,
    paymentTerms                  TEXT,
    reconciliationAccount         TEXT,
    deletionIndicator             TEXT,
    customerAccountGroup          TEXT,
    PRIMARY KEY (customer, companyCode)
);

CREATE TABLE IF NOT EXISTS customer_sales_area_assignments (
    customer                      TEXT NOT NULL,
    salesOrganization             TEXT NOT NULL,
    distributionChannel           TEXT NOT NULL,
    division                      TEXT NOT NULL,
    billingIsBlockedForCustomer   TEXT,
    completeDeliveryIsDefined     TEXT,
    creditControlArea             TEXT,
    currency                      TEXT,
    customerPaymentTerms          TEXT,
    deliveryPriority              TEXT,
    incotermsClassification       TEXT,
    incotermsLocation1            TEXT,
    salesGroup                    TEXT,
    salesOffice                   TEXT,
    shippingCondition             TEXT,
    slsUnlmtdOvrdelivIsAllwd     TEXT,
    supplyingPlant                TEXT,
    salesDistrict                 TEXT,
    exchangeRateType              TEXT,
    PRIMARY KEY (customer, salesOrganization, distributionChannel, division)
);

CREATE TABLE IF NOT EXISTS products (
    product                       TEXT PRIMARY KEY,
    productType                   TEXT,
    crossPlantStatus              TEXT,
    crossPlantStatusValidityDate  TEXT,
    creationDate                  TEXT,
    createdByUser                 TEXT,
    lastChangeDate                TEXT,
    lastChangeDateTime            TEXT,
    isMarkedForDeletion           TEXT,
    productOldId                  TEXT,
    grossWeight                   TEXT,
    weightUnit                    TEXT,
    netWeight                     TEXT,
    productGroup                  TEXT,
    baseUnit                      TEXT,
    division                      TEXT,
    industrySector                TEXT
);

CREATE TABLE IF NOT EXISTS product_descriptions (
    product                       TEXT NOT NULL,
    language                      TEXT NOT NULL,
    productDescription            TEXT,
    PRIMARY KEY (product, language)
);

CREATE TABLE IF NOT EXISTS plants (
    plant                         TEXT PRIMARY KEY,
    plantName                     TEXT,
    valuationArea                 TEXT,
    plantCustomer                 TEXT,
    plantSupplier                 TEXT,
    factoryCalendar               TEXT,
    defaultPurchasingOrganization TEXT,
    salesOrganization             TEXT,
    addressId                     TEXT,
    plantCategory                 TEXT,
    distributionChannel           TEXT,
    division                      TEXT,
    language                      TEXT,
    isMarkedForArchiving          TEXT
);

CREATE TABLE IF NOT EXISTS product_plants (
    product                       TEXT NOT NULL,
    plant                         TEXT NOT NULL,
    countryOfOrigin               TEXT,
    regionOfOrigin                TEXT,
    productionInvtryManagedLoc    TEXT,
    availabilityCheckType         TEXT,
    fiscalYearVariant             TEXT,
    profitCenter                  TEXT,
    mrpType                       TEXT,
    PRIMARY KEY (product, plant)
);

CREATE TABLE IF NOT EXISTS product_storage_locations (
    product                       TEXT NOT NULL,
    plant                         TEXT NOT NULL,
    storageLocation               TEXT NOT NULL,
    physicalInventoryBlockInd     TEXT,
    dateOfLastPostedCntUnRstrcdStk TEXT,
    PRIMARY KEY (product, plant, storageLocation)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_soh_soldToParty ON sales_order_headers(soldToParty);
CREATE INDEX IF NOT EXISTS idx_soi_material ON sales_order_items(material);
CREATE INDEX IF NOT EXISTS idx_soi_productionPlant ON sales_order_items(productionPlant);
CREATE INDEX IF NOT EXISTS idx_odi_refSdDoc ON outbound_delivery_items(referenceSdDocument);
CREATE INDEX IF NOT EXISTS idx_odi_refSdDoc_item ON outbound_delivery_items(referenceSdDocument, referenceSdDocumentItem);
CREATE INDEX IF NOT EXISTS idx_odi_plant ON outbound_delivery_items(plant);
CREATE INDEX IF NOT EXISTS idx_bdi_refSdDoc ON billing_document_items(referenceSdDocument);
CREATE INDEX IF NOT EXISTS idx_bdi_refSdDoc_item ON billing_document_items(referenceSdDocument, referenceSdDocumentItem);
CREATE INDEX IF NOT EXISTS idx_bdi_material ON billing_document_items(material);
CREATE INDEX IF NOT EXISTS idx_bdh_acctDoc ON billing_document_headers(accountingDocument);
CREATE INDEX IF NOT EXISTS idx_bdh_soldToParty ON billing_document_headers(soldToParty);
CREATE INDEX IF NOT EXISTS idx_bdh_companyAcct ON billing_document_headers(companyCode, fiscalYear, accountingDocument);
CREATE INDEX IF NOT EXISTS idx_bdc_cancelledDoc ON billing_document_cancellations(cancelledBillingDocument);
CREATE INDEX IF NOT EXISTS idx_je_refDoc ON journal_entry_items_accounts_receivable(referenceDocument);
CREATE INDEX IF NOT EXISTS idx_je_clearingDoc ON journal_entry_items_accounts_receivable(clearingAccountingDocument);
CREATE INDEX IF NOT EXISTS idx_je_customer ON journal_entry_items_accounts_receivable(customer);
CREATE INDEX IF NOT EXISTS idx_je_acctDoc ON journal_entry_items_accounts_receivable(companyCode, fiscalYear, accountingDocument);
CREATE INDEX IF NOT EXISTS idx_pay_clearingDoc ON payments_accounts_receivable(clearingAccountingDocument);
CREATE INDEX IF NOT EXISTS idx_pay_customer ON payments_accounts_receivable(customer);
CREATE INDEX IF NOT EXISTS idx_pay_acctDoc ON payments_accounts_receivable(companyCode, fiscalYear, accountingDocument);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bp_customer ON business_partners(customer);
CREATE INDEX IF NOT EXISTS idx_bpa_bp ON business_partner_addresses(businessPartner);
CREATE INDEX IF NOT EXISTS idx_cca_customer ON customer_company_assignments(customer);
CREATE INDEX IF NOT EXISTS idx_csa_customer ON customer_sales_area_assignments(customer);
CREATE INDEX IF NOT EXISTS idx_pd_product ON product_descriptions(product);
CREATE INDEX IF NOT EXISTS idx_pp_plant ON product_plants(plant);
CREATE INDEX IF NOT EXISTS idx_psl_plant ON product_storage_locations(plant);
