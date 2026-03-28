# O2C-Insight-Engine — Manual Testing Guide

Run the server first: `npm start`
Open the UI at: `http://localhost:3000`
Or test the API directly with any HTTP client (Postman, curl, etc.)

---

## HOW TO READ THIS GUIDE

Each test shows:
- **Query** — type this into the chat box
- **Expected** — what you should see in the response

---

## 1. INPUT VALIDATION

These should fail immediately before any LLM call.

---

### 1.1 Empty query

**Query:** *(submit with nothing typed)*

**Expected:**
```
Error: Query cannot be empty.
Error type: VALIDATION_ERROR
```

---

### 1.2 Query too long

**Query:** *(paste 501+ characters of any text)*

**Expected:**
```
Error: Query exceeds max length of 500 characters.
Error type: VALIDATION_ERROR
```

---

## 2. GUARDRAILS

These are blocked by the domain + intent filter before LLM is called.

---

### 2.1 Gibberish / no intent

**Query:**
```
xyzzy frobble wumpus
```

**Expected:**
```
success: false
Error: Could not understand the query. Please rephrase using a clear business action like 'trace', 'show', or 'find'.
Error type: VALIDATION_ERROR
```

---

### 2.2 Off-topic but uses "what is" (RAG path)

**Query:**
```
What is the capital of France?
```

**Expected:**
```
success: true
queryType: RAG
reason: RAG_RESPONSE
nlAnswer: "No specific context found for this topic in the O2C knowledge base."
confidence: 1.00
No graph shown
```

> Note: "What is..." matches the RAG classifier before the domain guardrail fires.
> This is intentional — RAG queries bypass SQL but still degrade gracefully on KB miss.

---

## 3. RAG QUERIES (Knowledge Base Explanations)

These return concept explanations. No SQL runs, no graph shown.

---

### 3.1 What is O2C?

**Query:**
```
What is order to cash?
```

**Expected:**
```
queryType: RAG
reason: RAG_RESPONSE
confidence: 1.00
explanation:
  Intent: concept explanation
  Strategy: knowledge retrieval
nlAnswer: explains the O2C flow (Sales Order → Delivery → Billing → Journal → Payment)
No graph, rowCount: 0
```

---

### 3.2 What is a sales order?

**Query:**
```
What is a sales order?
```

**Expected:**
```
queryType: RAG
nlAnswer: definition of a Sales Order in SAP
confidence: 1.00
```

---

### 3.3 Describe billing

**Query:**
```
Describe the billing process
```

**Expected:**
```
queryType: RAG
nlAnswer: explains Billing Document, cancellations, journal entry link
confidence: 1.00
```

---

### 3.4 Define journal entry

**Query:**
```
Define journal entry
```

**Expected:**
```
queryType: RAG
nlAnswer: explains AR posting, clearing document
confidence: 1.00
```

---

### 3.5 Explain payment clearing

**Query:**
```
Explain payment clearing
```

**Expected:**
```
queryType: RAG
nlAnswer: explains how payments are matched via clearingAccountingDocument
confidence: 1.00
```

---

## 4. HYBRID QUERIES (SQL + Business Context)

These run SQL AND inject knowledge base context into the NL answer.

---

### 4.1 Why is billing not cleared?

**Query:**
```
Why is the billing document not cleared?
```

**Expected:**
```
queryType: HYBRID
success: true
rowCount > 0
explanation.intent: gap-analysis
confidence < 1.00  (SQL + KB, some uncertainty)
nlAnswer: answer enriched with explanation of clearing mechanism
Graph: shows billing + journal nodes
```

---

### 4.2 Why are some orders not billed?

**Query:**
```
Why are some sales orders not billed?
```

**Expected:**
```
queryType: HYBRID
SQL executes to find delivered-but-not-billed orders
nlAnswer: factual answer with optional KB context about billing
Graph: shows Sales Order + Delivery nodes with no Billing link
```

---

### 4.3 Reason for cancelled billing

**Query:**
```
What is the reason for billing document cancellations?
```

**Expected:**
```
queryType: HYBRID
nlAnswer: explains cancellation with actual data from dataset
confidence < 1.00
```

---

## 5. SQL QUERIES — FLOW TRACES

---

### 5.1 Full flow trace (billing document)

**Query:**
```
Trace full flow for billing document 90504204
```

**Expected:**
```
success: true
queryType: SQL
rowCount > 0
explanation:
  Intent: trace
  Strategy: multi-hop join across O2C flow
Graph: shows Sales Order → Delivery → Billing → Journal Entry → Payment
confidence: 1.00
```

---

### 5.2 Full flow trace (another billing doc)

**Query:**
```
Trace full flow for billing document 90504248
```

**Expected:**
```
Same structure as above with different document IDs in the graph
```

---

### 5.3 Trace from sales order

**Query:**
```
Show full flow for sales order 4
```

**Expected:**
```
SQL traces from sales_order_headers forward through delivery → billing → journal → payment
Graph: full chain if all stages exist
```

---

## 6. SQL QUERIES — AGGREGATIONS

---

### 6.1 Top customers by billing

**Query:**
```
Top 5 customers by total billing amount
```

**Expected:**
```
reason: AGGREGATION
rowCount: up to 5
confidence: 0.90 (aggregation reduces by -0.1)
Graph: shows Customer nodes with billing count/amount labels
nlAnswer: names the top customers and their amounts
```

---

### 6.2 Count billing documents

**Query:**
```
Count all billing documents
```

**Expected:**
```
reason: AGGREGATION
rowCount: 1
confidence: 0.90
nlAnswer: "There are X billing documents in the dataset."
```

---

### 6.3 Products with most billing

**Query:**
```
Which products have the most billing documents?
```

**Expected:**
```
reason: AGGREGATION
rowCount > 0
Graph: Product nodes with billing count
```

---

### 6.4 How many delivery documents?

**Query:**
```
How many delivery documents are there?
```

**Expected:**
```
reason: AGGREGATION
rowCount: 1
confidence: 0.90
```

---

## 7. SQL QUERIES — GAP / EXCEPTION ANALYSIS

---

### 7.1 Delivered but not billed

**Query:**
```
Find sales orders delivered but not billed
```

**Expected:**
```
success: true
rowCount > 0
explanation:
  Intent: gap-analysis
  Strategy: gap detection using LEFT JOIN with NULL check
Graph: Sales Order + Delivery nodes (no Billing edges)
```

---

### 7.2 Cancelled billing documents

**Query:**
```
Show all cancelled billing documents
```

**Expected:**
```
success: true
rowCount > 0
Graph: BillingDocument nodes marked as cancelled
```

---

### 7.3 Billing without journal entry

**Query:**
```
Show billing documents without a journal entry
```

**Expected:**
```
success: true
rowCount > 0 (if any exist in dataset)
Graph: BillingDocument nodes with no JournalEntry link
```

---

## 8. SQL QUERIES — CUSTOMER LOOKUPS

---

### 8.1 All orders for a customer

**Query:**
```
Show all orders for customer 320000083
```

**Expected:**
```
success: true
rowCount > 0
Graph: Customer → multiple Sales Order nodes
```

---

### 8.2 Invalid customer ID

**Query:**
```
Show all orders for customer 99999999
```

**Expected:**
```
success: true
reason: INVALID_ID
message: "No records found for the given query."
rowCount: 0
No graph
```

---

## 9. INVALID DOCUMENT IDs

---

### 9.1 Invalid billing document

**Query:**
```
Trace full flow for billing document 99999999
```

**Expected:**
```
success: true
reason: INVALID_ID
message: "No records found for the given query."
rowCount: 0
suggestions: [ list of 5 valid billing document IDs ]
No graph — UI shows "Document not found in the dataset"
```

> Click one of the suggestion chips — it auto-fills a valid trace query.

---

## 10. SQL VISIBILITY TOGGLE

Test the "Show SQL (for developers)" checkbox in the chat panel.

---

### 10.1 SQL hidden (default)

**Steps:**
1. Leave the checkbox **unchecked**
2. Send: `List all sales orders`

**Expected:**
```
No "Generated SQL (Debug View)" card appears
```

---

### 10.2 SQL visible

**Steps:**
1. **Check** the "Show SQL (for developers)" checkbox
2. Send: `List all sales orders`

**Expected:**
```
"Generated SQL (Debug View)" card appears below the answer
Shows the raw SELECT statement used
```

---

### 10.3 SQL for a trace query

**Steps:**
1. Check the SQL toggle
2. Send: `Trace full flow for billing document 90504204`

**Expected SQL shape:**
```sql
SELECT DISTINCT
  soh.salesOrder, soh.soldToParty, ...
FROM billing_document_headers bdh
JOIN billing_document_items bdi ...
JOIN outbound_delivery_items odi ...
JOIN outbound_delivery_headers odh ...
JOIN sales_order_headers soh ...
LEFT JOIN journal_entry_items_accounts_receivable je ...
LEFT JOIN payments_accounts_receivable pay ...
WHERE bdh.billingDocument = '90504204'
LIMIT 100
```

---

## 11. EXPLANATION DISPLAY

Every SQL and HYBRID query returns an explanation card "How this was answered".

---

### 11.1 Trace query explanation

**Query:** `Trace full flow for billing document 90504204`

**Expected explanation card:**
```
Intent:   trace
Entities: billing, delivery  (or similar — based on query keywords)
Strategy: multi-hop join across O2C flow
```

---

### 11.2 Aggregation query explanation

**Query:** `Top 5 customers by total billing amount`

**Expected explanation card:**
```
Intent:   aggregation
Entities: customer, billing
Strategy: aggregation query with GROUP BY
```

---

### 11.3 Gap analysis explanation

**Query:** `Find sales orders delivered but not billed`

**Expected explanation card:**
```
Intent:   gap-analysis
Entities: sales order, delivery, billing
Strategy: gap detection using LEFT JOIN with NULL check
```

---

### 11.4 List query explanation

**Query:** `List all customers`

**Expected explanation card:**
```
Intent:   list
Entities: customer
Strategy: lookup with filters  (or multi-table join query)
```

---

## 12. CONFIDENCE SCORE

---

### 12.1 Normal SQL query (high confidence)

**Query:** `Trace full flow for billing document 90504204`

**Expected:**
```
Confidence: 1.00
(No fallback applied, rows found, not an aggregation)
```

---

### 12.2 Aggregation query (reduced)

**Query:** `Count all billing documents`

**Expected:**
```
Confidence: 0.90
(aggregation deducts -0.10)
```

---

### 12.3 RAG query (always maximum)

**Query:** `What is order to cash?`

**Expected:**
```
Confidence: 1.00
(KB lookup has no SQL uncertainty)
```

---

### 12.4 Zero-row result (low confidence)

**Query:** `Trace full flow for billing document 99999999`

**Expected:**
```
Confidence: 0.60 or lower
(rowCount = 0 deducts -0.40)
```

---

## 13. ZERO-DATA MESSAGE

When a query produces no results, a human-readable message appears.

---

### 13.1 Invalid document

**Query:** `Trace full flow for billing document 99999999`

**Expected:**
```
message: "No records found for the given query."
reason: INVALID_ID
suggestions: [...valid IDs...]
```

---

### 13.2 Document exists but no connected flow

**Query:** *(a valid document ID that exists but has an incomplete chain)*

**Expected:**
```
reason: NO_FLOW
message: "No records found for the given query."
Graph empty state: "No connected flow found"
```

---

## 14. GRAPH INTERACTIONS

---

### 14.1 Click a node

**Steps:**
1. Run: `Trace full flow for billing document 90504204`
2. Click any node in the graph

**Expected:**
```
Node tooltip appears showing:
- Entity type (e.g. BillingDocument)
- All properties (billingDocument, totalNetAmount, etc.)
- Connections count
Tooltip is draggable
```

---

### 14.2 Hide/show edge labels

**Steps:**
1. Run any trace query
2. Click "Hide Edge Labels" button (top-left of graph)

**Expected:**
```
Edge labels (FULFILLED_BY, BILLED_AS, etc.) disappear
Button changes to "Show Edge Labels"
Click again to restore labels
```

---

### 14.3 Fit view

**Steps:**
1. Run a trace query with a large graph
2. Zoom in manually (scroll)
3. Click "Fit View"

**Expected:**
```
Graph recenters and fits all nodes in the viewport
```

---

## 15. FALLBACK JOIN (Partial Flows)

When a full flow trace returns 0 rows, the system silently retries with LEFT JOINs.

---

### 15.1 Trigger fallback

**Query:**
```
Show all sales orders with their deliveries
```

**Expected (if fallback triggered):**
```
fallbackApplied: true  (visible in API response)
confidence: 0.80  (fallback deducts -0.20)
summary: "Partial flow recovered using relaxed joins"
Graph: shows partial connections (e.g. Order → Delivery without Billing)
```

---

## QUICK REFERENCE — QUERY TYPE MATRIX

| Query Pattern | queryType | SQL runs | KB used | Graph shown |
|---|---|---|---|---|
| "What is..." / "Define..." | RAG | No | Yes | No |
| "Why..." / "Reason..." | HYBRID | Yes | Yes | Yes |
| "Show / Find / List / Trace..." | SQL | Yes | No | Yes |
| Gibberish / no intent | Blocked | No | No | No |

---

## QUICK REFERENCE — CONFIDENCE SCORE

| Condition | Score change |
|---|---|
| Base | 1.00 |
| RAG query | Always 1.00 |
| Aggregation (GROUP BY / COUNT) | -0.10 |
| Fallback JOIN applied | -0.20 |
| Zero rows returned | -0.40 |
| Minimum possible | 0.00 |
