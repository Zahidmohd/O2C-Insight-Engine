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

## Step 3: SQLite Schema Design & Data Loading Strategy

### Prompt

```
Now move to Step 3: SQLite Schema Design and Data Loading Strategy.
1. Define SQLite tables (keep close to source, no merging)
2. Define columns, primary keys, and index strategy (crucial for joins)
3. Handle special cases (billing item padding, composite keys, nulls)
4. Design a Node.js data loading script (JSONL → SQLite)
5. Keep it simple, correct, and query-friendly
Output: CREATE statements, index statements, loading plan.
```

### Response Summary

Designed the SQLite schema and data ingestion strategy, documented in `docs/schema-design.md`.

**Schema Decisions:**
- Created 19 separate table definitions, matching the JSONL structure.
- All columns typed as `TEXT` to preserve SAP identifiers (including leading zeros).
- Defined composite primary keys where required (e.g., `companyCode`, `fiscalYear`, `accountingDocument`).
- Defined 18 critical indexes specifically targeting the validated graph edges (e.g., `referenceSdDocument`).

**Critical Special Case Resolution:**
- **Padding:** Resolved the billing item padding issue by normalizing `billing_document_items.referenceSdDocumentItem` (padding to 6 digits) **during data ingestion**, rather than relying on `printf` at query time.

**Data Loading Strategy:**
- Designed a batch-loading approach (100 rows per batch) wrapping each table's inserts in a single transaction for maximum performance.
- Established a strict loading order to respect referential integrity (Master Data first, then O2C nodes in sequence).
- Designed a `_schema_metadata` table to explicitly provide the LLM with context on which columns connect to which tables.

### Decision

- Created `docs/schema-design.md` with full SQL definitions and the ingestion plan.
- Chose load-time normalization over query-time for the padding issue.

### Reasoning

1. **LLM Friendliness:** Normalizing the billing item padding at load time is a massive simplification for the LLM. It can now generate clean `a.item = b.item` joins without needing to know SAP-specific string formatting quirks. It also allows indexes to work uniformly.
2. **TEXT Data Types:** SAP keys frequently look like numbers (`"740506"`, `"000010"`) but are identifiers where leading zeros are semantic. Storing them as REAL or INTEGER in SQLite causes silent corruption when zeros are stripped.
3. **Indexes:** Added composite indexes specifically for the document reference joins (e.g., `referenceSdDocument`, `referenceSdDocumentItem`) to ensure multi-hop traversal is performant.

---

## Step 4: Database Implementation and Data Loading

### Prompt

```
Now move to Step 4: Database Implementation and Data Loading.
1. Create `src/db/connection.js` (sqlite3, foreign_keys=ON)
2. Create `src/db/init.js` (executes schema.sql)
3. Create `src/db/loader.js` (JSONL to SQLite, batch 100, wrapping table in TX)
4. Enforce mandatory critical transformation on `billing_document_items.referenceSdDocumentItem` (padding to 6 digits)
5. Execute validation queries post-load
No ORMs, raw SQL only.
```

### Response Summary

Implemented the database and loading scripts inside `src/db/`. 

- **connection.js**: Established a basic `sqlite3` connection with `PRAGMA foreign_keys = ON;`, wrapped with Promise helpers for cleaner async handling.
- **init.js**: Loads and executes `schema.sql` (created in Step 3), ensuring tables and indexes are created before loading.
- **loader.js**: Iterates through all 19 JSONL directories matching the strict loading order. Added data transformation for `billing_document_items.referenceSdDocumentItem` exactly as directed: `val.padStart(6, '0')`.
- **Validation**: After inserting ~21,393 rows total, the script ran the validation checks:
  - `paddingCheck`: Confirmed 0 unpadded billing items.
  - `joinCheck`: Multi-hop query `SalesOrder -> Delivery -> Billing -> Journal` successfully returned **181 rows**, validating the padded join keys and the SQL from the dataset-analysis phase.

### Decision

- Wrote the data ingestion layer specifically as batch insertions within a single SQLite text transaction `BEGIN TRANSACTION ... COMMIT` per table to dramatically speed up inserts.
- Kept the padding transformation localized to the single configuration object for `billing_document_items` in `loader.js`.

### Reasoning

1. **Transaction Wrapping:** `sqlite3` goes from minutes to milliseconds when processing thousands of sequential `INSERT` statements inside a `BEGIN / COMMIT` boundary, avoiding the disk fsync per row.
2. **Data Integrity Validations:** Emitting a pass/fail natively at the end of the script builds immediate trust that the schema definition and load strategies correctly harmonize with the data payload structure.

---

## Next Steps

**Step 5:** Search Architecture & LLM Query Prompt Design
**Step 6:** API Server implementation
**Step 7:** Evaluation

---
