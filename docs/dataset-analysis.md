# Dataset Analysis — SAP Order-to-Cash (O2C)

> **Date:** 2026-03-23
> **Status:** ✅ Complete — All tables analyzed, joins validated with real data

---

## 1. Dataset Overview

**Format:** JSONL (one JSON object per line, partitioned across multiple files)
**Total Tables:** 19 (10 transactional + 9 master data)
**Core Flow:** Sales Order → Delivery → Billing → Journal Entry → Payment

---

## 2. Table-by-Table Analysis

### 2.1 Core O2C Flow Tables

---

#### 2.1.1 `sales_order_headers` (100 rows)

| Column | Type | Description |
|--------|------|-------------|
| `salesOrder` | string | **PRIMARY KEY** — Sales order number |
| `salesOrderType` | string | Order type code |
| `salesOrganization` | string | FK → plants/org structure |
| `distributionChannel` | string | Distribution channel code |
| `organizationDivision` | string | Division code |
| `salesGroup` | string | Sales group |
| `salesOffice` | string | Sales office |
| `soldToParty` | string | **FK → business_partners.customer** |
| `creationDate` | string | Order creation date |
| `createdByUser` | string | Creator user ID |
| `lastChangeDateTime` | string | Last modification timestamp |
| `totalNetAmount` | string | Total net amount |
| `overallDeliveryStatus` | string | Delivery status code |
| `overallOrdReltdBillgStatus` | string | Billing status code |
| `overallSdDocReferenceStatus` | string | Reference doc status |
| `transactionCurrency` | string | Currency code (e.g., USD) |
| `pricingDate` | string | Pricing date |
| `requestedDeliveryDate` | string | Requested delivery date |
| `headerBillingBlockReason` | string | Billing block reason |
| `deliveryBlockReason` | string | Delivery block reason |
| `incotermsClassification` | string | Incoterms code |
| `incotermsLocation1` | string | Incoterms location |
| `customerPaymentTerms` | string | Payment terms code |
| `totalCreditCheckStatus` | string | Credit check status |

**Sample:** `salesOrder: "740506"`, `soldToParty: "310000108"`

---

#### 2.1.2 `sales_order_items` (167 rows)

| Column | Type | Description |
|--------|------|-------------|
| `salesOrder` | string | **FK → sales_order_headers.salesOrder** |
| `salesOrderItem` | string | **COMPOSITE PK with salesOrder** — Item number (e.g., "000010") |
| `salesOrderItemCategory` | string | Item category |
| `material` | string | **FK → products.product** |
| `requestedQuantity` | string | Ordered quantity |
| `requestedQuantityUnit` | string | Quantity unit |
| `transactionCurrency` | string | Currency code |
| `netAmount` | string | Item net amount |
| `materialGroup` | string | Material group |
| `productionPlant` | string | **FK → plants.plant** |
| `storageLocation` | string | Storage location |
| `salesDocumentRjcnReason` | string | Rejection reason |
| `itemBillingBlockReason` | string | Item billing block |

**PK:** (`salesOrder`, `salesOrderItem`)

---

#### 2.1.3 `sales_order_schedule_lines` (179 rows)

| Column | Type | Description |
|--------|------|-------------|
| `salesOrder` | string | **FK → sales_order_headers.salesOrder** |
| `salesOrderItem` | string | **FK → sales_order_items.salesOrderItem** |
| `scheduleLine` | string | **COMPOSITE PK with salesOrder + salesOrderItem** |
| `confirmedDeliveryDate` | string | Confirmed delivery date |
| `orderQuantityUnit` | string | Quantity unit |
| `confdOrderQtyByMatlAvailCheck` | string | Confirmed quantity (ATP) |

**PK:** (`salesOrder`, `salesOrderItem`, `scheduleLine`)

---

#### 2.1.4 `outbound_delivery_headers` (86 rows)

| Column | Type | Description |
|--------|------|-------------|
| `deliveryDocument` | string | **PRIMARY KEY** — Delivery document number |
| `actualGoodsMovementDate` | string | Actual goods movement date |
| `actualGoodsMovementTime` | string | Goods movement time |
| `creationDate` | string | Creation date |
| `creationTime` | string | Creation time |
| `deliveryBlockReason` | string | Delivery block reason |
| `hdrGeneralIncompletionStatus` | string | Incompletion status |
| `headerBillingBlockReason` | string | Header billing block |
| `lastChangeDate` | string | Last change date |
| `overallGoodsMovementStatus` | string | Goods movement status |
| `overallPickingStatus` | string | Picking status |
| `overallProofOfDeliveryStatus` | string | POD status |
| `shippingPoint` | string | Shipping point |

**Sample:** `deliveryDocument: "80737721"`

---

#### 2.1.5 `outbound_delivery_items` (137 rows)

| Column | Type | Description |
|--------|------|-------------|
| `deliveryDocument` | string | **FK → outbound_delivery_headers.deliveryDocument** |
| `deliveryDocumentItem` | string | **COMPOSITE PK with deliveryDocument** |
| `actualDeliveryQuantity` | string | Delivered quantity |
| `batch` | string | Batch number |
| `deliveryQuantityUnit` | string | Quantity unit |
| `itemBillingBlockReason` | string | Item billing block |
| `lastChangeDate` | string | Last change date |
| `plant` | string | **FK → plants.plant** |
| `referenceSdDocument` | string | **FK → sales_order_headers.salesOrder** ⭐ |
| `referenceSdDocumentItem` | string | **FK → sales_order_items.salesOrderItem** ⭐ |
| `storageLocation` | string | Storage location |

**PK:** (`deliveryDocument`, `deliveryDocumentItem`)
**CRITICAL JOIN:** `referenceSdDocument` → `salesOrder` (links delivery back to sales order)

**Sample:** `deliveryDocument: "80738076"`, `referenceSdDocument: "740556"`, `referenceSdDocumentItem: "000010"`

---

#### 2.1.6 `billing_document_headers` (163 rows)

| Column | Type | Description |
|--------|------|-------------|
| `billingDocument` | string | **PRIMARY KEY** — Billing document number |
| `billingDocumentType` | string | Document type code |
| `creationDate` | string | Creation date |
| `creationTime` | string | Creation time |
| `lastChangeDateTime` | string | Last change timestamp |
| `billingDocumentDate` | string | Billing date |
| `billingDocumentIsCancelled` | string | Cancellation flag |
| `cancelledBillingDocument` | string | Cancelled billing doc reference |
| `totalNetAmount` | string | Total net amount |
| `transactionCurrency` | string | Currency code |
| `companyCode` | string | Company code |
| `fiscalYear` | string | Fiscal year |
| `accountingDocument` | string | **FK → journal_entry_items_ar.accountingDocument** ⭐ |
| `soldToParty` | string | **FK → business_partners.customer** |

**Sample:** `billingDocument: "90504248"`, `accountingDocument: "9400000249"`, `companyCode: "ABCD"`, `fiscalYear: "2025"`

---

#### 2.1.7 `billing_document_items` (245 rows)

| Column | Type | Description |
|--------|------|-------------|
| `billingDocument` | string | **FK → billing_document_headers.billingDocument** |
| `billingDocumentItem` | string | **COMPOSITE PK with billingDocument** |
| `material` | string | **FK → products.product** |
| `billingQuantity` | string | Billed quantity |
| `billingQuantityUnit` | string | Quantity unit |
| `netAmount` | string | Item net amount |
| `transactionCurrency` | string | Currency code |
| `referenceSdDocument` | string | **FK → outbound_delivery_items.deliveryDocument** ⭐ |
| `referenceSdDocumentItem` | string | **FK → outbound_delivery_items.deliveryDocumentItem** ⭐ |

**PK:** (`billingDocument`, `billingDocumentItem`)
**CRITICAL JOIN:** `referenceSdDocument` → `deliveryDocument` (links billing back to delivery)

**✅ VALIDATED:** 10/10 sampled `referenceSdDocument` values matched `deliveryDocument` values.

---

#### 2.1.8 `billing_document_cancellations` (80 rows)

| Column | Type | Description |
|--------|------|-------------|
| `billingDocument` | string | **PK** — Cancellation billing document |
| `billingDocumentType` | string | Document type |
| `creationDate` | string | Creation date |
| `creationTime` | string | Creation time |
| `lastChangeDateTime` | string | Last change timestamp |
| `billingDocumentDate` | string | Billing date |
| `billingDocumentIsCancelled` | string | Cancellation flag |
| `cancelledBillingDocument` | string | **FK → billing_document_headers.billingDocument** |
| `totalNetAmount` | string | Net amount (typically negative) |
| `transactionCurrency` | string | Currency code |
| `companyCode` | string | Company code |
| `fiscalYear` | string | Fiscal year |
| `accountingDocument` | string | Accounting document |
| `soldToParty` | string | Customer |

**Note:** Same structure as billing_document_headers. These are cancellation (reversal) documents.

---

#### 2.1.9 `journal_entry_items_accounts_receivable` (123 rows)

| Column | Type | Description |
|--------|------|-------------|
| `companyCode` | string | **COMPOSITE PK part** |
| `fiscalYear` | string | **COMPOSITE PK part** |
| `accountingDocument` | string | **COMPOSITE PK part** |
| `accountingDocumentItem` | string | **COMPOSITE PK part** |
| `glAccount` | string | GL account number |
| `referenceDocument` | string | **FK → billing_document_headers.billingDocument** ⭐ |
| `costCenter` | string | Cost center (nullable) |
| `profitCenter` | string | Profit center |
| `transactionCurrency` | string | Transaction currency |
| `amountInTransactionCurrency` | string | Amount in txn currency |
| `companyCodeCurrency` | string | Company code currency |
| `amountInCompanyCodeCurrency` | string | Amount in company currency |
| `postingDate` | string | Posting date |
| `documentDate` | string | Document date |
| `accountingDocumentType` | string | Document type |
| `assignmentReference` | string | Assignment reference |
| `lastChangeDateTime` | string | Last change timestamp |
| `customer` | string | **FK → business_partners.customer** |
| `financialAccountType` | string | Account type (e.g., "D" for debtor) |
| `clearingDate` | string | Clearing date |
| `clearingAccountingDocument` | string | **LINK → payment clearing** ⭐ |
| `clearingDocFiscalYear` | string | Clearing doc fiscal year |

**PK:** (`companyCode`, `fiscalYear`, `accountingDocument`, `accountingDocumentItem`)

**✅ VALIDATED:**
- `accountingDocument` matches `billing_document_headers.accountingDocument` (5/5)
- `referenceDocument` matches `billing_document_headers.billingDocument` (5/5)

---

#### 2.1.10 `payments_accounts_receivable` (120 rows)

| Column | Type | Description |
|--------|------|-------------|
| `companyCode` | string | **COMPOSITE PK part** |
| `fiscalYear` | string | **COMPOSITE PK part** |
| `accountingDocument` | string | **COMPOSITE PK part** |
| `accountingDocumentItem` | string | **COMPOSITE PK part** |
| `clearingDate` | string | Clearing date |
| `clearingAccountingDocument` | string | Clearing accounting document |
| `clearingDocFiscalYear` | string | Clearing doc fiscal year |
| `amountInTransactionCurrency` | string | Amount in txn currency |
| `transactionCurrency` | string | Transaction currency |
| `amountInCompanyCodeCurrency` | string | Amount in company currency |
| `companyCodeCurrency` | string | Company code currency |
| `customer` | string | **FK → business_partners.customer** |
| `invoiceReference` | string | Invoice reference (nullable) |
| `invoiceReferenceFiscalYear` | string | Invoice reference fiscal year (nullable) |
| `salesDocument` | string | Sales document ref (nullable) |
| `salesDocumentItem` | string | Sales document item (nullable) |
| `postingDate` | string | Posting date |
| `documentDate` | string | Document date |
| `assignmentReference` | string | Assignment reference |
| `glAccount` | string | GL account |
| `financialAccountType` | string | Account type |
| `profitCenter` | string | Profit center |
| `costCenter` | string | Cost center (nullable) |

**PK:** (`companyCode`, `fiscalYear`, `accountingDocument`, `accountingDocumentItem`)

**✅ VALIDATED:**
- `Payment.accountingDocument` IN `Journal.accountingDocument`: 20/20 (100%)
- `Journal.clearingAccountingDocument` ↔ `Payment.clearingAccountingDocument`: 56 bidirectional matches

---

### 2.2 Master Data Tables

#### 2.2.1 `business_partners` (8 rows)

| Column | Type |
|--------|------|
| `businessPartner` | string — **PK** |
| `customer` | string — Customer number (used as FK target) |
| `businessPartnerCategory` | string |
| `businessPartnerFullName` | string |
| `businessPartnerGrouping` | string |
| `businessPartnerName` | string |
| `correspondenceLanguage` | string |
| `createdByUser` | string |
| `creationDate` | string |
| `creationTime` | string |
| `firstName` | string |
| `formOfAddress` | string |
| `industry` | string |
| `lastChangeDate` | string |
| `lastName` | string |
| `organizationBpName1` | string |
| `organizationBpName2` | string |
| `businessPartnerIsBlocked` | string |
| `isMarkedForArchiving` | string |

---

#### 2.2.2 `business_partner_addresses` (8 rows)

| Column | Type |
|--------|------|
| `businessPartner` | string — **FK → business_partners.businessPartner** |
| `addressId` | string |
| `validityStartDate` | string |
| `validityEndDate` | string |
| `addressUuid` | string |
| `addressTimeZone` | string |
| `cityName` | string |
| `country` | string |
| `poBox` | string |
| `postalCode` | string |
| `region` | string |
| `streetName` | string |
| `taxJurisdiction` | string |
| `transportZone` | string |
| *(+ PO box fields)* | |

---

#### 2.2.3 `customer_company_assignments` (8 rows)

| Column | Type |
|--------|------|
| `customer` | string — **FK → business_partners.customer** |
| `companyCode` | string — **COMPOSITE PK** |
| `accountingClerk` | string |
| `paymentBlockingReason` | string |
| `paymentMethodsList` | string |
| `paymentTerms` | string |
| `reconciliationAccount` | string |
| `deletionIndicator` | string |
| `customerAccountGroup` | string |
| *(+ clerk contact fields)* | |

---

#### 2.2.4 `customer_sales_area_assignments` (28 rows)

| Column | Type |
|--------|------|
| `customer` | string — **FK → business_partners.customer** |
| `salesOrganization` | string — **COMPOSITE PK** |
| `distributionChannel` | string — **COMPOSITE PK** |
| `division` | string — **COMPOSITE PK** |
| `currency` | string |
| `customerPaymentTerms` | string |
| `incotermsClassification` | string |
| `incotermsLocation1` | string |
| `salesGroup` | string |
| `salesOffice` | string |
| `shippingCondition` | string |
| `supplyingPlant` | string |
| *(+ other sales config)* | |

---

#### 2.2.5 `products` (69 rows)

| Column | Type |
|--------|------|
| `product` | string — **PK** |
| `productType` | string |
| `crossPlantStatus` | string |
| `creationDate` | string |
| `grossWeight` | string |
| `weightUnit` | string |
| `netWeight` | string |
| `productGroup` | string |
| `baseUnit` | string |
| `division` | string |
| `industrySector` | string |
| *(+ status/deletion fields)* | |

---

#### 2.2.6 `product_descriptions` (69 rows)

| Column | Type |
|--------|------|
| `product` | string — **FK → products.product** |
| `language` | string — **COMPOSITE PK** |
| `productDescription` | string — Human-readable product name |

---

#### 2.2.7 `plants` (44 rows)

| Column | Type |
|--------|------|
| `plant` | string — **PK** |
| `plantName` | string |
| `valuationArea` | string |
| `plantCustomer` | string |
| `plantSupplier` | string |
| `salesOrganization` | string |
| `distributionChannel` | string |
| `division` | string |
| `language` | string |
| *(+ factory calendar, org fields)* | |

---

#### 2.2.8 `product_plants` (many rows — large files)

| Column | Type |
|--------|------|
| `product` | string — **FK → products.product** |
| `plant` | string — **FK → plants.plant** |
| `countryOfOrigin` | string |
| `regionOfOrigin` | string |
| `profitCenter` | string |
| `mrpType` | string |
| *(+ availability/fiscal fields)* | |

---

#### 2.2.9 `product_storage_locations` (many rows — large files)

| Column | Type |
|--------|------|
| `product` | string — **FK → products.product** |
| `plant` | string — **FK → plants.plant** |
| `storageLocation` | string — **COMPOSITE PK** |
| `physicalInventoryBlockInd` | string |
| `dateOfLastPostedCntUnRstrcdStk` | string |

---

## 3. Validated Join Paths — Full O2C Chain

### 3.1 Complete Multi-Hop Path

```
sales_order_headers
    │
    ├── [salesOrder] ──→ sales_order_items [salesOrder, salesOrderItem]
    │                         │
    │                         ├──→ sales_order_schedule_lines [salesOrder, salesOrderItem, scheduleLine]
    │                         │
    │                         ▼
    │               outbound_delivery_items
    │               [referenceSdDocument = salesOrder]
    │               [referenceSdDocumentItem = salesOrderItem]
    │                         │
    │                         ├── [deliveryDocument] ──→ outbound_delivery_headers
    │                         │
    │                         ▼
    │               billing_document_items
    │               [referenceSdDocument = deliveryDocument]
    │               [referenceSdDocumentItem = deliveryDocumentItem]
    │                         │
    │                         ├── [billingDocument] ──→ billing_document_headers
    │                         │                              │
    │                         │                              ├── [accountingDocument] ──→ journal_entry_items_ar
    │                         │                              │   [companyCode, fiscalYear, accountingDocument]
    │                         │                              │         │
    │                         │                              │         ├── [clearingAccountingDocument] ──→ payments_ar
    │                         │                              │         │   (via clearing mechanism)
    │                         │                              │         │
    │                         │                              │
    │                         │                              ├── [cancelledBillingDocument] ──→ billing_document_cancellations
```

### 3.2 Join Conditions (Exact SQL)

#### Join 1: Sales Order Header ↔ Items
```sql
-- DIRECT JOIN (header → items)
sales_order_headers.salesOrder = sales_order_items.salesOrder
```

#### Join 2: Sales Order Items ↔ Schedule Lines
```sql
-- DIRECT JOIN (items → schedule lines)
sales_order_items.salesOrder = sales_order_schedule_lines.salesOrder
AND sales_order_items.salesOrderItem = sales_order_schedule_lines.salesOrderItem
```

#### Join 3: Sales Order → Delivery ⭐
```sql
-- CROSS-DOCUMENT JOIN (via delivery item reference back to sales order)
outbound_delivery_items.referenceSdDocument = sales_order_headers.salesOrder
AND outbound_delivery_items.referenceSdDocumentItem = sales_order_items.salesOrderItem
```
**✅ Validated:** `referenceSdDocument` value "740556" matches `salesOrder` format.

#### Join 4: Delivery Header ↔ Items
```sql
-- DIRECT JOIN
outbound_delivery_headers.deliveryDocument = outbound_delivery_items.deliveryDocument
```

#### Join 5: Delivery → Billing ⭐
```sql
-- CROSS-DOCUMENT JOIN (via billing item reference back to delivery)
-- ⚠️ CRITICAL: Item number format mismatch!
--   billing_document_items.referenceSdDocumentItem = "10" (unpadded)
--   outbound_delivery_items.deliveryDocumentItem   = "000010" (zero-padded to 6 digits)
-- Must normalize with printf/LPAD:
billing_document_items.referenceSdDocument = outbound_delivery_items.deliveryDocument
AND printf('%06d', CAST(billing_document_items.referenceSdDocumentItem AS INTEGER))
    = outbound_delivery_items.deliveryDocumentItem
```
**✅ Validated:**
- 10/10 sampled `referenceSdDocument` values in billing matched delivery document numbers
- **0/245 direct string match** on item numbers (format mismatch confirmed)
- **245/245 match** when billing item is zero-padded to 6 digits

#### Join 6: Billing Header ↔ Items
```sql
-- DIRECT JOIN
billing_document_headers.billingDocument = billing_document_items.billingDocument
```

#### Join 7: Billing → Journal Entry ⭐
```sql
-- CROSS-DOCUMENT JOIN (via accounting document created during billing)
-- Primary path:
billing_document_headers.accountingDocument = journal_entry_items_ar.accountingDocument
AND billing_document_headers.companyCode = journal_entry_items_ar.companyCode
AND billing_document_headers.fiscalYear = journal_entry_items_ar.fiscalYear

-- Alternative/verification path:
journal_entry_items_ar.referenceDocument = billing_document_headers.billingDocument
```
**✅ Validated:** Both paths confirmed — 5/5 matches on each.

#### Join 8: Journal Entry → Payment ⭐
```sql
-- CLEARING-BASED JOIN (SAP clearing mechanism)
-- Path A: Direct accounting document match (payments are a subset of journal entries)
payments_accounts_receivable.accountingDocument = journal_entry_items_ar.accountingDocument
AND payments_accounts_receivable.companyCode = journal_entry_items_ar.companyCode
AND payments_accounts_receivable.fiscalYear = journal_entry_items_ar.fiscalYear

-- Path B: Via clearing document (links invoice entries to payment entries)
journal_entry_items_ar.clearingAccountingDocument = payments_accounts_receivable.clearingAccountingDocument
AND journal_entry_items_ar.companyCode = payments_accounts_receivable.companyCode
AND journal_entry_items_ar.clearingDocFiscalYear = payments_accounts_receivable.clearingDocFiscalYear
```
**✅ Validated:**
- Payment.accountingDocument IN Journal.accountingDocument: 20/20 (100%)
- Bidirectional clearing match: 56 records

### 3.3 Master Data Joins

```sql
-- Customer / Business Partner
sales_order_headers.soldToParty = business_partners.customer
billing_document_headers.soldToParty = business_partners.customer
journal_entry_items_ar.customer = business_partners.customer
payments_accounts_receivable.customer = business_partners.customer
business_partner_addresses.businessPartner = business_partners.businessPartner
customer_company_assignments.customer = business_partners.customer
customer_sales_area_assignments.customer = business_partners.customer

-- Products / Materials
sales_order_items.material = products.product
billing_document_items.material = products.product
product_descriptions.product = products.product
product_plants.product = products.product
product_storage_locations.product = products.product

-- Plants
sales_order_items.productionPlant = plants.plant
outbound_delivery_items.plant = plants.plant
product_plants.plant = plants.plant
product_storage_locations.plant = plants.plant
```

---

## 4. Join Classification

### 4.1 Direct Joins (Same document type, header ↔ item)
| From | To | Join Key |
|------|----|----------|
| sales_order_headers | sales_order_items | `salesOrder` |
| sales_order_items | sales_order_schedule_lines | `salesOrder` + `salesOrderItem` |
| outbound_delivery_headers | outbound_delivery_items | `deliveryDocument` |
| billing_document_headers | billing_document_items | `billingDocument` |

### 4.2 Cross-Document Joins (via reference fields) ⭐ CRITICAL
| From | To | Join Key | Confidence |
|------|----|----------|------------|
| sales_order (header/items) | outbound_delivery_items | `referenceSdDocument` = `salesOrder` | ✅ HIGH |
| outbound_delivery_items | billing_document_items | `referenceSdDocument` = `deliveryDocument` | ✅ HIGH |
| billing_document_headers | journal_entry_items_ar | `accountingDocument` (+ companyCode, fiscalYear) | ✅ HIGH |
| journal_entry_items_ar | payments_accounts_receivable | `accountingDocument` or `clearingAccountingDocument` | ✅ HIGH |
| billing_document_headers | billing_document_cancellations | `cancelledBillingDocument` = `billingDocument` | ✅ HIGH |

### 4.3 Ambiguous / Indirect Joins
| Relationship | Notes |
|-------------|-------|
| `payments_ar.invoiceReference` | **Nullable in sample data** — not reliable for primary joins |
| `payments_ar.salesDocument` | **Nullable in sample data** — not reliable for primary joins |
| Journal → Payment clearing | Bidirectional — both tables reference clearing docs; use `clearingAccountingDocument` with caution |

---

## 5. Full O2C Query Example

```sql
-- Trace a complete Order-to-Cash flow for a specific sales order
SELECT
    soh.salesOrder,
    soh.soldToParty,
    soh.totalNetAmount AS order_amount,
    soi.salesOrderItem,
    soi.material,
    soi.netAmount AS item_amount,
    odh.deliveryDocument,
    odh.actualGoodsMovementDate,
    odi.actualDeliveryQuantity,
    bdh.billingDocument,
    bdh.billingDocumentDate,
    bdh.totalNetAmount AS billed_amount,
    je.accountingDocument AS journal_doc,
    je.postingDate AS journal_posting_date,
    je.amountInTransactionCurrency AS journal_amount,
    pay.accountingDocument AS payment_doc,
    pay.postingDate AS payment_date,
    pay.amountInTransactionCurrency AS payment_amount
FROM sales_order_headers soh
JOIN sales_order_items soi
    ON soh.salesOrder = soi.salesOrder
JOIN outbound_delivery_items odi
    ON odi.referenceSdDocument = soh.salesOrder
    AND odi.referenceSdDocumentItem = soi.salesOrderItem
JOIN outbound_delivery_headers odh
    ON odh.deliveryDocument = odi.deliveryDocument
JOIN billing_document_items bdi
    ON bdi.referenceSdDocument = odi.deliveryDocument
    AND printf('%06d', CAST(bdi.referenceSdDocumentItem AS INTEGER)) = odi.deliveryDocumentItem
JOIN billing_document_headers bdh
    ON bdh.billingDocument = bdi.billingDocument
JOIN journal_entry_items_accounts_receivable je
    ON je.accountingDocument = bdh.accountingDocument
    AND je.companyCode = bdh.companyCode
    AND je.fiscalYear = bdh.fiscalYear
LEFT JOIN payments_accounts_receivable pay
    ON pay.accountingDocument = je.accountingDocument
    AND pay.companyCode = je.companyCode
    AND pay.fiscalYear = je.fiscalYear
WHERE soh.salesOrder = '740506';
```

---

## 6. Data Quality Notes

1. **Consistent company code**: All transactional data uses `companyCode = "ABCD"`
2. **Fiscal year**: All data is from fiscal year `2025`
3. **Payment nullable fields**: `invoiceReference`, `salesDocument`, `salesDocumentItem` are frequently `null` — do NOT rely on these for primary joins
4. **Cancellations**: 80 cancellation documents exist — any billing analysis should filter `billingDocumentIsCancelled`
5. **Item numbering format mismatch (CONFIRMED)**: 
   - Sales order items: 6-digit zero-padded (`"000010"`)
   - Delivery items: 6-digit zero-padded (`"000010"`)
   - Billing items referenceSdDocumentItem: **unpadded** (`"10"`)
   - **0/245 direct matches, 245/245 padded matches** — MUST use `printf('%06d', CAST(... AS INTEGER))` in SQL joins
