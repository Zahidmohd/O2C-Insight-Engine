# Graph-Based Data Modeling and Query System

An intelligent graph-based query engine that traverses SAP Order-to-Cash (O2C) datasets using natural language. Users ask plain-language questions and receive both a **natural language answer** and an **interactive graph visualization** of the business flow.

**Core Flow:** SalesOrder → Delivery → Billing → JournalEntry → Payment

---

## Quick Start

```bash
# 1. Install dependencies
npm install
cd frontend && npm install && cd ..

# 2. Configure environment
cp .env.example .env
# Add your API keys to .env:
#   GROQ_API_KEY=your_groq_key
#   OPENROUTER_API_KEY=your_openrouter_key (fallback)

# 3. Initialize database (first time only)
node src/db/loader.js

# 4. Start backend
node src/server.js

# 5. Start frontend (separate terminal)
cd frontend && npm run dev
```

Open `http://localhost:5173` in your browser.

---

## Architecture

```
┌────────────────┐     ┌─────────────────────────────────────────────┐
│   React UI     │     │              Node.js Backend                │
│  (Vite +       │────▶│  queryRoutes.js                             │
│   Cytoscape)   │     │    ├─ queryService.js (orchestrator)        │
│                │◀────│    │   ├─ promptBuilder.js (schema context) │
│  Chat Panel    │     │    │   ├─ llmClient.js (Groq/OpenRouter)   │
│  Graph Panel   │     │    │   ├─ validator.js (SQL safety)         │
│  Tooltip       │     │    │   ├─ sqlExecutor.js (SQLite)           │
│                │     │    │   ├─ graphExtractor.js (nodes/edges)   │
└────────────────┘     │    │   └─ NL Answer generation (2nd LLM)   │
                       │    └─ server.js (Express + CORS)            │
                       └──────────────┬──────────────────────────────┘
                                      │
                       ┌──────────────▼──────────────┐
                       │   SQLite (sap_otc.db)       │
                       │   19 tables, 18+ indexes    │
                       │   All columns TEXT           │
                       └─────────────────────────────┘
```

### Directory Structure

```
src/
├── db/
│   ├── connection.js    # SQLite connection with Promise wrappers
│   ├── init.js          # Schema initialization
│   ├── loader.js        # JSONL → SQLite ingestion with padding transforms
│   └── schema.sql       # 19 tables, indexes, composite keys
├── query/
│   ├── promptBuilder.js # Schema context + few-shot examples for LLM
│   ├── llmClient.js     # Groq primary + OpenRouter fallback, NL answer generation
│   ├── validator.js     # SQL safety (blocklist, read-only, no subquery JOINs)
│   ├── sqlExecutor.js   # Parameterized execution with timing
│   ├── queryService.js  # Full pipeline orchestrator
│   └── graphExtractor.js# Row → node/edge mapping with orphan filtering
├── routes/
│   └── queryRoutes.js   # POST /api/query endpoint
└── server.js            # Express server with error handling
frontend/
├── src/
│   ├── App.jsx          # Main component: graph + chat + tooltip
│   ├── App.css          # Complete UI styling
│   └── index.css        # Base reset
└── package.json
```

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| **SQLite over Neo4j/Graph DB** | Zero-config local development; raw JSONL data maps directly to relational tables; 18+ targeted indexes make multi-hop joins fast (~3-6ms) |
| **Raw SQL over ORM** | Full control over precise 5-table JOIN chains; ORMs generate unpredictable queries that conflict with prompt engineering |
| **Billing item padding at ingestion** | Critical data fix: raw data has unpadded "10" vs zero-padded "000010" — 0/245 direct matches, 245/245 after padding. Fixed once in loader, not in every query |
| **All columns TEXT** | SAP identifiers have leading zeros (e.g., customer "0000100017") — numeric types would silently strip them |
| **Two LLM calls per query** | 1st: NL → SQL generation. 2nd: SQL results → NL answer. Separation ensures deterministic data + readable output |
| **Groq primary, OpenRouter fallback** | Groq is faster for Llama 3.1 70B; OpenRouter provides redundancy if Groq is down or rate-limited |
| **Graph nodes = 6 core document types** | Customer, SalesOrder, Delivery, BillingDocument, JournalEntry, Payment. Product/Plant shown as tooltip properties only to avoid visual clutter |

---

## LLM Prompting Strategy

The prompt in `promptBuilder.js` is carefully structured:

1. **Schema Context** — Exact table names, column names, and primary keys (11 tables relevant to O2C)
2. **Validated Join Relationships** — 5 specific JOIN patterns with exact column mappings, tested against the actual data
3. **Join Strategy Rules** — Prefer header-level joins, use LEFT JOIN for partial flows, never use subqueries in JOINs
4. **Few-Shot Examples** — 3 concrete SQL examples (trace flow, aggregation, broken flows) to eliminate LLM non-determinism
5. **Instructions** — SQLite-only syntax, TEXT type quoting rules, cancelled flag handling

### NL Answer Generation

After SQL execution, a second LLM call converts raw rows into a human-readable sentence:
- Input: user question + first 10 rows + total row count
- Output: concise factual answer backed by data (e.g., "The journal entry linked to billing document 91150187 is 9400635958")
- Timeout: 20s with graceful degradation (falls back to metadata summary)

---

## Safety & Guardrails

### Multi-Layer Protection

1. **Intent Validation** — Rejects queries without recognizable business action words (30+ allowed intent verbs)
2. **Domain Guardrails** — Requires at least one SAP/O2C domain keyword; blocks off-topic questions before LLM call
3. **SQL Blocklist** — Rejects DELETE, UPDATE, DROP, ALTER, PRAGMA, load_extension
4. **Read-Only Enforcement** — Only SELECT statements pass validation
5. **Subquery Block** — No nested SELECT inside JOIN conditions (prevents cartesian explosions)
6. **LIMIT 100 Enforcement** — Auto-appended if missing from LLM output
7. **Execution Timeouts** — LLM: 15s, DB: 5s, NL Answer: 20s
8. **Payload Truncation** — Max 100 rows in API response regardless of DB result
9. **ID Existence Checks** — Pre-validates billingDocument, salesOrder, deliveryDocument, and customer IDs before executing the main query; returns suggestions if invalid

### Fallback Mechanisms

- **LEFT JOIN Retry** — If a flow query returns 0 rows (e.g., incomplete O2C chain), the system automatically relaxes INNER JOINs to LEFT JOINs and retries
- **LLM Fallback** — If Groq fails, automatically retries with OpenRouter
- **Orphan Node Removal** — Nodes with zero edges are filtered from flow queries (but kept in listing queries)

---

## Graph Handling

### Node Types & Colors

| Node Type | Color | ID Pattern |
|---|---|---|
| SalesOrder | Blue (#6b9cf7) | SO_{id} |
| Delivery | Blue (#6b9cf7) | DEL_{id} |
| BillingDocument | Pink (#e87c8a) | BILL_{id} |
| JournalEntry | Blue (#6b9cf7) | JE_{id} |
| Payment | Blue (#6b9cf7) | PAY_{id} |
| Customer | Pink (#e87c8a) | CUST_{id} |

### Edge Types

ORDERED, FULFILLED_BY, BILLED_AS, POSTED_AS, CLEARED_BY, BILLED_TO — representing the O2C chain relationships.

### Layout

- **Breadthfirst (directed)** — Clean hierarchical top-to-bottom flow matching the O2C chain
- **Fit + zoom capping** — Auto-fits with maxZoom 2.5 to prevent oversized nodes on small graphs

---

## Frontend Features

- **Dual-Pane Layout** — Graph panel (~70% width) + Chat panel (~340px)
- **Conversational Chat** — Full conversation history with user/agent message bubbles
- **Natural Language Answers** — AI-generated human-readable answers displayed as agent messages
- **Interactive Graph** — Click nodes to see tooltip with all properties, drag tooltip anywhere
- **Fit View / Hide Edge Labels** — Floating action buttons on graph panel
- **Draggable Tooltips** — Tooltips can be dragged freely if they appear off-screen
- **Suggestion Chips** — When an invalid document ID is entered, valid alternatives are suggested
- **Loading States** — Animated dot pulse during query processing

---

## Observability

Every query is assigned a unique `requestId` (UUID v4) that appears in:
- Server console logs (with SQL, execution time, row count)
- Frontend execution details card
- API response payload

This enables end-to-end tracing from UI to database.

---

## API Reference

### POST /api/query

**Request:**
```json
{ "query": "Trace full flow for billing document 90504204" }
```

**Response:**
```json
{
  "success": true,
  "requestId": "uuid",
  "query": "...",
  "sql": "SELECT ...",
  "rowCount": 5,
  "executionTimeMs": 3.42,
  "nlAnswer": "The billing document 90504204 is linked to sales order ...",
  "summary": "...",
  "reason": null,
  "graph": { "nodes": [...], "edges": [...] },
  "highlightNodes": ["BILL_90504204"],
  "data": [...]
}
```

---

## Dataset

19 JSONL tables from SAP S/4HANA Order-to-Cash process:
- **10 Transactional:** sales_order_headers/items, outbound_delivery_headers/items, billing_document_headers/items/cancellations, journal_entry_items, payments, schedule_lines
- **9 Master Data:** business_partners, addresses, customer_company/sales_area_assignments, products, product_descriptions, plants, product_plants, product_storage_locations

---

## Future Improvements

- **Intelligent Caching** — Cache repeated queries to bypass LLM regeneration
- **Conversation Memory** — Pass previous Q&A context to LLM for follow-up questions
- **Database Scaling** — Migrate to PostgreSQL for concurrent access
- **Export** — Download graph as PNG/SVG or data as CSV
