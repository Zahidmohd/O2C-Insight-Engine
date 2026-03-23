# SQLite Schema Design & Data Loading Strategy

> **Date:** 2026-03-23
> **Status:** ✅ Complete
> **Dependencies:** [dataset-analysis.md](./dataset-analysis.md), [graph-model.md](./graph-model.md)

---

## 1. Design Principles

1. **Keep schema close to source** — Table names and column names match the JSONL dataset
2. **No aggressive denormalization** — Each table stays separate (no merges)
3. **LLM-friendly** — Schema must be describable to an LLM for SQL generation
4. **Query-friendly** — Indexes on every join column and frequently filtered column
5. **Normalize data at load time** — Fix known format issues (billing item padding) during ingestion, not at query time

---

## 2. Key Design Decisions

### 2.1 Billing Item Padding: Normalize at Ingestion ✅

**Decision:** Pad `billing_document_items.referenceSdDocumentItem` to 6 digits **during data loading**, not at query time.

**Why:**
| Approach | Pros | Cons |
|----------|------|------|
| SQL-time `printf()` | No data transformation | Every query needs `printf()`; LLM must know the trick; index on `referenceSdDocumentItem` becomes useless |
| **Ingestion-time pad** ✅ | Simple `=` joins everywhere; LLM doesn't need to know; index works normally | One-time transformation during load |

The LLM will generate SQL like:
```sql
-- With ingestion-time normalization (CLEAN — what we want)
bdi.referenceSdDocumentItem = odi.deliveryDocumentItem

-- Without it (UGLY — what we'd need otherwise)
printf('%06d', CAST(bdi.referenceSdDocumentItem AS INTEGER)) = odi.deliveryDocumentItem
```

**Padding rule applied during load:**
```javascript
// billing_document_items ONLY
referenceSdDocumentItem = referenceSdDocumentItem.padStart(6, '0');
// "10"  → "000010"
// "20"  → "000020"
```

### 2.2 All Columns Stored as TEXT

**Decision:** Store all columns as `TEXT` in SQLite.

**Why:**
- Source data is JSONL with all values as strings (even numbers like `"740506"`)
- SAP document numbers are NOT numeric — they're identifiers (leading zeros matter)
- Amounts can be compared as text for equality; CAST to REAL only when aggregating
- Avoids silent data loss from type coercion

### 2.3 Composite Primary Keys

**Decision:** Use composite primary keys where the dataset demands it (journal entries, payments, schedule lines).

**Why:** Matches the actual data model. Single-column surrogate keys would hide the business logic.

---

## 3. CREATE TABLE Statements

### 3.1 Core O2C Tables

```sql
-- ============================================================
-- SALES ORDER
-- ============================================================

CREATE TABLE IF NOT EXISTS sales_order_headers (
    salesOrder                    TEXT PRIMARY KEY,
    salesOrderType                TEXT,
    salesOrganization             TEXT,
    distributionChannel           TEXT,
    organizationDivision          TEXT,
    salesGroup                    TEXT,
    salesOffice                   TEXT,
    soldToParty                   TEXT,          -- FK → business_partners.customer
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
    salesOrder                    TEXT NOT NULL,  -- FK → sales_order_headers.salesOrder
    salesOrderItem                TEXT NOT NULL,
    salesOrderItemCategory        TEXT,
    material                      TEXT,          -- FK → products.product
    requestedQuantity             TEXT,
    requestedQuantityUnit         TEXT,
    transactionCurrency           TEXT,
    netAmount                     TEXT,
    materialGroup                 TEXT,
    productionPlant               TEXT,          -- FK → plants.plant
    storageLocation               TEXT,
    salesDocumentRjcnReason       TEXT,
    itemBillingBlockReason        TEXT,
    PRIMARY KEY (salesOrder, salesOrderItem)
);

CREATE TABLE IF NOT EXISTS sales_order_schedule_lines (
    salesOrder                        TEXT NOT NULL,  -- FK → sales_order_headers.salesOrder
    salesOrderItem                    TEXT NOT NULL,  -- FK → sales_order_items.salesOrderItem
    scheduleLine                      TEXT NOT NULL,
    confirmedDeliveryDate             TEXT,
    orderQuantityUnit                 TEXT,
    confdOrderQtyByMatlAvailCheck     TEXT,
    PRIMARY KEY (salesOrder, salesOrderItem, scheduleLine)
);

-- ============================================================
-- OUTBOUND DELIVERY
-- ============================================================

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
    deliveryDocument              TEXT NOT NULL,  -- FK → outbound_delivery_headers.deliveryDocument
    deliveryDocumentItem          TEXT NOT NULL,
    actualDeliveryQuantity        TEXT,
    batch                         TEXT,
    deliveryQuantityUnit          TEXT,
    itemBillingBlockReason        TEXT,
    lastChangeDate                TEXT,
    plant                         TEXT,          -- FK → plants.plant
    referenceSdDocument           TEXT,          -- FK → sales_order_headers.salesOrder
    referenceSdDocumentItem       TEXT,          -- FK → sales_order_items.salesOrderItem
    storageLocation               TEXT,
    PRIMARY KEY (deliveryDocument, deliveryDocumentItem)
);

-- ============================================================
-- BILLING DOCUMENT
-- ============================================================

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
    accountingDocument            TEXT,          -- FK → journal_entry_items_ar
    soldToParty                   TEXT           -- FK → business_partners.customer
);

CREATE TABLE IF NOT EXISTS billing_document_items (
    billingDocument               TEXT NOT NULL,  -- FK → billing_document_headers.billingDocument
    billingDocumentItem           TEXT NOT NULL,
    material                      TEXT,          -- FK → products.product
    billingQuantity               TEXT,
    billingQuantityUnit           TEXT,
    netAmount                     TEXT,
    transactionCurrency           TEXT,
    referenceSdDocument           TEXT,          -- FK → outbound_delivery_items.deliveryDocument
    referenceSdDocumentItem       TEXT,          -- FK → outbound_delivery_items.deliveryDocumentItem
    -- ⚠️ NOTE: referenceSdDocumentItem is NORMALIZED during ingestion
    --          "10" → "000010" (zero-padded to 6 digits)
    --          This allows direct = joins with deliveryDocumentItem
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
    cancelledBillingDocument      TEXT,          -- FK → billing_document_headers.billingDocument
    totalNetAmount                TEXT,
    transactionCurrency           TEXT,
    companyCode                   TEXT,
    fiscalYear                    TEXT,
    accountingDocument            TEXT,
    soldToParty                   TEXT
);

-- ============================================================
-- JOURNAL ENTRY (Accounts Receivable)
-- ============================================================

CREATE TABLE IF NOT EXISTS journal_entry_items_accounts_receivable (
    companyCode                   TEXT NOT NULL,
    fiscalYear                    TEXT NOT NULL,
    accountingDocument            TEXT NOT NULL,
    accountingDocumentItem        TEXT NOT NULL,
    glAccount                     TEXT,
    referenceDocument             TEXT,          -- → billing_document_headers.billingDocument
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
    customer                      TEXT,          -- FK → business_partners.customer
    financialAccountType          TEXT,
    clearingDate                  TEXT,
    clearingAccountingDocument    TEXT,          -- → payment clearing link
    clearingDocFiscalYear         TEXT,
    PRIMARY KEY (companyCode, fiscalYear, accountingDocument, accountingDocumentItem)
);

-- ============================================================
-- PAYMENTS (Accounts Receivable)
-- ============================================================

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
    customer                      TEXT,          -- FK → business_partners.customer
    invoiceReference              TEXT,          -- ⚠️ NULLABLE — not used for joins
    invoiceReferenceFiscalYear    TEXT,          -- ⚠️ NULLABLE
    salesDocument                 TEXT,          -- ⚠️ NULLABLE
    salesDocumentItem             TEXT,          -- ⚠️ NULLABLE
    postingDate                   TEXT,
    documentDate                  TEXT,
    assignmentReference           TEXT,
    glAccount                     TEXT,
    financialAccountType          TEXT,
    profitCenter                  TEXT,
    costCenter                    TEXT,
    PRIMARY KEY (companyCode, fiscalYear, accountingDocument, accountingDocumentItem)
);
```

### 3.2 Master Data Tables

```sql
-- ============================================================
-- BUSINESS PARTNERS / CUSTOMERS
-- ============================================================

CREATE TABLE IF NOT EXISTS business_partners (
    businessPartner               TEXT PRIMARY KEY,
    customer                      TEXT,          -- Alternate key (used by O2C tables)
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
    businessPartner               TEXT NOT NULL,  -- FK → business_partners.businessPartner
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
    customer                      TEXT NOT NULL,  -- FK → business_partners.customer
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
    customer                      TEXT NOT NULL,  -- FK → business_partners.customer
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

-- ============================================================
-- PRODUCTS
-- ============================================================

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
    product                       TEXT NOT NULL,  -- FK → products.product
    language                      TEXT NOT NULL,
    productDescription            TEXT,
    PRIMARY KEY (product, language)
);

-- ============================================================
-- PLANTS
-- ============================================================

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
    product                       TEXT NOT NULL,  -- FK → products.product
    plant                         TEXT NOT NULL,  -- FK → plants.plant
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
    product                       TEXT NOT NULL,  -- FK → products.product
    plant                         TEXT NOT NULL,  -- FK → plants.plant
    storageLocation               TEXT NOT NULL,
    physicalInventoryBlockInd     TEXT,
    dateOfLastPostedCntUnRstrcdStk TEXT,
    PRIMARY KEY (product, plant, storageLocation)
);
```

---

## 4. CREATE INDEX Statements

Indexes are designed for the **validated join paths** and common query filters.

```sql
-- ============================================================
-- JOIN PATH INDEXES (CRITICAL for multi-hop traversal)
-- ============================================================

-- Sales Order → Customer
CREATE INDEX idx_soh_soldToParty ON sales_order_headers(soldToParty);

-- Sales Order Items → Material/Plant lookups
CREATE INDEX idx_soi_material ON sales_order_items(material);
CREATE INDEX idx_soi_productionPlant ON sales_order_items(productionPlant);

-- Delivery Items → Sales Order (Edge: FULFILLED_BY)
CREATE INDEX idx_odi_refSdDoc ON outbound_delivery_items(referenceSdDocument);
CREATE INDEX idx_odi_refSdDoc_item ON outbound_delivery_items(referenceSdDocument, referenceSdDocumentItem);

-- Delivery Items → Plant
CREATE INDEX idx_odi_plant ON outbound_delivery_items(plant);

-- Billing Items → Delivery (Edge: BILLED_AS)
CREATE INDEX idx_bdi_refSdDoc ON billing_document_items(referenceSdDocument);
CREATE INDEX idx_bdi_refSdDoc_item ON billing_document_items(referenceSdDocument, referenceSdDocumentItem);

-- Billing Items → Material
CREATE INDEX idx_bdi_material ON billing_document_items(material);

-- Billing Header → Accounting Doc (Edge: POSTED_AS)
CREATE INDEX idx_bdh_acctDoc ON billing_document_headers(accountingDocument);
CREATE INDEX idx_bdh_soldToParty ON billing_document_headers(soldToParty);
CREATE INDEX idx_bdh_companyAcct ON billing_document_headers(companyCode, fiscalYear, accountingDocument);

-- Billing Cancellations → Original Doc
CREATE INDEX idx_bdc_cancelledDoc ON billing_document_cancellations(cancelledBillingDocument);

-- Journal Entry → Billing (reverse lookup via referenceDocument)
CREATE INDEX idx_je_refDoc ON journal_entry_items_accounts_receivable(referenceDocument);
-- Journal Entry → Clearing (Edge: CLEARED_BY)
CREATE INDEX idx_je_clearingDoc ON journal_entry_items_accounts_receivable(clearingAccountingDocument);
-- Journal Entry → Customer
CREATE INDEX idx_je_customer ON journal_entry_items_accounts_receivable(customer);
-- Journal Entry → Accounting Document (for billing → journal join)
CREATE INDEX idx_je_acctDoc ON journal_entry_items_accounts_receivable(companyCode, fiscalYear, accountingDocument);

-- Payment → Clearing doc
CREATE INDEX idx_pay_clearingDoc ON payments_accounts_receivable(clearingAccountingDocument);
-- Payment → Customer
CREATE INDEX idx_pay_customer ON payments_accounts_receivable(customer);
-- Payment → Accounting Document (for journal → payment join)
CREATE INDEX idx_pay_acctDoc ON payments_accounts_receivable(companyCode, fiscalYear, accountingDocument);

-- ============================================================
-- MASTER DATA INDEXES
-- ============================================================

-- Business Partners → Customer number (used as FK target by all O2C tables)
CREATE UNIQUE INDEX idx_bp_customer ON business_partners(customer);

-- Business Partner Addresses
CREATE INDEX idx_bpa_bp ON business_partner_addresses(businessPartner);

-- Customer Assignments
CREATE INDEX idx_cca_customer ON customer_company_assignments(customer);
CREATE INDEX idx_csa_customer ON customer_sales_area_assignments(customer);

-- Product Descriptions
CREATE INDEX idx_pd_product ON product_descriptions(product);

-- Product Plants / Storage Locations
CREATE INDEX idx_pp_plant ON product_plants(plant);
CREATE INDEX idx_psl_plant ON product_storage_locations(plant);
```

### Index Design Rationale

| Index | Supports | Why |
|-------|----------|-----|
| `idx_odi_refSdDoc_item` | FULFILLED_BY edge | Composite index for the 2-column join from delivery items → sales order |
| `idx_bdi_refSdDoc_item` | BILLED_AS edge | Composite index for delivery → billing join (works because padding is done at load time) |
| `idx_bdh_companyAcct` | POSTED_AS edge | 3-column composite for billing → journal entry join |
| `idx_je_acctDoc` | POSTED_AS edge | Matching composite on journal side |
| `idx_pay_acctDoc` | CLEARED_BY edge | 3-column composite for journal → payment join |
| `idx_bp_customer` | All customer edges | UNIQUE index since `customer` is the FK target used everywhere |

---

## 5. Data Loading Strategy

### 5.1 Script Structure

```
src/
  db/
    schema.sql         ← All CREATE TABLE + CREATE INDEX statements
    loader.js          ← Main data loading script
    connection.js      ← SQLite connection manager
```

### 5.2 Loader Design

```javascript
// loader.js — Pseudocode structure

const TABLES = [
  {
    name: 'sales_order_headers',
    directory: 'sales_order_headers',
    transforms: {}  // no transforms needed
  },
  {
    name: 'sales_order_items',
    directory: 'sales_order_items',
    transforms: {}
  },
  {
    name: 'sales_order_schedule_lines',
    directory: 'sales_order_schedule_lines',
    transforms: {}
  },
  {
    name: 'outbound_delivery_headers',
    directory: 'outbound_delivery_headers',
    transforms: {}
  },
  {
    name: 'outbound_delivery_items',
    directory: 'outbound_delivery_items',
    transforms: {}
  },
  {
    name: 'billing_document_headers',
    directory: 'billing_document_headers',
    transforms: {}
  },
  {
    name: 'billing_document_items',
    directory: 'billing_document_items',
    transforms: {
      // ⚠️ CRITICAL: Pad to 6 digits for clean joins with delivery items
      referenceSdDocumentItem: (val) => val ? val.padStart(6, '0') : val
    }
  },
  {
    name: 'billing_document_cancellations',
    directory: 'billing_document_cancellations',
    transforms: {}
  },
  {
    name: 'journal_entry_items_accounts_receivable',
    directory: 'journal_entry_items_accounts_receivable',
    transforms: {}
  },
  {
    name: 'payments_accounts_receivable',
    directory: 'payments_accounts_receivable',
    transforms: {}
  },
  {
    name: 'business_partners',
    directory: 'business_partners',
    transforms: {}
  },
  {
    name: 'business_partner_addresses',
    directory: 'business_partner_addresses',
    transforms: {}
  },
  {
    name: 'customer_company_assignments',
    directory: 'customer_company_assignments',
    transforms: {}
  },
  {
    name: 'customer_sales_area_assignments',
    directory: 'customer_sales_area_assignments',
    transforms: {}
  },
  {
    name: 'products',
    directory: 'products',
    transforms: {}
  },
  {
    name: 'product_descriptions',
    directory: 'product_descriptions',
    transforms: {}
  },
  {
    name: 'plants',
    directory: 'plants',
    transforms: {}
  },
  {
    name: 'product_plants',
    directory: 'product_plants',
    transforms: {}
  },
  {
    name: 'product_storage_locations',
    directory: 'product_storage_locations',
    transforms: {}
  }
];

// Loading algorithm:
// 1. Open SQLite connection
// 2. Run schema.sql (CREATE TABLE + CREATE INDEX)
// 3. For each table config:
//    a. Find all .jsonl files in directory
//    b. Read file line-by-line
//    c. Parse each JSON line
//    d. Apply transforms (if any)
//    e. Batch INSERT (100 rows per batch, inside transaction)
//    f. Log progress: "Loaded {N} rows into {table}"
// 4. Close connection
// 5. Log total summary
```

### 5.3 Key Implementation Details

**Batch Size:** 100 rows per INSERT batch
- Our largest table is ~2800 rows (product_plants), so 100 is efficient
- SQLite's max compound SELECT is 500 by default, so 100 is safe

**Transaction Strategy:**
```javascript
// Wrap each table's entire load in a transaction
db.exec('BEGIN TRANSACTION');
// ... batch inserts ...
db.exec('COMMIT');
```
- One transaction per table (not per batch) for maximum write performance
- SQLite is ~50x faster with transactions vs. auto-commit per row

**Error Handling:**
```javascript
try {
  // load table
} catch (err) {
  db.exec('ROLLBACK');
  console.error(`Failed to load ${table.name}: ${err.message}`);
  throw err;  // abort — don't continue with partial data
}
```

**File Reading:** Use `fs.readFileSync` + split by newline
- Files are small (largest ~225KB), no need for streaming
- Simpler code, easier to debug

**Null Handling:**
- JSON `null` values → SQLite `NULL`
- Empty strings `""` → stored as empty string (not NULL)
- This preserves the distinction for fields like `deliveryBlockReason`

### 5.4 Loading Order

Tables must be loaded in this order to respect referential integrity
(even though SQLite doesn't enforce FK constraints by default):

```
1. plants                          (no dependencies)
2. business_partners               (no dependencies)
3. products                        (no dependencies)
4. business_partner_addresses      (→ business_partners)
5. customer_company_assignments    (→ business_partners)
6. customer_sales_area_assignments (→ business_partners)
7. product_descriptions            (→ products)
8. product_plants                  (→ products, plants)
9. product_storage_locations       (→ products, plants)
10. sales_order_headers            (→ business_partners)
11. sales_order_items              (→ sales_order_headers, products, plants)
12. sales_order_schedule_lines     (→ sales_order_items)
13. outbound_delivery_headers      (no FK enforced)
14. outbound_delivery_items        (→ outbound_delivery_headers, sales_order_headers)
15. billing_document_headers       (→ business_partners)
16. billing_document_items         (→ billing_document_headers, outbound_delivery_items)
17. billing_document_cancellations (→ billing_document_headers)
18. journal_entry_items_accounts_receivable (→ billing_document_headers)
19. payments_accounts_receivable   (→ business_partners)
```

---

## 6. Schema Metadata Table (for LLM Context)

To help the LLM generate correct SQL, we store a metadata table describing the schema:

```sql
CREATE TABLE IF NOT EXISTS _schema_metadata (
    table_name          TEXT NOT NULL,
    column_name         TEXT NOT NULL,
    description         TEXT,
    is_primary_key      INTEGER DEFAULT 0,
    is_join_column      INTEGER DEFAULT 0,
    joins_to_table      TEXT,
    joins_to_column     TEXT,
    PRIMARY KEY (table_name, column_name)
);
```

This table is populated during loading and used by the query engine to provide schema context to the LLM. It does NOT contain data — only structural metadata.

**Example rows:**
```sql
INSERT INTO _schema_metadata VALUES
  ('outbound_delivery_items', 'referenceSdDocument', 'Sales order number this delivery item refers to', 0, 1, 'sales_order_headers', 'salesOrder'),
  ('billing_document_items', 'referenceSdDocument', 'Delivery document this billing item refers to', 0, 1, 'outbound_delivery_items', 'deliveryDocument'),
  ('billing_document_items', 'referenceSdDocumentItem', 'Delivery item (zero-padded at load time)', 0, 1, 'outbound_delivery_items', 'deliveryDocumentItem'),
  ('billing_document_headers', 'accountingDocument', 'Accounting document created for this invoice', 0, 1, 'journal_entry_items_accounts_receivable', 'accountingDocument');
```

---

## 7. Post-Load Validation Queries

After loading, run these queries to confirm data integrity:

```sql
-- 1. Row counts
SELECT 'sales_order_headers' AS tbl, COUNT(*) AS cnt FROM sales_order_headers
UNION ALL SELECT 'sales_order_items', COUNT(*) FROM sales_order_items
UNION ALL SELECT 'outbound_delivery_headers', COUNT(*) FROM outbound_delivery_headers
UNION ALL SELECT 'outbound_delivery_items', COUNT(*) FROM outbound_delivery_items
UNION ALL SELECT 'billing_document_headers', COUNT(*) FROM billing_document_headers
UNION ALL SELECT 'billing_document_items', COUNT(*) FROM billing_document_items
UNION ALL SELECT 'journal_entry_items_accounts_receivable', COUNT(*) FROM journal_entry_items_accounts_receivable
UNION ALL SELECT 'payments_accounts_receivable', COUNT(*) FROM payments_accounts_receivable;

-- 2. Confirm billing item padding (CRITICAL)
-- Should return 0 rows (no unpadded items)
SELECT billingDocument, referenceSdDocumentItem
FROM billing_document_items
WHERE LENGTH(referenceSdDocumentItem) < 6;

-- 3. Full O2C join validation
-- Should return rows if joins are correct
SELECT COUNT(*) AS o2c_rows
FROM sales_order_headers soh
JOIN outbound_delivery_items odi ON odi.referenceSdDocument = soh.salesOrder
JOIN billing_document_items bdi ON bdi.referenceSdDocument = odi.deliveryDocument
    AND bdi.referenceSdDocumentItem = odi.deliveryDocumentItem
JOIN billing_document_headers bdh ON bdh.billingDocument = bdi.billingDocument
JOIN journal_entry_items_accounts_receivable je
    ON je.companyCode = bdh.companyCode
    AND je.fiscalYear = bdh.fiscalYear
    AND je.accountingDocument = bdh.accountingDocument;
```

---

## 8. File Organization

```
project/
├── data/                          ← Raw JSONL files (existing directories)
│   ├── sales_order_headers/
│   ├── sales_order_items/
│   ├── ...
│
├── src/
│   └── db/
│       ├── schema.sql             ← All CREATE TABLE + CREATE INDEX
│       ├── connection.js          ← SQLite connection factory
│       └── loader.js              ← JSONL → SQLite ingestion script
│
├── docs/
│   ├── dataset-analysis.md
│   ├── graph-model.md
│   ├── schema-design.md           ← This document
│   └── ai-session-log.md
│
└── sap_otc.db                     ← Generated SQLite database
```
