# Graph Model Design — SAP Order-to-Cash (Demo Dataset)

> **Date:** 2026-03-23
> **Status:** ✅ Complete
> **Source of truth:** [dataset-analysis.md](./dataset-analysis.md)

> **Note:** This document describes the graph model for the **demo SAP O2C dataset** included with the project. The O2C Insight Engine supports graph extraction from **any relational dataset**. When users upload their own data, the graph extractor reads relationships from the active dataset config and dynamically builds nodes and edges. The patterns described here (header-level edges, item-level joins, composite keys) informed the generic graph extraction logic.

---

## 1. Design Philosophy

The graph model abstracts SAP's table-level complexity into **clean business-level entities**. For the demo O2C dataset, this means mapping 19 tables into 8 node types and 12 edge types. For user-uploaded datasets, the system auto-generates node types from table names and edge types from detected relationships.

**Key principles:**
- **Nodes = Business objects** (not individual tables)
- **Edges = Business relationships** (not raw foreign keys)
- **Item-level joins are internal** — the graph presents header-level connections
- Multiple underlying tables merge into a single node type
- All edge definitions use ONLY validated joins from Step 1

---

## 2. Node Definitions

### 2.1 Demo Dataset: Core O2C Nodes

| Node Type | Business Meaning | Underlying Tables | Primary Identifier |
|-----------|-----------------|-------------------|--------------------|
| **SalesOrder** | A customer's purchase order | `sales_order_headers` + `sales_order_items` + `sales_order_schedule_lines` | `salesOrder` (e.g., "740506") |
| **Delivery** | Physical shipment of goods | `outbound_delivery_headers` + `outbound_delivery_items` | `deliveryDocument` (e.g., "80737721") |
| **BillingDocument** | Invoice / credit memo | `billing_document_headers` + `billing_document_items` | `billingDocument` (e.g., "90504248") |
| **JournalEntry** | Financial accounting posting (AR) | `journal_entry_items_accounts_receivable` | `companyCode` + `fiscalYear` + `accountingDocument` (e.g., "ABCD/2025/9400000249") |
| **Payment** | Customer payment posting | `payments_accounts_receivable` | `companyCode` + `fiscalYear` + `accountingDocument` (e.g., "ABCD/2025/9400000220") |

### 2.2 Demo Dataset: Master Data Nodes

| Node Type | Business Meaning | Underlying Tables | Primary Identifier |
|-----------|-----------------|-------------------|--------------------|
| **Customer** | Business partner / sold-to party | `business_partners` + `business_partner_addresses` + `customer_company_assignments` + `customer_sales_area_assignments` | `customer` (e.g., "310000108") |
| **Product** | Material / product | `products` + `product_descriptions` | `product` (e.g., material code) |
| **Plant** | Manufacturing / distribution site | `plants` + `product_plants` + `product_storage_locations` | `plant` (e.g., plant code) |

---

## 3. Node Detail — Table-to-Node Mapping

### 3.1 SalesOrder Node

Merges 3 tables into one business entity.

```
SalesOrder {
  // From sales_order_headers (1 row per order)
  id:                    salesOrder           -- PK
  type:                  salesOrderType
  salesOrganization:     salesOrganization
  distributionChannel:   distributionChannel
  soldToParty:           soldToParty          -- → Customer node
  creationDate:          creationDate
  totalNetAmount:        totalNetAmount
  currency:              transactionCurrency
  deliveryStatus:        overallDeliveryStatus
  billingStatus:         overallOrdReltdBillgStatus
  paymentTerms:          customerPaymentTerms
  billingBlock:          headerBillingBlockReason
  deliveryBlock:         deliveryBlockReason

  // From sales_order_items (N rows per order)
  items[] {
    itemNumber:          salesOrderItem       -- "000010"
    material:            material             -- → Product node
    quantity:            requestedQuantity
    unit:                requestedQuantityUnit
    netAmount:           netAmount
    plant:               productionPlant      -- → Plant node
    rejectionReason:     salesDocumentRjcnReason
  }

  // From sales_order_schedule_lines (N rows per item)
  items[].scheduleLines[] {
    scheduleLine:        scheduleLine
    confirmedDate:       confirmedDeliveryDate
    confirmedQty:        confdOrderQtyByMatlAvailCheck
  }
}
```

**Internal table joins:**
```sql
sales_order_headers.salesOrder = sales_order_items.salesOrder
sales_order_items.salesOrder = sales_order_schedule_lines.salesOrder
  AND sales_order_items.salesOrderItem = sales_order_schedule_lines.salesOrderItem
```

---

### 3.2 Delivery Node

Merges 2 tables into one business entity.

```
Delivery {
  // From outbound_delivery_headers (1 row per delivery)
  id:                    deliveryDocument     -- PK
  goodsMovementDate:     actualGoodsMovementDate
  creationDate:          creationDate
  shippingPoint:         shippingPoint
  goodsMovementStatus:   overallGoodsMovementStatus
  pickingStatus:         overallPickingStatus
  podStatus:             overallProofOfDeliveryStatus
  deliveryBlock:         deliveryBlockReason
  billingBlock:          headerBillingBlockReason

  // From outbound_delivery_items (N rows per delivery)
  items[] {
    itemNumber:          deliveryDocumentItem -- "000010"
    quantity:            actualDeliveryQuantity
    unit:                deliveryQuantityUnit
    batch:               batch
    plant:               plant                -- → Plant node
    storageLocation:     storageLocation
    // Reference fields (used for edge resolution, not exposed directly)
    _refSalesOrder:      referenceSdDocument
    _refSalesOrderItem:  referenceSdDocumentItem
  }
}
```

**Internal table joins:**
```sql
outbound_delivery_headers.deliveryDocument = outbound_delivery_items.deliveryDocument
```

---

### 3.3 BillingDocument Node

Merges 2 tables + cancellation table into one business entity.

```
BillingDocument {
  // From billing_document_headers (1 row per billing doc)
  id:                    billingDocument      -- PK
  type:                  billingDocumentType
  billingDate:           billingDocumentDate
  creationDate:          creationDate
  totalNetAmount:        totalNetAmount
  currency:              transactionCurrency
  companyCode:           companyCode
  fiscalYear:            fiscalYear
  isCancelled:           billingDocumentIsCancelled
  cancelledDocument:     cancelledBillingDocument
  soldToParty:           soldToParty          -- → Customer node
  // Reference for edge resolution
  _accountingDocument:   accountingDocument

  // From billing_document_items (N rows per billing doc)
  items[] {
    itemNumber:          billingDocumentItem  -- "10" (UNPADDED!)
    material:            material             -- → Product node
    quantity:            billingQuantity
    unit:                billingQuantityUnit
    netAmount:           netAmount
    // Reference fields (used for edge resolution)
    _refDeliveryDoc:     referenceSdDocument
    _refDeliveryItem:    referenceSdDocumentItem  -- UNPADDED format
  }
}
```

**Internal table joins:**
```sql
billing_document_headers.billingDocument = billing_document_items.billingDocument
```

**Cancellation relationship (same node type, self-referencing):**
```sql
billing_document_cancellations.cancelledBillingDocument = billing_document_headers.billingDocument
```

---

### 3.4 JournalEntry Node

Single table, but composite key.

```
JournalEntry {
  // From journal_entry_items_accounts_receivable
  companyCode:           companyCode          -- PK part 1
  fiscalYear:            fiscalYear           -- PK part 2
  accountingDocument:    accountingDocument   -- PK part 3
  lineItem:              accountingDocumentItem -- PK part 4
  glAccount:             glAccount
  customer:              customer             -- → Customer node
  postingDate:           postingDate
  documentDate:          documentDate
  documentType:          accountingDocumentType
  amountTxn:             amountInTransactionCurrency
  currencyTxn:           transactionCurrency
  amountLocal:           amountInCompanyCodeCurrency
  currencyLocal:         companyCodeCurrency
  profitCenter:          profitCenter
  costCenter:            costCenter
  clearingDate:          clearingDate
  accountType:           financialAccountType
  // Reference fields
  _referenceDocument:    referenceDocument    -- → billingDocument
  _clearingDocument:     clearingAccountingDocument -- → Payment link
  _clearingFiscalYear:   clearingDocFiscalYear
}
```

**Composite ID for graph:** `companyCode/fiscalYear/accountingDocument` (unique at document level)

---

### 3.5 Payment Node

Single table, composite key.

```
Payment {
  // From payments_accounts_receivable
  companyCode:           companyCode          -- PK part 1
  fiscalYear:            fiscalYear           -- PK part 2
  accountingDocument:    accountingDocument   -- PK part 3
  lineItem:              accountingDocumentItem -- PK part 4
  customer:              customer             -- → Customer node
  postingDate:           postingDate
  documentDate:          documentDate
  amountTxn:             amountInTransactionCurrency
  currencyTxn:           transactionCurrency
  amountLocal:           amountInCompanyCodeCurrency
  currencyLocal:         companyCodeCurrency
  clearingDate:          clearingDate
  clearingDocument:      clearingAccountingDocument
  clearingFiscalYear:    clearingDocFiscalYear
  glAccount:             glAccount
  accountType:           financialAccountType
  profitCenter:          profitCenter
  // Nullable references (NOT used for primary joins)
  invoiceReference:      invoiceReference
  salesDocument:         salesDocument
}
```

**Composite ID for graph:** `companyCode/fiscalYear/accountingDocument`

---

### 3.6 Customer Node

Merges 4 tables.

```
Customer {
  // From business_partners
  id:                    customer             -- PK (used by SO, billing, journal, payment)
  businessPartner:       businessPartner      -- Alternate ID
  name:                  businessPartnerName
  fullName:              businessPartnerFullName
  category:              businessPartnerCategory
  industry:              industry
  isBlocked:             businessPartnerIsBlocked

  // From business_partner_addresses
  address {
    city:                cityName
    country:             country
    postalCode:          postalCode
    region:              region
    street:              streetName
  }

  // From customer_company_assignments (per company code)
  companyAssignments[] {
    companyCode:         companyCode
    paymentTerms:        paymentTerms
    reconciliationAcct:  reconciliationAccount
  }

  // From customer_sales_area_assignments (per sales area)
  salesAreaAssignments[] {
    salesOrg:            salesOrganization
    distChannel:         distributionChannel
    division:            division
    paymentTerms:        customerPaymentTerms
    incoterms:           incotermsClassification
  }
}
```

---

### 3.7 Product Node

Merges 2 tables.

```
Product {
  // From products
  id:                    product              -- PK
  type:                  productType
  group:                 productGroup
  division:              division
  baseUnit:              baseUnit
  grossWeight:           grossWeight
  netWeight:             netWeight
  weightUnit:            weightUnit

  // From product_descriptions
  description:           productDescription   -- (language = 'EN')
}
```

---

### 3.8 Plant Node

Single table.

```
Plant {
  // From plants
  id:                    plant                -- PK
  name:                  plantName
  salesOrganization:     salesOrganization
  distributionChannel:   distributionChannel
  category:              plantCategory
}
```

---

## 4. Edge Definitions

### 4.1 Core O2C Edges (The Main Chain)

#### Edge 1: `FULFILLED_BY` — SalesOrder → Delivery

| Property | Value |
|----------|-------|
| **Source Node** | SalesOrder |
| **Target Node** | Delivery |
| **Direction** | SalesOrder → Delivery |
| **Cardinality** | 1:N (one order can have multiple deliveries) |
| **Business meaning** | "This sales order was fulfilled by this delivery" |
| **Join granularity** | **Item-level** (resolved internally, exposed as header-level edge) |

**Underlying SQL join:**
```sql
-- Item-level join (internal)
outbound_delivery_items.referenceSdDocument = sales_order_items.salesOrder
AND outbound_delivery_items.referenceSdDocumentItem = sales_order_items.salesOrderItem

-- Header-level edge (exposed to graph)
-- Derived by: SELECT DISTINCT soh.salesOrder, odi.deliveryDocument
-- FROM sales_order_headers soh
-- JOIN outbound_delivery_items odi
--   ON odi.referenceSdDocument = soh.salesOrder
```

**Edge properties (optional enrichment):**
- `itemCount`: number of line items in this fulfillment
- `totalQuantity`: sum of delivered quantities

---

#### Edge 2: `BILLED_AS` — Delivery → BillingDocument

| Property | Value |
|----------|-------|
| **Source Node** | Delivery |
| **Target Node** | BillingDocument |
| **Direction** | Delivery → BillingDocument |
| **Cardinality** | 1:N (one delivery can generate multiple invoices) |
| **Business meaning** | "This delivery was invoiced as this billing document" |
| **Join granularity** | **Item-level** (resolved internally, exposed as header-level edge) |

**Underlying SQL join:**
```sql
-- Item-level join (internal)
-- ⚠️ CRITICAL: Item number padding required!
billing_document_items.referenceSdDocument = outbound_delivery_items.deliveryDocument
AND printf('%06d', CAST(billing_document_items.referenceSdDocumentItem AS INTEGER))
    = outbound_delivery_items.deliveryDocumentItem

-- Header-level edge (exposed to graph)
-- Derived by: SELECT DISTINCT odi.deliveryDocument, bdi.billingDocument
-- FROM outbound_delivery_items odi
-- JOIN billing_document_items bdi
--   ON bdi.referenceSdDocument = odi.deliveryDocument
--   AND printf('%06d', CAST(bdi.referenceSdDocumentItem AS INTEGER)) = odi.deliveryDocumentItem
```

> ⚠️ **PADDING ISSUE**: `billing_document_items.referenceSdDocumentItem` stores `"10"` (unpadded)
> while `outbound_delivery_items.deliveryDocumentItem` stores `"000010"` (zero-padded to 6).
> **MUST** use `printf('%06d', CAST(... AS INTEGER))` — 0/245 direct matches, 245/245 padded.

---

#### Edge 3: `POSTED_AS` — BillingDocument → JournalEntry

| Property | Value |
|----------|-------|
| **Source Node** | BillingDocument |
| **Target Node** | JournalEntry |
| **Direction** | BillingDocument → JournalEntry |
| **Cardinality** | 1:1 (each billing doc creates exactly one accounting document) |
| **Business meaning** | "This invoice was posted as this journal entry" |
| **Join granularity** | **Header-level** (direct key match) |

**Underlying SQL join:**
```sql
-- Primary path (direct FK)
billing_document_headers.accountingDocument = journal_entry_items_ar.accountingDocument
AND billing_document_headers.companyCode = journal_entry_items_ar.companyCode
AND billing_document_headers.fiscalYear = journal_entry_items_ar.fiscalYear

-- Verification path (reverse reference)
journal_entry_items_ar.referenceDocument = billing_document_headers.billingDocument
```

---

#### Edge 4: `CLEARED_BY` — JournalEntry → Payment

| Property | Value |
|----------|-------|
| **Source Node** | JournalEntry |
| **Target Node** | Payment |
| **Direction** | JournalEntry → Payment |
| **Cardinality** | N:M (see note below) |
| **Business meaning** | "This journal entry (invoice AR line) was cleared by this payment" |
| **Join granularity** | **Header-level** (via clearing mechanism) |

**Cardinality note:**
> Modeled as 1:1 for this dataset (our data shows single clearing per document), but designed
> to support N:M relationships in real-world SAP scenarios:
> - **1:N** — One invoice cleared by multiple partial payments
> - **N:1** — One payment clearing multiple invoices in a single clearing run
> - **1:1** — One invoice fully cleared by one payment (most common in our dataset)
>
> The SQL joins and graph traversal logic do NOT assume 1:1. They use JOIN (not scalar lookups),
> ensuring correctness regardless of cardinality.

**Underlying SQL join:**
```sql
-- Path A: Direct match (payment and journal share accounting documents)
payments_accounts_receivable.accountingDocument = journal_entry_items_ar.accountingDocument
AND payments_accounts_receivable.companyCode = journal_entry_items_ar.companyCode
AND payments_accounts_receivable.fiscalYear = journal_entry_items_ar.fiscalYear

-- Path B: Via clearing document (links invoice entries to payment entries)
journal_entry_items_ar.clearingAccountingDocument = payments_accounts_receivable.clearingAccountingDocument
AND journal_entry_items_ar.companyCode = payments_accounts_receivable.companyCode
AND journal_entry_items_ar.clearingDocFiscalYear = payments_accounts_receivable.clearingDocFiscalYear
```

**Note:** Path A is preferred for simplicity. Path B is useful when tracing clearing chains.

---

### 4.2 Master Data Edges

#### Edge 5: `ORDERED_BY` — SalesOrder → Customer

| Property | Value |
|----------|-------|
| **Source Node** | SalesOrder |
| **Target Node** | Customer |
| **Direction** | SalesOrder → Customer |
| **Cardinality** | N:1 |
| **SQL** | `sales_order_headers.soldToParty = business_partners.customer` |

#### Edge 6: `INVOICED_TO` — BillingDocument → Customer

| Property | Value |
|----------|-------|
| **Source Node** | BillingDocument |
| **Target Node** | Customer |
| **Direction** | BillingDocument → Customer |
| **Cardinality** | N:1 |
| **SQL** | `billing_document_headers.soldToParty = business_partners.customer` |

#### Edge 7: `PAID_BY` — Payment → Customer

| Property | Value |
|----------|-------|
| **Source Node** | Payment |
| **Target Node** | Customer |
| **Direction** | Payment → Customer |
| **Cardinality** | N:1 |
| **SQL** | `payments_accounts_receivable.customer = business_partners.customer` |

#### Edge 8: `CONTAINS_PRODUCT` — SalesOrder → Product

| Property | Value |
|----------|-------|
| **Source Node** | SalesOrder |
| **Target Node** | Product |
| **Direction** | SalesOrder → Product |
| **Cardinality** | N:M (via items) |
| **SQL** | `sales_order_items.material = products.product` |

#### Edge 9: `SHIPS_PRODUCT` — Delivery → Product (implicit via order items)

Derived indirectly: Delivery → SalesOrderItem → Product.

#### Edge 10: `PRODUCED_AT` — SalesOrder → Plant

| Property | Value |
|----------|-------|
| **Source Node** | SalesOrder |
| **Target Node** | Plant |
| **Direction** | SalesOrder → Plant |
| **Cardinality** | N:M (via items) |
| **SQL** | `sales_order_items.productionPlant = plants.plant` |

#### Edge 11: `SHIPS_FROM` — Delivery → Plant

| Property | Value |
|----------|-------|
| **Source Node** | Delivery |
| **Target Node** | Plant |
| **Direction** | Delivery → Plant |
| **Cardinality** | N:M (via items) |
| **SQL** | `outbound_delivery_items.plant = plants.plant` |

#### Edge 12: `CANCELS` — BillingDocument → BillingDocument (self-referencing)

| Property | Value |
|----------|-------|
| **Source Node** | BillingDocument (cancellation) |
| **Target Node** | BillingDocument (original) |
| **Direction** | Cancellation → Original |
| **Cardinality** | 1:1 |
| **SQL** | `billing_document_cancellations.cancelledBillingDocument = billing_document_headers.billingDocument` |

---

## 5. Edge Summary Table

| # | Edge Name | Source | Target | Level | Padding? |
|---|-----------|--------|--------|-------|----------|
| 1 | `FULFILLED_BY` | SalesOrder | Delivery | Item→Header | No |
| 2 | `BILLED_AS` | Delivery | BillingDocument | Item→Header | **YES** ⚠️ |
| 3 | `POSTED_AS` | BillingDocument | JournalEntry | Header | No |
| 4 | `CLEARED_BY` | JournalEntry | Payment | Header | No |
| 5 | `ORDERED_BY` | SalesOrder | Customer | Header | No |
| 6 | `INVOICED_TO` | BillingDocument | Customer | Header | No |
| 7 | `PAID_BY` | Payment | Customer | Header | No |
| 8 | `CONTAINS_PRODUCT` | SalesOrder | Product | Item | No |
| 9 | `SHIPS_PRODUCT` | Delivery | Product | Derived | No |
| 10 | `PRODUCED_AT` | SalesOrder | Plant | Item | No |
| 11 | `SHIPS_FROM` | Delivery | Plant | Item | No |
| 12 | `CANCELS` | BillingDocument | BillingDocument | Header | No |

---

## 6. Special Cases & Engineering Notes

### 6.1 Item-Level vs Header-Level Joins

The following edges are resolved at **item level** internally but exposed as **header-level** connections:

| Edge | Internal Join Tables | Exposed As |
|------|---------------------|------------|
| `FULFILLED_BY` | `sales_order_items` ↔ `outbound_delivery_items` | SalesOrder → Delivery |
| `BILLED_AS` | `outbound_delivery_items` ↔ `billing_document_items` | Delivery → BillingDocument |
| `CONTAINS_PRODUCT` | `sales_order_items` ↔ `products` | SalesOrder → Product |

**Implementation implication:** When building edges, we must:
1. JOIN at item level to get the relationship
2. `SELECT DISTINCT` at header level for the graph edge
3. Optionally aggregate item-level data as edge properties

### 6.2 Billing Item Number Padding (CRITICAL)

```
┌─────────────────────────────────────────────────────────────────┐
│  ⚠️  PADDING RULE                                               │
│                                                                 │
│  billing_document_items.referenceSdDocumentItem  →  "10"        │
│  outbound_delivery_items.deliveryDocumentItem    →  "000010"    │
│                                                                 │
│  SQL fix: printf('%06d', CAST(ref AS INTEGER)) = deliveryItem   │
│                                                                 │
│  Without this: 0/245 matches                                    │
│  With this:    245/245 matches                                  │
└─────────────────────────────────────────────────────────────────┘
```

This applies to **Edge 2 (BILLED_AS)** ONLY. All other edges use consistent formats.

### 6.3 Composite Keys for Financial Nodes

JournalEntry and Payment nodes use composite identifiers:
```
Graph Node ID = `${companyCode}/${fiscalYear}/${accountingDocument}`
Example:       "ABCD/2025/9400000249"
```

This ensures uniqueness across company codes and fiscal years, even though our dataset has only one company code ("ABCD") and one fiscal year ("2025").

### 6.4 Cancellation Handling

BillingDocument has a self-referencing edge (`CANCELS`). When traversing the graph:
- Filter `billingDocumentIsCancelled != 'true'` if you want only active invoices
- Follow the `CANCELS` edge to find the original document for a cancellation

---

## 7. Example Traversal: Full O2C Path

### 7.1 Graph Traversal (Business Level)

```
Customer("310000108")
    ← ORDERED_BY ←
SalesOrder("740506")
    → FULFILLED_BY →
Delivery("80738076")
    → BILLED_AS →
BillingDocument("90504248")
    → POSTED_AS →
JournalEntry("ABCD/2025/9400000249")
    → CLEARED_BY →
Payment("ABCD/2025/9400000249")
```

### 7.2 Same Traversal as SQL

```sql
SELECT
    -- Customer
    bp.businessPartnerName AS customer_name,
    bp.customer AS customer_id,
    -- Sales Order
    soh.salesOrder,
    soh.creationDate AS order_date,
    soh.totalNetAmount AS order_amount,
    -- Delivery
    odh.deliveryDocument,
    odh.actualGoodsMovementDate AS ship_date,
    -- Billing
    bdh.billingDocument,
    bdh.billingDocumentDate AS invoice_date,
    bdh.totalNetAmount AS invoice_amount,
    -- Journal Entry
    je.accountingDocument AS journal_doc,
    je.postingDate AS posting_date,
    -- Payment
    pay.accountingDocument AS payment_doc,
    pay.postingDate AS payment_date,
    pay.clearingDate
FROM sales_order_headers soh
-- Edge: ORDERED_BY
JOIN business_partners bp
    ON bp.customer = soh.soldToParty
-- Edge: FULFILLED_BY (item-level, distinct at header)
JOIN outbound_delivery_items odi
    ON odi.referenceSdDocument = soh.salesOrder
JOIN outbound_delivery_headers odh
    ON odh.deliveryDocument = odi.deliveryDocument
-- Edge: BILLED_AS (item-level with PADDING, distinct at header)
JOIN billing_document_items bdi
    ON bdi.referenceSdDocument = odi.deliveryDocument
    AND printf('%06d', CAST(bdi.referenceSdDocumentItem AS INTEGER))
        = odi.deliveryDocumentItem
JOIN billing_document_headers bdh
    ON bdh.billingDocument = bdi.billingDocument
-- Edge: POSTED_AS (header-level)
JOIN journal_entry_items_accounts_receivable je
    ON je.accountingDocument = bdh.accountingDocument
    AND je.companyCode = bdh.companyCode
    AND je.fiscalYear = bdh.fiscalYear
-- Edge: CLEARED_BY (header-level)
LEFT JOIN payments_accounts_receivable pay
    ON pay.accountingDocument = je.accountingDocument
    AND pay.companyCode = je.companyCode
    AND pay.fiscalYear = je.fiscalYear
WHERE soh.salesOrder = '740506'
GROUP BY soh.salesOrder, odh.deliveryDocument, bdh.billingDocument,
         je.accountingDocument, pay.accountingDocument;
```

---

## 8. Graph Visualization Schema (for Cytoscape)

```json
{
  "nodeTypes": {
    "SalesOrder":      { "color": "#4CAF50", "shape": "round-rectangle", "label": "salesOrder" },
    "Delivery":        { "color": "#2196F3", "shape": "round-rectangle", "label": "deliveryDocument" },
    "BillingDocument": { "color": "#FF9800", "shape": "round-rectangle", "label": "billingDocument" },
    "JournalEntry":    { "color": "#9C27B0", "shape": "diamond",         "label": "accountingDocument" },
    "Payment":         { "color": "#00BCD4", "shape": "ellipse",         "label": "accountingDocument" },
    "Customer":        { "color": "#F44336", "shape": "ellipse",         "label": "businessPartnerName" },
    "Product":         { "color": "#795548", "shape": "rectangle",       "label": "productDescription" },
    "Plant":           { "color": "#607D8B", "shape": "rectangle",       "label": "plantName" }
  },
  "edgeTypes": {
    "FULFILLED_BY":      { "color": "#4CAF50", "style": "solid",  "arrow": "triangle" },
    "BILLED_AS":         { "color": "#FF9800", "style": "solid",  "arrow": "triangle" },
    "POSTED_AS":         { "color": "#9C27B0", "style": "solid",  "arrow": "triangle" },
    "CLEARED_BY":        { "color": "#00BCD4", "style": "solid",  "arrow": "triangle" },
    "ORDERED_BY":        { "color": "#F44336", "style": "dashed", "arrow": "triangle" },
    "INVOICED_TO":       { "color": "#F44336", "style": "dashed", "arrow": "triangle" },
    "PAID_BY":           { "color": "#F44336", "style": "dashed", "arrow": "triangle" },
    "CONTAINS_PRODUCT":  { "color": "#795548", "style": "dotted", "arrow": "triangle" },
    "PRODUCED_AT":       { "color": "#607D8B", "style": "dotted", "arrow": "triangle" },
    "SHIPS_FROM":        { "color": "#607D8B", "style": "dotted", "arrow": "triangle" },
    "CANCELS":           { "color": "#F44336", "style": "solid",  "arrow": "tee" }
  }
}
```

---

## 9. Graph Model Diagram

```
                                    ┌──────────┐
                                    │ Customer │
                                    └────┬─────┘
                          ┌──────────────┼──────────────┐
                     ORDERED_BY     INVOICED_TO      PAID_BY
                          │              │              │
                    ┌─────▼─────┐  ┌─────▼──────┐  ┌───▼────┐
                    │SalesOrder │  │BillingDoc   │  │Payment │
                    └─────┬─────┘  └──────▲──────┘  └───▲────┘
                          │               │             │
    ┌──────────┐    FULFILLED_BY     BILLED_AS     CLEARED_BY
    │ Product  │◄─────────┤               │             │
    └──────────┘    ┌─────▼─────┐   ┌─────┴──────┐     │
                    │ Delivery  │───┘  POSTED_AS  │     │
    ┌──────────┐    └─────┬─────┘  ┌──────▼──────┐     │
    │  Plant   │◄─────────┘        │JournalEntry │─────┘
    └──────────┘                   └─────────────┘
```
