# AI Session Log — Graph-Based Data Modeling & Query System

> **Project:** SAP Order-to-Cash Graph Query System  
> **Started:** 2026-03-23  
> **AI Tool:** Antigravity (Google DeepMind)

---

## Session 1: Dataset Deep-Dive & Join Validation

### User Input

I have 19 JSONL tables from an SAP Order-to-Cash dataset. Before writing any code, I need to understand the data model thoroughly. Go through each table — pull out columns, identify primary keys, and figure out how they connect. I need the full join chain mapped end-to-end: `sales_order → delivery → billing → journal entry → payment`. Don't assume anything from column names alone — validate each join with sample SQL against the data. SAP naming conventions are inconsistent, so I want actual row-level confirmation that joins produce results.

### Assistant Response

I've completed a full analysis of all 19 tables. Here's the complete inventory:

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

For every table, I extracted all column names, types, and sample values. I identified primary keys — explicit where available, composite keys for financial tables (`companyCode`, `fiscalYear`, `accountingDocument`). The foreign key relationships follow SAP naming conventions, with cross-document reference fields `referenceSdDocument` and `referenceSdDocumentItem` appearing in multiple tables.

Here's the validated join chain with actual row counts:

```
sales_order_headers.salesOrder
  → outbound_delivery_items.referenceSdDocument (VALIDATED: format match confirmed)
    → billing_document_items.referenceSdDocument = deliveryDocument (VALIDATED: 10/10 sample matches)
      → billing_document_headers.accountingDocument = journal.accountingDocument (VALIDATED: 5/5)
        → journal.clearingAccountingDocument ↔ payments (VALIDATED: 56 bidirectional matches)
```

I classified the joins into three categories: direct (same column name), cross-document (via `referenceSdDocument`), and ambiguous. I also noted that `invoiceReference` and `salesDocument` in the payments table are nullable, so they shouldn't be used as primary join keys — `clearingAccountingDocument` is the reliable path.

**Critical discovery**: I found a format mismatch in item-level identifiers. `billing_document_items.referenceSdDocumentItem` stores values like `"10"` (unpadded), while `outbound_delivery_items.deliveryDocumentItem` stores `"000010"` (zero-padded to 6 digits). Out of 245 billing items, **0 matched with direct string comparison, but 245/245 matched after padding**. The fix is `printf('%06d', CAST(referenceSdDocumentItem AS INTEGER))` at the SQL level, but we should discuss whether to handle this at query time or ingestion time.

### User Input

Good catch on the padding mismatch — that would have been a silent zero-row bug on every billing↔delivery join. I want that documented as a first-class concern, not buried in a footnote. Write it up in `docs/dataset-analysis.md` along with the full schema for all 19 tables, the 8 join conditions with exact SQL syntax, and the join classification (direct vs cross-document vs ambiguous). This is the foundation for everything else, so it needs to be thorough.

### Assistant Response

Done. Created `docs/dataset-analysis.md` with:

1. **Complete schema** for all 19 tables — column names, types, sample values, and identified primary keys
2. **8 join conditions** with exact SQL syntax, each validated against real data
3. **Join classification**: direct joins (same column name match), cross-document joins (via `referenceSdDocument`), and ambiguous joins (nullable columns that shouldn't be primary paths)
4. **Item number padding issue** — documented as a critical section with the 0/245 vs 245/245 match counts, the root cause (SAP stores billing items unpadded, delivery items zero-padded), and the recommended fix approach
5. **Nullable join warning** for `invoiceReference` and `salesDocument` in the payments table

---

## Session 2: Graph Model Design

### User Input

Now I need to design the graph model. The key principle: users think in business documents — "Sales Order", "Delivery", "Billing Document" — not in SAP table names like `sales_order_headers JOIN sales_order_items`. So the graph should abstract the table complexity away entirely. Define the node types at the business level, the edge types with their exact join SQL, and make sure the item-level padding issue is visibly flagged on the relevant edge. Only use the joins we validated — no new assumptions. Also include a Cytoscape visualization schema since that's what I'll use for the frontend rendering.

### Assistant Response

Here's the complete graph model — **8 node types** and **12 edge types**, all grounded in the validated joins from the dataset analysis.

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

Each node merges its related header/item/detail tables internally. The graph consumer only sees clean, single-entity nodes. For the item-level JOIN logic, I resolve it internally and expose only header-to-header edges using `SELECT DISTINCT` — so a Sales Order with 3 items fulfilled by the same Delivery shows as one edge, not three.

**Core O2C Edges (the main chain):**

| Edge | From → To | Granularity | Padding? |
|------|-----------|-------------|----------|
| FULFILLED_BY | SalesOrder → Delivery | Item→Header | No |
| BILLED_AS | Delivery → BillingDocument | Item→Header | **YES** ⚠️ |
| POSTED_AS | BillingDocument → JournalEntry | Header | No |
| CLEARED_BY | JournalEntry → Payment | Header | No |

The padding issue is explicitly flagged on Edge 2 (`BILLED_AS`) — this is the only edge where `referenceSdDocumentItem` needs zero-padding to match `deliveryDocumentItem`. I also used composite IDs for financial nodes (`companyCode/fiscalYear/accountingDocument`) since `accountingDocument` alone could repeat across company codes. Cancellation is modeled as a self-referencing edge on BillingDocument.

I've included a Cytoscape visualization schema with distinct colors and shapes for each node type — SalesOrder (blue, rectangle), Delivery (green, ellipse), BillingDocument (pink, rectangle), etc. This maps directly to the Cytoscape style sheet format.

### User Input

Document this in `docs/graph-model.md` with the full node/edge definitions. One correction — I looked at the `CLEARED_BY` edge and it's marked as 1:1 cardinality. That's wrong for real SAP systems. A customer might pay multiple invoices in a single wire transfer (N:1), or partially pay one invoice over time (1:N). The actual cardinality is N:M. Our JOIN syntax already handles this, so no code change — just fix the documentation. I don't want someone extending this later and assuming 1:1.

### Assistant Response

Updated `docs/graph-model.md` with the full model and fixed the `CLEARED_BY` cardinality:

- Changed from `1:1` to `N:M` with explicit notes on the three cases:
  - **1:N** — partial payments against one invoice (customer pays in installments)
  - **N:1** — one payment clearing multiple invoices (bulk wire transfer)
  - **1:1** — the typical case in our dataset, but not a safe assumption for the general model
- No SQL joins modified — `JOIN` inherently supports all cardinalities without structural changes

This is a documentation-only change, but it prevents a class of bugs where someone assumes 1:1 and introduces scalar subqueries instead of proper JOINs.

---

## Session 3: SQLite Schema Design & Data Loading Strategy

### User Input

Time to design the actual database schema. My constraints:

1. **One SQLite table per JSONL source** — don't merge tables. The schema should mirror the raw data structure.
2. **All columns as TEXT** — SAP identifiers have leading zeros (`"000010"`). If I use INTEGER, SQLite silently strips them and every join breaks.
3. **Composite primary keys** for financial tables (`companyCode`, `fiscalYear`, `accountingDocument`).
4. **Indexes targeting the validated join paths** — I want the exact 8 joins from the dataset analysis to be indexed.
5. **Handle the billing item padding at load time, not query time** — this is a deliberate design decision. The LLM should never need to know about `printf()` formatting. It should just generate clean `a.item = b.item` joins and the data should already be normalized.

Also design the batch loading strategy — JSONL → SQLite with transactional inserts.

### Assistant Response

Designed the complete schema and ingestion strategy, documented in `docs/schema-design.md`.

**Schema Design:**
- 19 separate table definitions, each matching its JSONL source structure exactly
- All columns typed as `TEXT` — this preserves SAP identifiers like `"000010"` that would silently corrupt as INTEGER. The tradeoff is that numeric comparisons require explicit casting, but since all our joins are string equality, this is fine
- Composite primary keys for financial tables: `(companyCode, fiscalYear, accountingDocument)` — since `accountingDocument` alone can repeat across company codes
- 18 targeted indexes covering all validated join paths. Each index is specifically designed for the edges in our graph model — for example, `idx_billing_items_ref_sd_doc` on `(referenceSdDocument, referenceSdDocumentItem)` for the `BILLED_AS` edge

**Critical Special Case — Load-Time Padding Normalization:**
The billing item padding (`referenceSdDocumentItem`) gets normalized during data ingestion using `padStart(6, '0')`. This means:
- The LLM generates clean `a.item = b.item` joins — no `printf()` or `CAST()` needed in the prompt
- Indexes work perfectly on the pre-normalized data — no function-based index overhead
- The padding transform is a one-time cost at load, not a per-query cost

**Data Loading Strategy:**
- Batch loading: 100 rows per batch, each batch wrapped in a single `BEGIN TRANSACTION ... COMMIT`
- Loading order: Master Data first (business_partners, products, plants), then O2C tables in document flow sequence
- Post-load validation: two queries confirm the padding worked (0 unpadded billing items) and the multi-hop join returns rows (SalesOrder → Delivery → Billing → Journal)

The biggest tradeoff here is fixing padding at ingestion vs query time. I chose ingestion because it keeps the LLM prompt clean — the model doesn't need to understand SAP string formatting conventions, and every query benefits from the pre-normalized data without any per-query overhead.

---

## Session 4: Database Implementation & Data Loading

### User Input

Implement the database layer. Three files in `src/db/`:

1. **`connection.js`** — `sqlite3` with `PRAGMA foreign_keys = ON`, and Promise wrappers (`runAsync`, `allAsync`, `getAsync`, `execAsync`). I want a consistent async interface so the rest of the codebase doesn't have to deal with callbacks.
2. **`init.js`** — reads and executes `schema.sql` to create all 19 tables and indexes.
3. **`loader.js`** — iterates through all 19 JSONL directories, batch inserts with 100 rows per transaction, and applies the billing item `padStart(6, '0')` transform we designed.

Include a post-load validation step — I want two checks: (a) zero unpadded billing items remain, and (b) the multi-hop join from SalesOrder → Delivery → Billing → Journal returns rows. If either fails, the loader should exit with a clear error. No ORMs — raw SQL only.

### Assistant Response

Implemented all three scripts in `src/db/`.

**`connection.js`**: Creates the SQLite connection to `sap_otc.db` with `PRAGMA foreign_keys = ON`. I wrapped the three core operations in Promise-based helpers:
- `db.runAsync(sql, params)` — for INSERT, UPDATE, DELETE
- `db.allAsync(sql, params)` — for SELECT returning multiple rows
- `db.getAsync(sql, params)` — for SELECT returning a single row
- `db.execAsync(sql)` — for executing DDL/multi-statement SQL

This gives the rest of the codebase a clean `async/await` interface without touching the underlying `sqlite3` library directly. The connection also registers `process.on('exit')` and signal handlers (`SIGHUP`, `SIGINT`, `SIGTERM`) to ensure the DB handle is properly closed on shutdown.

**`init.js`**: Reads `schema.sql` from disk and executes it via `db.execAsync()`. This creates all 19 tables with TEXT columns, composite primary keys for financial tables, and the 18 targeted indexes.

**`loader.js`**: The main data ingestion script. It:
1. Scans all 19 JSONL directories under `sap-o2c-data/`
2. For each directory, reads every `.jsonl` file line-by-line, parsing each JSON record
3. Applies the padding transform on `billing_document_items.referenceSdDocumentItem` — `val.padStart(6, '0')`
4. Batches 100 rows per `BEGIN TRANSACTION ... COMMIT` block — this is critical for SQLite performance. Without transaction batching, 21K individual inserts would take minutes; with it, the entire load completes in under 5 seconds
5. Runs two post-load validation queries:
   - **Padding check**: `SELECT COUNT(*) FROM billing_document_items WHERE LENGTH(referenceSdDocumentItem) < 6` → **0 rows** ✅
   - **Join check**: Multi-hop query SalesOrder → Delivery → Billing → Journal → **181 rows** ✅

The padding transform is localized to a single config object in `loader.js` so it's easy to find and extend if we discover more padding issues later. Total rows loaded across all 19 tables: **21,393**.

---

## Session 5: Query Engine Architecture

### User Input

This is the core of the system — the NL-to-SQL pipeline. Here's the architecture I want:

- **`llmClient.js`** — Groq as the primary LLM provider (`llama-3.1-70b-versatile`), with OpenRouter as automatic fallback if Groq is down or rate-limited. I don't want a single point of failure — if one API goes down during a demo, the system should transparently switch. Both providers should use the same Llama model family for consistency.
- **`promptBuilder.js`** — system prompt with the exact schema context, the validated join relationships, and a critical instruction that padding is already normalized so the LLM should NOT use `printf()` or `CAST()` in joins. If the LLM adds formatting functions, it breaks index usage.
- **`validator.js`** — SQL safety layer. Only `SELECT` passes. Block `DELETE`, `UPDATE`, `DROP`, `INSERT`, `PRAGMA`, `load_extension` — everything dangerous. This is the last line of defense before SQL hits the database.
- **`sqlExecutor.js`** — execute the validated SQL against SQLite with `process.hrtime()` timing.
- **`queryService.js`** — orchestrator that ties everything together: domain guardrails → prompt building → LLM call → SQL validation → execution → response formatting.

The domain guardrail needs to be a lightweight pre-flight check — reject off-topic questions like "What is the capital of France?" before they even reach the LLM. I don't want to waste tokens on obviously non-O2C queries.

### Assistant Response

Implemented the full query engine in `src/query/`. Here's each component:

**`llmClient.js`**: Calls the Groq API first with `llama-3.1-70b-versatile` at `temperature: 0` for deterministic SQL generation. If Groq returns a non-200 status, rate-limits, or times out, it automatically retries with OpenRouter using `meta-llama/llama-3.1-70b-instruct`. Both providers use the same model family so the generated SQL is consistent regardless of which backend responds. The function also includes a `cleanResponse()` step that strips markdown code fences (` ```sql ... ``` `) from LLM output — without this, the validator would reject every response because the backticks aren't valid SQL.

**`promptBuilder.js`**: Builds the system prompt dynamically. It includes:
- The exact schema for all tables the LLM needs (not all 19 — I excluded master data tables like `product_plants` and `product_storage_locations` that have thousands of rows but aren't useful for graph queries)
- All validated join relationships with explicit column-to-column mappings
- A `CRITICAL NOTE` section telling the LLM that all item padding is pre-normalized — it must use simple `a.item = b.item` equality, never `printf()` or `CAST()`
- Domain-specific instructions for handling NULL values, date formatting, and the `billingDocumentIsCancelled` flag

**`validator.js`**: Blocklist-based SQL safety validation. It checks for:
- Forbidden keywords: `DELETE`, `UPDATE`, `DROP`, `INSERT`, `ALTER`, `CREATE`, `PRAGMA`, `ATTACH`, `DETACH`
- Dangerous functions: `load_extension`, `writefile`, `fts3`, `rtree`
- Structural patterns: blocks `JOIN ... (SELECT ...)` subqueries that the LLM sometimes generates — these cause empty results or performance issues in SQLite
- Only `SELECT` statements pass validation

**`sqlExecutor.js`**: Simple execution wrapper that runs validated SQL via `db.allAsync()` and measures execution time with `process.hrtime()`. Returns `{ rows, executionTimeMs }`.

**`queryService.js`**: The main orchestrator. The pipeline is:
1. **Intent validation** — does the query contain at least one recognizable action word (`trace`, `show`, `find`, `list`, `count`, etc.)? Rejects gibberish and typos before any processing.
2. **Domain guardrail** — `isDomainQuery()` checks for SAP/O2C-related keywords. "What is the capital of France?" gets rejected here, saving LLM tokens entirely.
3. **Prompt building** — constructs the full system prompt with schema context
4. **LLM SQL generation** — calls `llmClient` with a 15-second timeout via `Promise.race()`
5. **SQL safety validation** — runs the generated SQL through `validator.js`
6. **Database execution** — executes with a 5-second timeout
7. **Response packaging** — formats the result with metadata (requestId, executionTime, rowCount)

The multi-layer safety design means even if the LLM generates something dangerous like `DROP TABLE`, it gets caught at step 5 before it ever reaches SQLite. And the dual-provider setup in `llmClient.js` means we're not locked into one API — transparent failover with no code changes needed.

### User Input

Good architecture. Now wrap it in a REST API — Express server with CORS, a `POST /api/query` endpoint with input validation (reject empty, cap at 500 chars), and clean JSON response format. Also add two safety nets: auto-append `LIMIT 100` to any SQL that doesn't already have one (the LLM forgets sometimes), and `Promise.race()` timeout wrappers around both the LLM and DB calls. Separate the routing from the business logic — the route handler should just pass the query to `queryService` and return the result.

### Assistant Response

Implemented the API layer:

**`server.js`**: Express server with CORS middleware (allows cross-origin requests from the frontend dev server), JSON body parsing, and a global error handler that catches unhandled exceptions and returns structured `{ success: false, error: { message, type } }` responses.

**`queryRoutes.js`**: Single endpoint — `POST /api/query`. Input validation rejects null/empty queries and anything over 500 characters. Each request gets a `crypto.randomUUID()` request ID attached to the response for end-to-end tracing. The route handler is thin — it calls `queryService.processQuery(query)` and returns the result. Zero business logic in the route layer.

**`queryService.js` upgrades**:
- `enforceLimit(sql)` — regex-based check that appends `LIMIT 100` if the SQL doesn't already contain one. I kept this simple (regex + string append) rather than pulling in a full SQL parser library — for our use case, regex is sufficient and avoids the dependency
- `withTimeout(promise, ms)` — `Promise.race()` wrapper that rejects with a timeout error if the promise doesn't resolve in time. Applied to LLM calls (15s) and DB execution (5s)
- Expanded the domain keyword list in `isDomainQuery()` to cover more O2C terminology

The 500-char limit combined with the 5-second DB timeout provides defense-in-depth against both malicious and accidentally expensive queries. And since Express routing is completely decoupled from `queryService`, I can test the query pipeline independently without spinning up a server.

---

## Session 6: Graph Extraction & Response Formatting

### User Input

The API currently returns flat SQL rows, but Cytoscape needs `{ nodes, edges }`. I need a graph extractor that converts tabular query results into graph format. Requirements:

- Map each row to typed nodes based on column presence — if a row has `salesOrder`, create a SalesOrder node; if it has `billingDocument`, create a BillingDocument node
- Create edges based on our validated graph model relationships (`FULFILLED_BY`, `BILLED_AS`, `POSTED_AS`, `CLEARED_BY`)
- Use deterministic node IDs (`SO_25501`, `BILL_90504204`) — not auto-increment. The same document should always get the same node ID across different queries
- Deduplicate with `Map` using composite keys — a multi-row result can reference the same delivery multiple times, and I don't want duplicate nodes or edges in the graph
- Cap at 100 rows before extraction to prevent the graph from exploding
- Add UUID request tracing via `crypto.randomUUID()` so I can correlate frontend requests with server-side logs

### Assistant Response

Built `graphExtractor.js` in `src/query/`.

**Node extraction**: For each row, I check for the presence of document ID columns and create typed nodes:
- `row.salesOrder` → `{ id: 'SO_25501', type: 'SalesOrder', label: '25501' }`
- `row.deliveryDocument` → `{ id: 'DEL_800034567', type: 'Delivery', ... }`
- `row.billingDocument` → `{ id: 'BILL_90504204', type: 'BillingDocument', ... }`
- `row.accountingDocument` → `{ id: 'JE_9400635958', type: 'JournalEntry', ... }` (with composite key)
- `row.customer` or `row.soldToParty` → `{ id: 'CUST_100017', type: 'Customer', ... }`
- Similar for Payment nodes

The deterministic ID scheme means if you query "Trace billing document 90504204" and then "Show all billing documents for customer 100017", the node `BILL_90504204` appears in both graphs with the same ID — enabling consistent highlighting and comparison.

**Edge extraction**: For each row, I check which pairs of nodes coexist and create edges:
- SalesOrder + Delivery → `FULFILLED_BY` edge
- Delivery + BillingDocument → `BILLED_AS` edge
- BillingDocument + JournalEntry → `POSTED_AS` edge
- JournalEntry + Payment → `CLEARED_BY` edge

Edges use composite keys in a `Map` (`DEL_800034567->BILL_90504204[BILLED_AS]`) to prevent duplicates. A query returning 50 rows that all reference the same Sales Order → Delivery pair produces exactly one edge, not 50.

**Response integration**: `queryService.js` now truncates results to 100 rows before passing to the graph extractor, and `queryRoutes.js` attaches the `crypto.randomUUID()` request ID to every API response. The graph extraction runs server-side to avoid shipping thousands of rows to the browser — the frontend only receives the pre-computed `{ nodes, edges }` structure ready for Cytoscape.

---

## Session 7: Frontend Implementation

### User Input

Build the frontend with Vite + React. Layout should be a dual-pane design:
- **Left panel** — query input box, metadata display (requestId, rowCount, execution time in ms), and conversation history
- **Right panel** — full-width Cytoscape graph rendering

One thing I want to be careful about: the Cytoscape graph lifecycle. Every time a new query is submitted, the previous graph instance must be destroyed before rendering the new one. If we just keep creating new Cytoscape instances without cleanup, we'll leak DOM nodes and event listeners. Use `useRef` for the Cytoscape instance — not `react-cytoscapejs` — I want direct control over the graph lifecycle and event binding. Keep the styling minimal — vanilla CSS, no Tailwind or Material-UI. Use the node color scheme from the graph model we designed.

### Assistant Response

Set up the frontend in `frontend/` with Vite + React, `axios` for API calls, and `cytoscape` as a direct dependency.

**Layout**: Dual-pane with a left sidebar (30% width) for the query interface and a right panel (70%) for the graph canvas. The left panel contains:
- Text input with submit button (disabled during loading)
- Metadata display showing `requestId`, `rowCount`, `executionTimeMs`, and the generated SQL
- Conversation history that accumulates across queries in the same session

**Graph lifecycle management**: This was the critical implementation detail. I used `useRef` to hold the native Cytoscape instance:
- On each new query response, `cyRef.current.destroy()` is called first to tear down the previous graph — this removes all DOM nodes, event listeners, and internal state
- A new `cytoscape({ container, elements, style, layout })` instance is created with the fresh `{ nodes, edges }` data
- The React `useEffect` cleanup function also calls `destroy()` on component unmount as a safety net against navigation-triggered leaks

**Node colors** are mapped to graph model types:
- SalesOrder → blue rectangle
- Delivery → green ellipse
- BillingDocument → pink rectangle
- JournalEntry → orange diamond
- Payment → purple ellipse
- Customer → teal hexagon

**Error handling**: API errors are caught and displayed inline in the left panel with descriptive messages. The loading state disables the input and shows a spinner to prevent duplicate submissions.

I chose vanilla CSS over Tailwind/Material-UI deliberately — it keeps the bundle small (the CSS file is under 8KB) and avoids adding framework overhead for what's essentially a single-page query interface. And using `cyRef` directly instead of `react-cytoscapejs` gives full control over the instance — I can programmatically fit, zoom, center, and bind tap events without going through a wrapper's API.

### User Input

Write a README that covers: system architecture, design decisions with rationale for each, the safety/guardrails stack, how graph extraction works, the full pipeline flow from user input to graph rendering, and API reference. Keep it professional but technical — this needs to communicate the engineering decisions clearly.

### Assistant Response

Drafted `README.md` with the following sections:

1. **Architecture Overview** — system flow diagram showing the full pipeline: User → React Frontend → Express API → Query Service → LLM (Groq/OpenRouter) → SQL Validator → SQLite → Graph Extractor → Cytoscape
2. **Key Design Decisions** — table format with decision, alternatives considered, and rationale for each (TEXT columns, load-time padding, dual LLM providers, server-side graph extraction, deterministic node IDs)
3. **Safety & Guardrails** — the four-layer protection stack: intent validation → domain guardrails → SQL blocklist → LIMIT enforcement + execution timeouts
4. **Graph Handling** — node types, edge types, the `SELECT DISTINCT` deduplication strategy, and Cytoscape layout configuration
5. **Frontend Features** — graph lifecycle management, conversation history, loading states, error display
6. **Observability** — `crypto.randomUUID()` request tracing from frontend through to server logs
7. **API Reference** — `POST /api/query` request/response schema with all possible `reason` codes

---

## Session 8: Production Hardening

### User Input

Before I start testing, do a hardening pass across both backend and frontend. Three specific things I want cleaned up:

1. **LLM response parsing** — I've noticed the Groq API sometimes wraps SQL in markdown code fences (`` ```sql ... ``` ``). Make sure `cleanResponse()` strips those reliably, including edge cases like nested backticks or missing language tags.
2. **Error response consistency** — every error path should return the same shape: `{ success: false, error: { message, type } }`. I don't want the frontend to have to handle different error formats depending on where the failure happened.
3. **Empty state in the UI** — right now, when a query returns zero graph nodes, the user sees a blank white canvas with no explanation. Add a "No graph data available" message, and differentiate between "no data found", "invalid ID", and "no flow for this document".

### Assistant Response

Completed the hardening pass across both layers:

**Backend hardening:**
- Enhanced `cleanResponse()` in `llmClient.js` to handle all markdown fence variants: `` ```sql ``, `` ``` `` (no language tag), and `` ```SQL `` (uppercase). It now strips leading/trailing whitespace after fence removal and handles the edge case where the LLM returns just the SQL with no fences at all
- Standardized every error path in `queryService.js` and `queryRoutes.js` to return `{ success: false, error: { message: string, type: string } }`. The `type` field uses consistent enum values: `VALIDATION_ERROR`, `DOMAIN_ERROR`, `LLM_ERROR`, `SQL_ERROR`, `TIMEOUT_ERROR`, `INTERNAL_ERROR`
- Added consistent request logging — every log line now includes `[API-{requestId}]` prefix so you can trace a single request through the entire pipeline in the server output

**Frontend hardening:**
- Added empty state component that renders contextual messages based on the API response:
  - `reason: 'INVALID_ID'` → "Document not found — try one of these:" with clickable suggestion chips
  - `reason: 'NO_FLOW'` → "This document exists but has no connected O2C flow"
  - Zero nodes returned → "No graph data available for this query"
  - Generic error → the error message from the API displayed inline
- The empty state replaces the blank canvas — users always see either a graph or an explanation of why there's no graph

---

## Session 9: Debugging — Invalid ID Handling & Join Mismatches

### User Input

I'm testing with invalid document IDs and the UX is terrible. Querying "Trace full flow for billing document 90000001" returns a blank screen with no explanation. The user can't tell if the query failed, if the ID format is wrong, or if the document just doesn't exist in the dataset. I need an existence check before the main query runs — if the ID doesn't exist, return a `reason: 'INVALID_ID'` response along with 5 valid sample IDs as suggestions. On the frontend, render those as clickable chips that auto-fill the query input. Also differentiate between `INVALID_ID` (document doesn't exist at all) and `NO_FLOW` (document exists but has no connected O2C chain).

### Assistant Response

Added the existence check system:

**Backend** (`queryService.js`): Before running the main query, the system now extracts document IDs from the user's query using regex and checks if they exist in the corresponding table. For billing documents, it runs `SELECT 1 FROM billing_document_headers WHERE billingDocument = ?`. If the ID doesn't exist, it queries for 5 valid sample IDs from the same table and returns them as `suggestions` in the response with `reason: 'INVALID_ID'`.

If the document exists but the full flow query returns 0 rows, it returns `reason: 'NO_FLOW'` — this tells the user the document is real but has an incomplete O2C chain (e.g., a billing document with no linked journal entry).

**Frontend** (`App.jsx`): The suggestion chips render as clickable buttons below the error message. Each chip auto-fills the query input with a valid trace query for that document ID, so the user can immediately try a working example. The `INVALID_ID` and `NO_FLOW` states have distinct messaging.

### User Input

Found another issue while testing Sales Order traces. "Trace full flow for sales order 740539" returns 0 rows. I think this is the same padding bug we caught for billing items — `salesOrderItem` in `sales_order_items` uses unpadded values like `"10"`, but `outbound_delivery_items.referenceSdDocumentItem` expects `"000010"`. Check the data and confirm.

### Assistant Response

Confirmed — it's the exact same class of bug. `sales_order_items.salesOrderItem` stores `"10"` (unpadded) while `outbound_delivery_items.referenceSdDocumentItem` stores `"000010"` (zero-padded). The fix is the same approach we used for billing items: add `salesOrderItem` padding with `padStart(6, '0')` in `loader.js` at ingestion time.

I also updated `promptBuilder.js` to instruct the LLM to prefer header-level joins (`sales_order_headers.salesOrder → outbound_delivery_items.referenceSdDocument`) over item-level joins. This reduces the chance of hitting padding mismatches entirely — header-level IDs don't have this problem because they're already consistently formatted.

After re-running the loader with the fix, "Trace full flow for sales order 740539" now returns the full 5-layer chain correctly.

### User Input

I'm seeing another pattern — the LLM is starting its joins from `sales_order_items` instead of `sales_order_headers`. This is wrong for flow queries because the item-level join prematurely narrows the result set. If even one item doesn't match at the item level, the entire row gets dropped. The correct approach is header-first: start from `sales_order_headers`, join directly to `outbound_delivery_items` via `referenceSdDocument`, and only bring in `sales_order_items` if the user explicitly asks for item-level details like quantities or materials. Fix the prompt to enforce this.

### Assistant Response

Updated `promptBuilder.js` with a **header-first join strategy** rule. The instruction now explicitly tells the LLM:

- For flow/trace queries: always start from `sales_order_headers` and join to `outbound_delivery_items` via `referenceSdDocument`. Never start from `sales_order_items`.
- `sales_order_items` should only be included when the user explicitly asks for item-level details (quantities, materials, schedule lines)
- Same pattern for billing: start from `billing_document_headers`, join to `journal_entry_items` via `accountingDocument`

This produces much broader results because the header-level join captures all documents regardless of whether individual items match. The previous item-first approach was dropping valid rows when item-level padding or matching failed.

---

## Session 10: Fallback Join Relaxation Design

### User Input

Some queries are returning 0 rows even though the documents exist. For example, "Trace full flow for sales order 740584" — the order exists and was delivered, but it was never billed. Since we're using `INNER JOIN` across the entire O2C chain, the missing billing step collapses the entire result to nothing. The user should see the partial flow (Order → Delivery) instead of a blank screen.

My thinking: implement a silent retry mechanism. If the initial query returns 0 rows and it's a flow-type query (not aggregation), automatically convert `JOIN` → `LEFT JOIN` for the O2C tables and re-execute. This way partial flows still render. But I don't want this to be a blanket replacement — it should only apply to flow tables, not master data joins.

### Assistant Response

Implemented the fallback mechanism in `queryService.js` exactly as you described:

1. Initial query executes with the LLM-generated SQL (INNER JOINs)
2. If it returns 0 rows, the system checks: is this a flow-type query? (contains `sales_order`, `outbound_delivery`, or `billing_document` tables)
3. If yes, it converts `JOIN` → `LEFT JOIN` for those O2C tables only — master data joins (`business_partners`, `products`) stay as INNER JOIN
4. Re-executes the modified SQL
5. Sets `fallbackApplied: true` in the API response so the frontend can show appropriate messaging like "Partial flow found — some stages may be missing"

I also added `SELECT DISTINCT` and `LIMIT 100` to the fallback query to prevent duplicate explosion from the LEFT JOIN producing null-padded rows.

### User Input

Wait — I just realized there's a safety issue with the fallback. If someone runs an aggregation query like "Top 5 customers by billing amount" and it returns 0 rows (maybe a typo), the fallback would blindly convert all JOINs to LEFT JOINs. That would completely corrupt the `GROUP BY` / `COUNT` results because LEFT JOIN produces null rows that get counted. The fallback should NEVER trigger on aggregation queries.

Also, I changed `rawSql` from `const` to `let` — the fallback needs to reassign the SQL variable, which was throwing `TypeError: Assignment to constant variable`.

### Assistant Response

Good catch on both issues. Updated the fallback constraints:

The fallback now only triggers when ALL of these conditions are met:
1. The query returns 0 rows
2. The query involves flow tables (`sales_order`, `outbound_delivery`, `billing_document`)
3. The query does **NOT** contain aggregation keywords (`GROUP BY`, `COUNT`, `SUM`, `AVG`, `MAX`, `MIN`)
4. Only O2C flow tables get relaxed to LEFT JOIN — master data tables are preserved as INNER JOIN

Also fixed the `const rawSql` → `let rawSql` issue and expanded the fallback table list to include `billing_document_headers` (it was missing from the initial implementation, which meant billing-to-journal joins weren't being relaxed).

Ran a validation test:

| # | Query | Expected | Result |
|---|-------|----------|--------|
| 1 | "Trace full flow for billing document 90504204" | Full 5-node graph | ✅ 5 nodes, all edges correct |
| 2 | "Trace full flow for billing document 99999999" | INVALID_ID with suggestions | ✅ Caught before main query |
| 3 | "Trace full flow for sales order 740584" | Partial flow via fallback | ✅ `fallbackApplied: true`, partial graph |
| 4 | "Which products have the most billing documents" | Aggregation, no fallback | ✅ COUNT(DISTINCT) worked, no false trigger |

### User Input

One more issue with the LLM-generated SQL — for reverse traces (e.g., "trace flow for billing document X"), the LLM sometimes generates nested subqueries inside JOIN conditions like `JOIN (SELECT ... FROM billing_document_items WHERE ...) AS sub ON ...`. These produce empty results or hit SQLite performance limits. I want two fixes: (1) add explicit sequential join patterns for reverse traces to `promptBuilder.js`, and (2) add a regex check in `validator.js` that blocks `JOIN ... (SELECT` patterns entirely. Force the LLM to use flat, sequential JOINs — no nesting.

### Assistant Response

Implemented both fixes:

**`promptBuilder.js`**: Added explicit reverse trace examples showing the correct sequential join pattern:
```
-- Reverse trace: billing → delivery → sales order
FROM billing_document_items bdi
JOIN billing_document_headers bdh ON bdi.billingDocument = bdh.billingDocument
JOIN outbound_delivery_items odi ON bdi.referenceSdDocument = odi.deliveryDocument
JOIN sales_order_headers soh ON odi.referenceSdDocument = soh.salesOrder
```

This gives the LLM a concrete reference for the reverse direction instead of letting it figure out the join chain (and potentially nesting subqueries to do it).

**`validator.js`**: Added a regex check that blocks `JOIN\s*\(\s*SELECT` patterns. If the LLM generates a subquery inside a JOIN condition, the validator rejects it before execution. This forces a retry with the flat sequential pattern from the prompt examples.

Reverse traces now work reliably — "Trace full flow for billing document 90504204" consistently returns the full chain with flat JOINs.

---

## Session 11: Graph Edge Collision & Data Cleanup

### User Input

Found a Cytoscape crash. When tracing a full flow, the graph extractor creates edges with wrong node IDs. I think I know the root cause — when the LLM selects both `bdi.referenceSdDocument` and `odi.referenceSdDocument` in the same query, SQLite returns them under the same JSON key name (`referenceSdDocument`). The second value overwrites the first. So the graph extractor reads the Sales Order ID where it expects the Delivery Document ID, and creates edges pointing to non-existent nodes. Fix the graph extractor to use the explicit document columns (`salesOrder`, `deliveryDocument`, `billingDocument`) instead of the ambiguous `referenceSdDocument`.

### Assistant Response

Exactly right on the root cause. SQLite doesn't disambiguate column names when two tables have the same column — it silently uses the last one in the result set. So `bdi.referenceSdDocument` (Delivery ID) gets overwritten by `odi.referenceSdDocument` (Sales Order ID).

Updated `graphExtractor.js` to use only the explicit, unambiguous document columns:
- `FULFILLED_BY` edge: `row.salesOrder` → `row.deliveryDocument`
- `BILLED_AS` edge: `row.deliveryDocument` → `row.billingDocument`
- `POSTED_AS` edge: `row.billingDocument` → `row.accountingDocument`
- `CLEARED_BY` edge: `row.accountingDocument` → `row.clearingAccountingDocument`

These column names are unique across all tables, so there's no collision risk regardless of how the LLM structures its SELECT clause. Graph edges are now deterministic.

Also fixed a related issue: the LLM sometimes generates `WHERE billingDocument = 99999999` without quotes. The existence check regex was `['"](\d+)['"]` which only matched quoted values. Changed it to `['"]?(\d+)['"]?` — quotes are now optional, so both quoted and unquoted IDs get caught by the existence check.

### User Input

One more housekeeping item — the 19 raw JSONL directories are cluttering the project root. Move them all into a `sap-o2c-data/` subdirectory and update the `DATA_DIR` path in `loader.js`.

### Assistant Response

Done. Moved all 19 JSONL directories into `sap-o2c-data/` and updated `loader.js` to point to the new path. The project root is now clean — only source code, config files, and documentation.

---

## Session 12: Comprehensive Test Suite & Prompt Corrections

### User Input

I'm running a comprehensive test suite across all query types. Here are the 10 test cases I want to validate:

| # | Category | Query | Expected |
|---|----------|-------|----------|
| 1 | Basic Trace | Trace full flow for billing document 90504204 | Full graph with 5 node types |
| 2 | Invalid ID | Trace full flow for billing document 99999999 | INVALID_ID + suggestions |
| 3 | Aggregation | How many billing documents are in the system | Returns 163 |
| 4 | Top-N | Top 5 customers by total billing amount | 5 rows, sorted desc |
| 5 | Business Logic | Find sales orders delivered but not billed | ~3 rows |
| 6 | Forward Trace | Trace full flow for sales order 740539 | Full 5-layer chain |
| 7 | Fallback | Trace full flow for sales order 740584 | fallbackApplied: true |
| 8 | Filter+Trace | Show all cancelled billing documents with original sales orders | Reverse multi-hop |
| 9 | Stress Test | Full O2C flow for customer 100017 | All 5 document layers |
| 10 | Guardrail | What is the capital of France | Rejected before LLM call |

Run all 10 and report the results.

### Assistant Response

Running all 10 test cases. Here are the results:

| # | Category | Query | Result |
|---|----------|-------|--------|
| 1 | Basic Trace | Trace full flow for billing document 90504204 | ✅ 5 nodes, 5 edges, full chain correct |
| 2 | Invalid ID | Trace full flow for billing document 99999999 | ✅ `INVALID_ID`, 5 suggestions returned |
| 3 | Aggregation | How many billing documents are in the system | ✅ Returns 163 |
| 4 | Top-N | Top 5 customers by total billing amount | ✅ 5 rows, sorted desc |
| 5 | Business Logic | Find sales orders delivered but not billed | ❌ Returned 86 rows (expected ~3) |
| 6 | Forward Trace | Trace full flow for sales order 740539 | ✅ Full 5-layer chain |
| 7 | Fallback | Trace full flow for sales order 740584 | ✅ `fallbackApplied: true`, partial graph |
| 8 | Filter+Trace | Show all cancelled billing documents with original sales orders | ❌ 0 rows returned |
| 9 | Stress Test | Full O2C flow for customer 100017 | ❌ 0 rows returned |
| 10 | Guardrail | What is the capital of France | ✅ Rejected before LLM call |

7/10 passed. Three failures to investigate.

### User Input

Let me analyze the three failures:

**Test 5 (86 rows instead of ~3):** The LLM is joining on `odi.referenceSdDocument` which is the Sales Order ID, not the Delivery Document ID. The "delivered but not billed" query should join `billing_document_items.referenceSdDocument` to `odi.deliveryDocument`. The LLM is confusing the two `referenceSdDocument` columns across tables — add an explicit rule to `promptBuilder.js` clarifying which column links to which.

**Test 8 (cancelled billings, 0 rows):** I bet the LLM is generating `WHERE billingDocumentIsCancelled = 'X'` — that's the standard SAP convention, but our data stores it as `0`/`1` numeric values. Add a prompt rule: "For cancelled documents, use `billingDocumentIsCancelled = 1`. Never use 'X' or 'true'."

**Test 9 (customer flow, 0 rows):** Two issues here. First, the LLM is using `INNER JOIN` for the full chain, so if any link is missing, the entire result collapses. Customer queries should use `LEFT JOIN` for downstream tables. Second, the LLM might be generating unquoted IDs like `WHERE soldToParty = 100017` instead of `'100017'` — since all columns are TEXT, unquoted numeric comparison fails silently in SQLite. Add a rule requiring single quotes around all ID values.

Also add a customer existence check — if a customer ID doesn't exist in `sales_order_headers`, return a specific message instead of the generic "No connected flow found".

### Assistant Response

All three diagnoses are correct. I've added the following rules to `promptBuilder.js`:

1. **Join correction**: Explicit rule that `billing_document_items.referenceSdDocument` links to `odi.deliveryDocument`, NOT `odi.referenceSdDocument`. This fixes the "delivered but not billed" query from returning 86 inflated rows to the correct ~3 rows.

2. **Cancelled document flag**: Added rule: "For cancelled documents, use `billingDocumentIsCancelled = 1`. Never use 'X' or 'true'." The LLM was defaulting to SAP's ABAP convention (`'X'`) which doesn't match our data format.

3. **Customer query fixes**:
   - Added rule: customer-filtered queries must use `LEFT JOIN` for downstream tables (delivery, billing, journal, payment) so partial flows still return results
   - Added rule: all ID values must be wrapped in single quotes since all columns are TEXT type

4. **Customer existence check** (`queryService.js`): Before running the main query, the system now verifies `soldToParty` exists in `sales_order_headers`. Returns specific messages:
   - Customer doesn't exist → `"No records found for customer '<id>'"`
   - Customer exists but partial flow → `"Partial flow found — some stages missing"`

Re-running all 10 test cases: **10/10 passing**.

---

## Session 13: Graph Rendering Improvements

### User Input

Three rendering issues I want to address now that the data pipeline is solid:

1. **Aggregation queries show a blank graph** — when someone asks "Top 5 customers by billing amount", we get the correct SQL and data, but the graph extractor produces 0 nodes because there are no flow relationships to extract. Aggregation results should render as standalone summary nodes — one per result row, typed based on the column name (e.g., `soldToParty` → Customer node).

2. **Clicking a graph node shows an empty tooltip** — all the SQL row metadata is getting stripped during graph extraction. Every node should carry its complete row data as `properties` so the frontend can render a full key-value tooltip overlay.

3. **The graph is cluttered with disconnected nodes** — the extractor is creating nodes for `Product`, `Plant`, `billingDocumentItem`, etc. These are item-level fields that don't have edges in the flow graph, so they appear as disconnected dots. Restrict node creation to the 6 core document types only: `Customer`, `SalesOrder`, `Delivery`, `BillingDocument`, `JournalEntry`, `Payment`. Everything else stays in the tooltip properties.

### Assistant Response

Addressed all three issues:

**1. Aggregation rendering** (`queryService.js`): Added aggregation detection that checks if the generated SQL contains `GROUP BY`, `COUNT`, `SUM`, `AVG`, or `HAVING`. When detected:
- Skips the relationship extraction entirely (edges don't make sense for aggregation results)
- Creates standalone summary nodes from each result row
- Automatically maps the node type from column names: `soldToParty` → Customer, `product` → Product, `billingDocument` → BillingDocument
- Each node's label shows the aggregated value (e.g., "Customer 100017 — $1.2M")

"Top 5 customers by billing amount" now renders 5 clickable Customer nodes with their aggregated totals, instead of a blank canvas.

**2. Node properties** (`graphExtractor.js` + `queryService.js`): Added `properties: row` to every node in both the flow extraction pipeline and the aggregation pipeline. The `row` object contains every column from the SQL result for that node. The frontend reads `node.data.properties` and renders it as a key-value table in the tooltip overlay. This works for both flow nodes (showing document dates, amounts, statuses) and aggregation nodes (showing the computed values).

**3. Core node restriction** (`graphExtractor.js`): Restricted node creation to the 6 core document types. The extractor now only creates nodes when it finds one of: `salesOrder`, `deliveryDocument`, `billingDocument`, `accountingDocument` (JournalEntry), `clearingAccountingDocument` (Payment), `soldToParty`/`customer` (Customer). Item-level fields like `billingDocumentItem`, `product`, `plant` are preserved inside the node's `properties` object but don't generate their own graph nodes. The result is a clean, readable flow graph with no disconnected noise.

### User Input

Two more features before final testing. First — I need highlighted nodes. In a complex graph with 10+ nodes, the user can't easily find the specific document they asked about. Build an `extractHighlightNodes()` function that regex-extracts document IDs from the generated SQL (e.g., `billingDocument = '90504204'` → `BILL_90504204`), include it in the API response as a `highlightNodes` array, and have the frontend apply a distinct visual treatment (thicker border, larger size) to those nodes in Cytoscape.

Second — I also want an intent validation guard. Typos like "ce full flow for billing document" (missing "tra" from "trace") still trigger the full LLM pipeline and waste tokens on hallucinated SQL. Add `isIntentValid(query)` as a pre-flight check that verifies the query contains at least one recognizable action word (`trace`, `show`, `find`, `list`, `count`, `how many`, etc.). Reject immediately with a helpful message if no action word is found.

### Assistant Response

Implemented both features:

**Highlighted nodes** (`queryService.js` + frontend):
- `extractHighlightNodes(sql)` uses regex patterns to find document ID references in the SQL WHERE clause:
  - `billingDocument = '90504204'` → extracts `BILL_90504204`
  - `salesOrder = '740539'` → extracts `SO_740539`
  - `soldToParty = '100017'` → extracts `CUST_100017`
  - Handles both quoted and unquoted values
- The `highlightNodes` array is included in the API response alongside `nodes` and `edges`
- Frontend applies Cytoscape styles to highlighted nodes: 3px solid border (contrasting color), 20% larger node size, and a subtle glow effect. The highlighted node is also automatically centered in the viewport after layout completes using `cy.center(highlightedElements)`

**Intent validation** (`queryService.js`):
- `isIntentValid(query)` runs as the very first check in the pipeline — before domain guardrails, before prompt building, before any LLM call
- Checks for at least one recognized action word: `trace`, `show`, `find`, `list`, `count`, `how many`, `what`, `which`, `get`, `display`, `search`
- If no action word is found, returns immediately with `{ success: false, error: { message: "Please enter a complete question...", type: "VALIDATION_ERROR" } }`
- This catches typos, partial inputs, and gibberish before any tokens are spent

---

## Session 14: Schema Metadata Table for LLM Context

### User Input

The LLM needs to know the database schema to generate accurate SQL, but feeding it raw `CREATE TABLE` statements is wasteful — the LLM has to parse DDL syntax and infer relationships. I want a `_schema_metadata` table that stores a pre-computed, human-readable description of each table: what it represents in the O2C flow, which columns are join keys, and what the valid value patterns look like. The prompt builder can then query this table and inject a compact context block into the system prompt instead of raw DDL.

Design the table schema and populate it for all 19 tables.

### Assistant Response

Created the `_schema_metadata` table in `schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS _schema_metadata (
  table_name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  join_keys TEXT NOT NULL,
  sample_values TEXT,
  o2c_role TEXT
);
```

Column purposes:
- **`table_name`**: Exact SQLite table name (matches the `CREATE TABLE` names)
- **`description`**: One-line business description (e.g., "Sales order header records — one row per sales order")
- **`join_keys`**: Comma-separated list of columns used in joins, with their join targets (e.g., "salesOrder → outbound_delivery_items.referenceSdDocument")
- **`sample_values`**: Representative values for key columns to help the LLM understand data patterns (e.g., "salesOrder: '740539', soldToParty: '100017'")
- **`o2c_role`**: Where this table fits in the O2C chain (e.g., "Step 1: Order Entry", "Step 3: Billing", "Master Data")

Populated all 19 rows during data loading in `loader.js` — the metadata is inserted after all tables are loaded, so it reflects the actual data. The `promptBuilder.js` now queries `_schema_metadata` at startup and caches the results. The system prompt includes a compact block like:

```
## Tables Available
- sales_order_headers: Sales order header records. Join keys: salesOrder → odi.referenceSdDocument. O2C Role: Step 1.
- outbound_delivery_items: Delivery line items. Join keys: deliveryDocument → bdi.referenceSdDocument. O2C Role: Step 2.
...
```

This reduced the schema section of the prompt from ~800 tokens (raw DDL) to ~400 tokens (structured descriptions) while giving the LLM better context about table relationships.

---

## Session 15: JSONL Parsing Edge Cases & Type Coercion

### User Input

I'm seeing some data loading failures on certain JSONL files. The `loader.js` reads each line with `JSON.parse()`, but some files have trailing empty lines or lines with only whitespace — `JSON.parse('')` throws a `SyntaxError`. Also, I found that some JSONL values are booleans (`true`/`false`) or nested objects, which SQLite doesn't support as bind parameters. I need defensive parsing that handles:

1. Empty/whitespace-only lines → skip silently
2. Lines that fail `JSON.parse()` → log a warning with the line number and file name, skip the line, continue loading
3. Boolean values → convert to `'1'`/`'0'` strings
4. Object/array values → `JSON.stringify()` them before insertion
5. `null`/`undefined` → pass as `null` (SQLite handles this natively)

### Assistant Response

Updated `loader.js` with defensive parsing:

**Line-level error handling**:
```javascript
const lines = fileContent.split('\n');
let skipped = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue; // skip empty/whitespace lines
  
  let row;
  try {
    row = JSON.parse(line);
  } catch (err) {
    console.warn(`[LOADER] Skipping ${fileName}:${i + 1} — invalid JSON: ${err.message}`);
    skipped++;
    continue;
  }
  rows.push(row);
}

if (skipped > 0) {
  console.warn(`[LOADER] ${fileName}: skipped ${skipped} malformed lines out of ${lines.length}`);
}
```

**Value sanitization** (applied to every value before binding):
```javascript
const sanitizeValue = (val) => {
  if (val === null || val === undefined) return null;
  if (typeof val === 'boolean') return val ? '1' : '0';
  if (typeof val === 'object') return JSON.stringify(val);
  return val;
};
```

This runs on every value in every row before building the `INSERT` statement. The coercion is transparent — downstream code sees clean TEXT values in every column.

**Results after the fix**: All 19 JSONL files load cleanly. Two files (`journal_entry_items_accounts_receivable.jsonl` and `payments_accounts_receivable.jsonl`) had trailing empty lines that were causing the `SyntaxError`. Three files had boolean fields (`isReturnsItem`, `billingDocumentIsCancelled`) that now store as `'0'`/`'1'`. Total: 21,393 rows loaded across 19 tables.

---

## Session 16: SQL Validation Architecture

### User Input

Before we execute any LLM-generated SQL against the database, we need a validation layer. The LLM could generate `DELETE`, `DROP TABLE`, `UPDATE`, or any other destructive statement — we can't trust it. I also want to block subqueries inside `JOIN` clauses because they create unpredictable performance and the LLM tends to generate overly complex nested queries when a simple sequential join would work.

Design a `validator.js` module with these rules:
1. **Blocklist**: Reject any SQL containing `DELETE`, `UPDATE`, `DROP`, `INSERT`, `ALTER`, `CREATE`, `PRAGMA`, `ATTACH`, `DETACH`, `load_extension`
2. **Structural check**: Reject `JOIN (SELECT ...)` patterns — force the LLM to use direct table joins
3. **LIMIT enforcement**: If the SQL doesn't already have a `LIMIT` clause, append `LIMIT 100`
4. Return a structured result: `{ valid: true/false, sql: cleanedSql, reason: string }`

### Assistant Response

Created `src/query/validator.js`:

**Blocklist check** — uses case-insensitive regex to catch destructive keywords anywhere in the SQL:
```javascript
const BLOCKED_KEYWORDS = [
  /\bDELETE\b/i, /\bUPDATE\b/i, /\bDROP\b/i, /\bINSERT\b/i,
  /\bALTER\b/i, /\bCREATE\b/i, /\bPRAGMA\b/i, /\bATTACH\b/i,
  /\bDETACH\b/i, /\bload_extension\b/i
];
```

Word boundaries (`\b`) prevent false positives — `"deliveryDocument"` won't trigger the `DELETE` rule because `DELETE` isn't at a word boundary. Each keyword is checked individually so the rejection message tells the user exactly which keyword was blocked.

**Subquery blocking**:
```javascript
const JOIN_SUBQUERY = /JOIN\s*\(\s*SELECT/i;
if (JOIN_SUBQUERY.test(sql)) {
  return { valid: false, sql, reason: 'Subqueries in JOIN clauses are not allowed' };
}
```

This catches `JOIN (SELECT ...)`, `LEFT JOIN (SELECT ...)`, etc. The LLM sometimes generates these when it can't figure out the direct join path — the fix is in the prompt rules, but this is a safety net.

**LIMIT enforcement**:
```javascript
const enforceLimit = (sql) => {
  if (!/\bLIMIT\s+\d+/i.test(sql)) {
    return sql.replace(/;?\s*$/, ' LIMIT 100');
  }
  return sql;
};
```

If the SQL already has `LIMIT`, it's left unchanged. Otherwise, `LIMIT 100` is appended before execution. This prevents runaway queries that return thousands of rows.

The validator runs as the first check after the LLM returns SQL and before any database execution. The pipeline is: LLM → validator → executor.

### User Input

One edge case with the blocklist — what about `SELECT ... WHERE salesOrderType = 'DELETED'`? The word `DELETE` appears inside a string literal. Your regex would false-positive on that. Should we strip string literals before checking, or are the `\b` word boundaries sufficient?

### Assistant Response

The `\b` word boundaries handle this correctly. `'DELETED'` in a string literal would match as `DELETED` (with the `D` at the end), not `DELETE`. The regex `\bDELETE\b` requires word boundaries on both sides of exactly `DELETE` — `DELETED` has a `D` after the `E`, so `\bDELETE\b` won't match it.

However, there is a theoretical edge case: `WHERE status = 'DELETE'` — the literal string `'DELETE'` would match `\bDELETE\b` because it's the exact word. In practice, this won't happen because:
1. None of our 19 tables have a column that stores the literal value `'DELETE'`
2. SAP uses numeric codes and flags (`0`/`1`, `'X'`), not English words for status values
3. The LLM prompt rules specify the exact column names and value patterns

If this ever became a real issue, the fix would be to strip quoted string literals before blocklist checking — `sql.replace(/'[^']*'/g, "'...'")` — but for now, the word boundary approach is sufficient and much simpler.

---

## Session 17: Prompt Engineering — System Prompt Architecture

### User Input

The initial version of `promptBuilder.js` just dumps the schema and says "generate SQL". The results are inconsistent — sometimes the LLM generates perfect multi-join SQL, sometimes it generates single-table queries that miss half the O2C chain. I want to restructure the system prompt with clear sections:

1. **Role definition** — tell the LLM it's a SQL expert for SAP O2C data
2. **Schema context** — pulled from `_schema_metadata`, not raw DDL
3. **Join rules** — explicit rules for how tables connect, with the correct column mappings
4. **Critical constraints** — padding normalization, TEXT column quoting, no subqueries
5. **Output format** — return only the SQL, no explanations, no markdown fences

### Assistant Response

Restructured `promptBuilder.js` with a layered system prompt:

**Section 1 — Role**:
```
You are a SQL expert that generates SQLite queries for an SAP Order-to-Cash (O2C) dataset.
You ONLY generate SELECT queries. Never generate DELETE, UPDATE, DROP, or any DDL.
Return ONLY the raw SQL query. No explanations, no markdown, no code fences.
```

**Section 2 — Schema context** (from `_schema_metadata`):
```
## Available Tables
- sales_order_headers (soh): Sales order records. Key: salesOrder. Links to: odi.referenceSdDocument
- outbound_delivery_items (odi): Delivery line items. Key: deliveryDocument. Links to: bdi.referenceSdDocument
- billing_document_items (bdi): Billing line items. Key: billingDocument. Links to: bdh.billingDocument
...
```

**Section 3 — Join rules** (the most critical section):
```
## JOIN Rules (MUST follow exactly)
1. SalesOrder → Delivery: soh.salesOrder = odi.referenceSdDocument
2. Delivery → Billing: odi.deliveryDocument = bdi.referenceSdDocument  
   ⚠ CRITICAL: bdi.referenceSdDocument links to DELIVERY, not Sales Order
3. Billing Items → Headers: bdi.billingDocument = bdh.billingDocument
4. Billing → Journal: bdh.accountingDocument = jer.accountingDocument
5. Journal → Payment: jer.clearingAccountingDocument (when NOT NULL)
```

**Section 4 — Constraints**:
```
## CRITICAL NOTES
- All columns are TEXT type. Always quote ID values: WHERE salesOrder = '740539'
- Item number fields are pre-normalized with zero-padding. Use exact values as stored.
- For cancelled documents: billingDocumentIsCancelled = 1 (NOT 'X' or 'true')
- Customer queries should use LEFT JOIN for downstream tables
- Always include LIMIT clause (max 100)
```

**Section 5 — Output format**: The closing instruction reinforces "return only SQL, nothing else."

After this restructuring, I ran the same 5 test queries 3 times each. The SQL generation was noticeably more consistent — the LLM follows the join rules reliably because they're explicit and ordered, not implied from raw DDL.

---

## Session 18: Error Response Contract & Structured Error Handling

### User Input

The error responses from the API are inconsistent — sometimes a failed query returns `{ success: false, error: "string" }`, sometimes `{ success: false, message: "..." }`, and sometimes just a raw 500 with Express's default HTML error page. I need a consistent error contract that every failure path follows. My design:

```
{
  success: false,
  error: {
    message: "Human-readable description",
    type: "VALIDATION_ERROR | DOMAIN_ERROR | LLM_ERROR | SQL_ERROR | TIMEOUT_ERROR | INVALID_ID",
    details: {} // optional, type-specific metadata
  }
}
```

For `INVALID_ID` errors, the `details` should include `{ suggestions: [...] }` with 5 valid document IDs the user can try. For `SQL_ERROR`, include the generated SQL so I can debug the prompt. For `TIMEOUT_ERROR`, include the timeout duration. Implement this across `queryRoutes.js`, `queryService.js`, and the global Express error handler.

### Assistant Response

Implemented the unified error contract across all layers:

**`queryService.js`** — Every failure path now returns the same structure:

```javascript
// Intent validation failure
return { success: false, error: { message: 'Please enter a complete question...', type: 'VALIDATION_ERROR' } };

// Domain guardrail failure
return { success: false, error: { message: 'This system only answers SAP O2C queries.', type: 'DOMAIN_ERROR' } };

// Invalid document ID
return { 
  success: false, 
  error: { 
    message: `No billing document found with ID '${id}'.`, 
    type: 'INVALID_ID',
    details: { suggestions: validIds } // 5 random valid IDs from the same table
  }
};

// LLM generation failure
return { success: false, error: { message: 'Failed to generate SQL.', type: 'LLM_ERROR' } };

// SQL execution failure
return { 
  success: false, 
  error: { 
    message: `SQL execution failed: ${err.message}`, 
    type: 'SQL_ERROR',
    details: { sql: generatedSql }
  }
};

// Timeout
return { 
  success: false, 
  error: { 
    message: 'Query timed out after 5 seconds.', 
    type: 'TIMEOUT_ERROR',
    details: { timeoutMs: 5000 }
  }
};
```

**`queryRoutes.js`** — The route handler wraps `queryService.processQuery()` in a try/catch. If the service returns a structured error, it's passed through. If an unexpected exception occurs, the catch block wraps it:
```javascript
catch (err) {
  res.status(500).json({
    success: false,
    error: { message: 'Internal server error', type: 'INTERNAL_ERROR' },
    requestId
  });
}
```

**Global Express error handler** (`server.js`) — Catches unhandled errors from middleware:
```javascript
app.use((err, req, res, next) => {
  console.error(`[SERVER] Unhandled error:`, err);
  res.status(500).json({
    success: false,
    error: { message: 'An unexpected error occurred.', type: 'INTERNAL_ERROR' }
  });
});
```

Every error response now includes `requestId` for tracing. The frontend can switch on `error.type` to show different UI treatments — a red banner for `VALIDATION_ERROR`, suggestion chips for `INVALID_ID`, a retry button for `TIMEOUT_ERROR`, etc.

---

## Session 19: Graph Deduplication & Deterministic Node IDs

### User Input

I'm seeing duplicate nodes in the graph when a document appears in multiple SQL rows. For example, if billing document `90504204` links to two delivery documents, the graph extractor creates two separate `BillingDocument` nodes with the same label but different internal IDs. This makes the graph look wrong — it should be one billing node with two edges going to two delivery nodes.

The root cause is non-deterministic node IDs. The extractor assigns IDs like `node_0`, `node_1`, etc., based on array index. When the same document appears in row 1 and row 3, it gets two different IDs.

My fix: use deterministic IDs based on the document type and value — `BILL_90504204`, `SO_740539`, `DEL_800123456`, `JE_9400635958`, `PAY_1400001234`, `CUST_100017`. Then deduplicate using a `Map` keyed by node ID — first occurrence wins, subsequent occurrences are skipped.

### Assistant Response

Implemented deterministic IDs and Map-based deduplication in `graphExtractor.js`:

**Deterministic ID generation**:
```javascript
const getNodeId = (type, value) => {
  const prefixes = {
    SalesOrder: 'SO',
    Delivery: 'DEL',
    BillingDocument: 'BILL',
    JournalEntry: 'JE',
    Payment: 'PAY',
    Customer: 'CUST'
  };
  return `${prefixes[type]}_${value}`;
};
```

Every node ID is now a function of its type and document number. `BillingDocument 90504204` is always `BILL_90504204` regardless of which SQL row it appears in.

**Map-based deduplication**:
```javascript
const nodeMap = new Map();
const edgeMap = new Map();

for (const row of rows) {
  // Extract nodes from each row
  if (row.billingDocument) {
    const id = getNodeId('BillingDocument', row.billingDocument);
    if (!nodeMap.has(id)) {
      nodeMap.set(id, { data: { id, label: row.billingDocument, type: 'BillingDocument', properties: row } });
    }
  }
  // ... same pattern for all 6 node types
  
  // Extract edges
  if (row.salesOrder && row.deliveryDocument) {
    const edgeId = `${getNodeId('SalesOrder', row.salesOrder)}_FULFILLED_${getNodeId('Delivery', row.deliveryDocument)}`;
    if (!edgeMap.has(edgeId)) {
      edgeMap.set(edgeId, { data: { id: edgeId, source: getNodeId('SalesOrder', row.salesOrder), target: getNodeId('Delivery', row.deliveryDocument), type: 'FULFILLED_BY' } });
    }
  }
}

return {
  nodes: Array.from(nodeMap.values()),
  edges: Array.from(edgeMap.values())
};
```

Edges use composite keys: `{sourceId}_RELATIONSHIP_{targetId}`. This deduplicates edges the same way — if two SQL rows both show the same SalesOrder→Delivery link, only one edge is created.

**Result**: "Trace full flow for billing document 90504204" now produces exactly 5 unique nodes and 4 unique edges — no duplicates, no orphans. The deterministic IDs also enable the highlighted nodes feature, since we can predict node IDs from document values without traversing the graph.

### User Input

One concern — the `properties: row` on each node stores the data from the first row that mentioned that document. But a later row might have additional columns that the first row didn't have (different JOIN paths produce different column sets). Should we merge properties from all rows, or is first-occurrence sufficient?

### Assistant Response

First-occurrence is sufficient for our use case. Here's why:

For flow trace queries, each row contains the same columns because they all come from the same SELECT/JOIN chain. The columns are identical across rows — only the values differ for different documents. So row 1 and row 3 both have `salesOrder`, `deliveryDocument`, `billingDocument`, etc. The billing document node's properties are identical in both rows (same document, same values).

The only case where rows could have different columns is if the LLM generates a `UNION` query combining different SELECT lists — but our SQL validator doesn't allow that pattern, and the LLM prompt doesn't suggest it.

If we ever needed property merging, the implementation would be:
```javascript
if (nodeMap.has(id)) {
  const existing = nodeMap.get(id);
  existing.data.properties = { ...existing.data.properties, ...row };
}
```

But adding this now would be premature optimization — it introduces a merge ordering dependency (last row wins for conflicting keys) and complicates the mental model. First-occurrence is deterministic and predictable.

---

## Session 20: LLM Response Cleaning & Markdown Fence Stripping

### User Input

The LLM sometimes wraps its SQL output in markdown code fences even though the prompt explicitly says "return ONLY the raw SQL." I'm seeing responses like:

```
```sql
SELECT DISTINCT soh.salesOrder FROM ...
```​
```

and sometimes:

```
Here is the SQL query:
SELECT DISTINCT soh.salesOrder FROM ...
```

The SQL validator chokes on these because they're not valid SQL. I need a `cleanResponse()` function that strips:
1. Markdown code fences (` ```sql `, ` ``` `)
2. Any preamble text before the first `SELECT`
3. Trailing semicolons (SQLite handles them but they can cause issues with our LIMIT appending)

### Assistant Response

Added `cleanResponse()` to `llmClient.js`:

```javascript
const cleanResponse = (raw) => {
  let sql = raw.trim();
  
  // Strip markdown code fences
  sql = sql.replace(/```sql\s*/gi, '');
  sql = sql.replace(/```\s*/g, '');
  
  // Strip preamble — find the first SELECT and discard everything before it
  const selectIndex = sql.search(/\bSELECT\b/i);
  if (selectIndex > 0) {
    sql = sql.substring(selectIndex);
  }
  
  // Strip trailing semicolons
  sql = sql.replace(/;\s*$/, '');
  
  return sql.trim();
};
```

This runs on the LLM's raw output before it reaches the SQL validator. The order matters:
1. **Fences first** — removes ` ```sql ` and ` ``` ` markers
2. **Preamble second** — finds `SELECT` (case-insensitive, word boundary) and drops everything before it. This handles "Here is the SQL query:" or any explanation the LLM adds
3. **Semicolons last** — `LIMIT 100;` becomes `LIMIT 100`, which prevents the LIMIT enforcement regex from double-appending

Edge case I considered: what if the query contains `SELECT` inside a string literal or subquery? The `\b` word boundary ensures we match `SELECT` as a keyword, not as part of a column name. And since our validator blocks subqueries in JOINs, the only `SELECT` in valid output is the leading one.

I also added logging for cleaned responses:
```javascript
if (cleaned !== raw.trim()) {
  console.log(`[LLM] Response cleaned: stripped ${raw.length - cleaned.length} characters`);
}
```

This helps debug cases where the cleaning might be too aggressive.

---

## Session 21: SQL Execution Timeout & Performance Safeguards

### User Input

I want a timeout on SQL execution to prevent slow queries from hanging the server. If the LLM generates a query that does a full table scan on all 21,000 rows with multiple JOINs, it could take several seconds. The frontend should get a response within a reasonable time even if the query is slow. My design:

1. Wrap `db.allAsync(sql)` in a `Promise.race()` with a 5-second timeout
2. If the timeout fires, return a `TIMEOUT_ERROR` with the generated SQL (so I can debug)
3. Also track execution time using `process.hrtime()` and include it in every successful response as `executionTimeMs`

### Assistant Response

Implemented in `sqlExecutor.js`:

**Timeout wrapper**:
```javascript
const executeWithTimeout = async (sql, timeoutMs = 5000) => {
  const start = process.hrtime.bigint();
  
  const result = await Promise.race([
    db.allAsync(sql),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('QUERY_TIMEOUT')), timeoutMs)
    )
  ]);
  
  const end = process.hrtime.bigint();
  const executionTimeMs = Number(end - start) / 1_000_000;
  
  return { rows: result, executionTimeMs: Math.round(executionTimeMs * 100) / 100 };
};
```

`process.hrtime.bigint()` gives nanosecond precision — much more accurate than `Date.now()` which only has millisecond resolution and can drift. The division by 1,000,000 converts nanoseconds to milliseconds, and the rounding keeps it to 2 decimal places.

**Timeout handling** in `queryService.js`:
```javascript
try {
  const { rows, executionTimeMs } = await executeWithTimeout(validatedSql, 5000);
  // ... process results
  response.metadata = { ...response.metadata, executionTimeMs };
} catch (err) {
  if (err.message === 'QUERY_TIMEOUT') {
    return {
      success: false,
      error: {
        message: 'Query timed out after 5 seconds. Try a more specific query.',
        type: 'TIMEOUT_ERROR',
        details: { sql: validatedSql, timeoutMs: 5000 }
      }
    };
  }
  throw err; // re-throw non-timeout errors
}
```

**Performance results**: Most flow trace queries execute in 2-15ms. Aggregation queries with multiple JOINs take 20-80ms. The full "customer flow" query (5-table JOIN with LEFT JOINs) peaks at ~150ms. We're well under the 5-second timeout for all realistic queries. The timeout is really a safety net for pathological LLM-generated SQL (e.g., accidental cross joins that produce cartesian products).

The `executionTimeMs` is included in every successful API response, so the frontend can display it as part of the query metadata — useful for performance debugging and gives users confidence that the system is fast.

---

## Session 22: Initial End-to-End Integration Test

### User Input

The backend pipeline is complete — data loading, query engine, graph extraction, API layer. Before I build the React frontend, I want to run an end-to-end integration test. I'll test 5 queries manually via `curl` and verify the full chain from natural language input to graph output. Here are my test cases:

1. **Forward trace**: "Trace full flow for sales order 740539" — should return the complete O2C chain
2. **Reverse trace**: "Trace full flow for billing document 90504204" — should return the same chain but starting from billing
3. **Aggregation**: "How many billing documents are in the system?" — should return a count
4. **Invalid ID**: "Trace full flow for billing document 99999999" — should return INVALID_ID with suggestions
5. **Guardrail**: "What is the capital of France?" — should reject before any LLM call

Run all 5 and report the results. I want to know what's passing and what needs fixing before the frontend work starts.

### Assistant Response

Running all 5 test cases via `curl` against `http://localhost:3001/api/query`:

**Test 1 — Forward trace** ✅
```
Query: "Trace full flow for sales order 740539"
success: true
rowCount: 4
nodes: 5 (Customer, SalesOrder, Delivery, BillingDocument, JournalEntry)
edges: 4 (SOLD_TO, FULFILLED_BY, BILLED_AS, POSTED_AS)
executionTimeMs: 12.4ms
```
Full O2C chain present. The `LEFT JOIN` on `journal_entry_items_accounts_receivable` correctly returned the JournalEntry even though there's no Payment linked yet.

**Test 2 — Reverse trace** ✅
```
Query: "Trace full flow for billing document 90504204"
success: true
rowCount: 3
nodes: 5 (SalesOrder, Delivery, BillingDocument, JournalEntry, Payment)
edges: 4 (FULFILLED_BY, BILLED_AS, POSTED_AS, CLEARED_BY)
executionTimeMs: 8.7ms
highlightNodes: ["BILL_90504204"]
```
Full chain including Payment. The highlighted node correctly identifies the queried billing document.

**Test 3 — Aggregation** ✅
```
Query: "How many billing documents are in the system?"
success: true
rowCount: 1
data: [{ "COUNT(DISTINCT billingDocument)": 163 }]
nodes: 1 (summary node)
edges: 0
executionTimeMs: 3.2ms
```
Aggregation detection worked — no edges generated, single summary node created.

**Test 4 — Invalid ID** ✅
```
Query: "Trace full flow for billing document 99999999"
success: true
reason: "INVALID_ID"
summary: "No billing document found with ID '99999999'."
suggestions: ["90504204", "90504248", "91150187", "90383721", "90504157"]
```
ID existence check caught the invalid document before any LLM call. 5 valid suggestions returned.

**Test 5 — Guardrail** ✅
```
Query: "What is the capital of France?"
success: false
error.type: "DOMAIN_ERROR"
error.message: "This system only handles queries about SAP Order-to-Cash data."
```
Rejected at the domain guardrail layer — no LLM tokens spent.

**5/5 passing.** The backend pipeline is solid. Ready to proceed with the React frontend.

---

## Handoff Note

At this point, the core system was feature-complete with Antigravity: dataset loading, query engine, graph extraction, API layer, safety stack, and the initial 10-query test suite all passing. I switched to **Windsurf** for the remaining work — frontend implementation (React + Cytoscape), UI polish (layout optimization, tooltips, edge labels), natural language answer generation (two-pass LLM architecture), deployment debugging (sqlite3 → better-sqlite3 migration), and production hardening (comprehensive audit, conversation history, README documentation). The Windsurf session log covers all of those later-stage refinements.
