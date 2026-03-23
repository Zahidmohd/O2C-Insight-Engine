# AI Session Log — Graph-Based Data Modeling & Query System

> **Project:** SAP Order-to-Cash Graph Query System
> **Started:** 2026-03-23
> **AI Tool:** Antigravity (Google DeepMind)

---

## Step 1: Dataset Deep Analysis

### Prompt

```
Analyze the dataset tables I provide. Identify columns, keys, and reference fields.
Map exact join conditions across: sales_order → delivery → billing → journal → payment.
Validate joins with example SQL queries.
```

### Response Summary

Performed exhaustive analysis of all 19 tables in the SAP O2C dataset:

**Table Inventory (19 tables, JSONL format):**

| Category | Table | Rows |
|----------|-------|------|
| Core O2C | sales_order_headers | 100 |
| Core O2C | sales_order_items | 167 |
| Core O2C | sales_order_schedule_lines | 179 |
| Core O2C | outbound_delivery_headers | 86 |
| Core O2C | outbound_delivery_items | 137 |
| Core O2C | billing_document_headers | 163 |
| Core O2C | billing_document_items | 245 |
| Core O2C | billing_document_cancellations | 80 |
| Core O2C | journal_entry_items_accounts_receivable | 123 |
| Core O2C | payments_accounts_receivable | 120 |
| Master | business_partners | 8 |
| Master | business_partner_addresses | 8 |
| Master | customer_company_assignments | 8 |
| Master | customer_sales_area_assignments | 28 |
| Master | products | 69 |
| Master | product_descriptions | 69 |
| Master | product_plants | ~2800+ |
| Master | product_storage_locations | ~2500+ |
| Master | plants | 44 |

**Key findings:**
1. All column names, types, and sample values extracted for every table
2. Primary keys identified (explicit or composite)
3. Foreign key relationships mapped using SAP naming conventions
4. Cross-document reference fields identified (`referenceSdDocument`, `referenceSdDocumentItem`)

**Validated Join Chain:**
```
sales_order_headers.salesOrder
  → outbound_delivery_items.referenceSdDocument (VALIDATED: format match)
    → billing_document_items.referenceSdDocument = deliveryDocument (VALIDATED: 10/10)
      → billing_document_headers.accountingDocument = journal.accountingDocument (VALIDATED: 5/5)
        → journal.clearingAccountingDocument ↔ payments (VALIDATED: 56 bidirectional)
```

**Critical Discovery — Item Number Format Mismatch:**
- `billing_document_items.referenceSdDocumentItem` = `"10"` (unpadded)
- `outbound_delivery_items.deliveryDocumentItem` = `"000010"` (zero-padded)
- **0/245 direct string matches, 245/245 padded matches**
- Fix: Use `printf('%06d', CAST(referenceSdDocumentItem AS INTEGER))` in SQL

### Decision

- Documented complete schema for all 19 tables in `docs/dataset-analysis.md`
- Mapped 8 join conditions with exact SQL syntax
- Identified and confirmed the item number padding issue
- Classified joins as direct, cross-document, and ambiguous
- Provided a full O2C multi-hop SQL query example

### Reasoning

1. **Analyzed data BEFORE code** — as required by the mandatory workflow
2. **Validated every join with real data** — not assumptions based on column names
3. **Caught a production-breaking bug early** — the item number format mismatch would cause zero results in billing↔delivery joins if not handled
4. **Documented nullable fields** in payments table (`invoiceReference`, `salesDocument`) that should NOT be used as primary join keys despite looking relevant
5. **Used SAP domain knowledge** — recognized `referenceSdDocument` pattern as SAP's standard cross-document reference convention, and the clearing mechanism for journal↔payment linkage

---

## Step 2: Graph Model Design

### Prompt

```
Using the validated join paths from dataset-analysis.md:
1. Define graph nodes (business-level, NOT table-level)
2. Define graph edges with source, target, join logic
3. Abstract away SAP complexity (item-level joins internal, graph exposes clean relationships)
4. Provide Node → tables and Edge → SQL mappings
5. Highlight special cases (item-level joins, billing item padding)
6. Example traversal: SalesOrder → Delivery → Billing → Payment
7. Use ONLY validated joins from dataset-analysis.md
```

### Response Summary

Designed a complete graph model with **8 node types** and **12 edge types**.

**Nodes (business-level abstractions):**

| Node | Tables Merged | ID |
|------|--------------|-----|
| SalesOrder | headers + items + schedule_lines | `salesOrder` |
| Delivery | headers + items | `deliveryDocument` |
| BillingDocument | headers + items + cancellations | `billingDocument` |
| JournalEntry | journal_entry_items_ar | `companyCode/fiscalYear/accountingDocument` |
| Payment | payments_ar | `companyCode/fiscalYear/accountingDocument` |
| Customer | business_partners + addresses + assignments (×2) | `customer` |
| Product | products + descriptions | `product` |
| Plant | plants | `plant` |

**Core O2C Edges (the main chain):**

| Edge | From → To | Granularity | Padding? |
|------|-----------|-------------|----------|
| FULFILLED_BY | SalesOrder → Delivery | Item→Header | No |
| BILLED_AS | Delivery → BillingDocument | Item→Header | **YES** ⚠️ |
| POSTED_AS | BillingDocument → JournalEntry | Header | No |
| CLEARED_BY | JournalEntry → Payment | Header | No |

**Key design decisions:**
- Item-level joins resolved internally, exposed as header-level edges
- Composite IDs for financial nodes (`companyCode/fiscalYear/accountingDocument`)
- Cancellation modeled as self-referencing edge on BillingDocument
- Cytoscape visualization schema included with colors and shapes

### Decision

- Created `docs/graph-model.md` with complete node/edge definitions
- Each node specifies exact table-to-field mapping
- Each edge specifies exact SQL join with padding notes
- Included graph traversal example (both visual and SQL)
- Included Cytoscape visualization schema for frontend

### Reasoning

1. **Business-level abstraction** — Users think "Sales Order", not "sales_order_headers + sales_order_items + sales_order_schedule_lines". The graph hides SAP table complexity.
2. **Item-level joins hidden** — Edges 1 (FULFILLED_BY) and 2 (BILLED_AS) require item-level SQL joins internally, but the graph presents clean header-to-header relationships. This was done with `SELECT DISTINCT` at header level.
3. **Padding issue surfaced at edge level** — Rather than burying the `printf('%06d', ...)` fix deep in code, it's explicitly labeled on Edge 2. Every developer touching this edge will see the warning.
4. **Composite IDs for financial docs** — JournalEntry and Payment use `companyCode/fiscalYear/accountingDocument` because `accountingDocument` alone could theoretically repeat across company codes or fiscal years.
5. **Cancellation as self-edge** — Instead of a separate "Cancellation" node type (which would clutter the graph), cancellations are the same BillingDocument type with a `CANCELS` edge pointing to the original.

---

## Step 2a: Graph Model Refinement — CLEARED_BY Cardinality

### Prompt

```
Refine the CLEARED_BY edge (JournalEntry → Payment):
- Update cardinality from 1:1 to support 1:N, N:1, and N:M in real SAP systems
- Add documentation note about production-readiness
- No SQL join changes, no structural changes
- Documentation + modeling clarity only
Also: STOP auto-committing. Only suggest commits from now on.
```

### Response Summary

Updated the `CLEARED_BY` edge in `docs/graph-model.md`:

**Before:**
- Cardinality: `1:1 (one invoice clearing = one payment matching)`

**After:**
- Cardinality: `N:M (see note below)` with detailed note explaining:
  - 1:N — partial payments against one invoice
  - N:1 — one payment clearing multiple invoices
  - 1:1 — the typical case in our dataset
  - SQL joins use JOIN (not scalar lookups) so they work for all cardinalities

No SQL joins were modified. No structural changes made.

### Decision

- Updated cardinality documentation for `CLEARED_BY` edge only
- Added production-readiness note as a blockquote in the edge definition
- Adopted new workflow rule: **no auto git commands** — only suggest commits

### Reasoning

1. **Real SAP clearing is N:M** — In production SAP systems, one payment can clear multiple invoices (e.g., a customer pays all outstanding invoices in one wire transfer), and one invoice can be partially paid over time. Documenting this prevents a future developer from assuming 1:1 and introducing bugs.
2. **No code changes needed** — Our SQL already uses `JOIN` (not `= (SELECT ...)`), so it inherently supports N:M. This is purely a documentation improvement.
3. **Git discipline** — Manual commits ensure clean, intentional commit history suitable for FDE assignment submission.

---

## Next Steps

**Step 3:** SQLite schema design and data loading
**Step 4:** Join validation with full SQL execution against loaded database
**Step 5:** Architecture design

---
