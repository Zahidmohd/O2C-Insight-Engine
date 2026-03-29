# Query Architecture — Multi-Provider LLM Pipeline

> **Date:** 2026-03-30
> **Status:** Active
> **Dependencies:** [schema-design.md](./schema-design.md), [graph-model.md](./graph-model.md)

---

## 1. Overview

The query engine translates natural language questions into SQL, executes them against SQLite, and returns structured results with graph visualization. It uses a multi-provider LLM system with health tracking, automatic failover, and complexity-based routing.

```
User Query
    │
    ▼
┌─────────────────┐
│ Query Classifier │  ← Classifies: SQL / RAG / HYBRID / INVALID
└────────┬────────┘
         │
    ┌────▼────┐
    │  Router  │  ← Routes to SQL pipeline, RAG pipeline, or both
    └────┬────┘
         │
    ┌────▼─────────────┐
    │ Complexity Scorer │  ← SIMPLE / MODERATE / COMPLEX
    └────┬─────────────┘
         │
    ┌────▼──────────────┐
    │ Prompt Builder     │  ← Schema context + rules + examples
    └────┬──────────────┘
         │
    ┌────▼──────────────┐
    │ LLM Client         │  ← 5 providers, health-ordered
    └────┬──────────────┘
         │
    ┌────▼──────────────┐
    │ SQL Validator      │  ← Guardrails: injection, scope, syntax
    └────┬──────────────┘
         │
    ┌────▼──────────────┐
    │ SQL Executor       │  ← Execute + retry with relaxed JOINs
    └────┬──────────────┘
         │
    ┌────▼──────────────┐
    │ Graph Extractor    │  ← Build Cytoscape nodes/edges from results
    └────┬──────────────┘
         │
    ┌────▼──────────────┐
    │ Response Builder   │  ← Explanation, badges, suggestions
    └──────────────────┘
```

---

## 2. Multi-Provider LLM System

### 2.1 Providers

| Priority | Provider | Model | Rate Limit | Use Case |
|----------|----------|-------|------------|----------|
| 1 | NVIDIA NIM | `meta/llama-3.1-70b-instruct` | 40 RPM | Primary — fastest |
| 2 | Cerebras | `llama-3.3-70b` | 30 RPM | Secondary — fast inference |
| 3 | Groq | `llama-3.3-70b-versatile` | 30 RPM | Tertiary — reliable |
| 4 | OpenRouter | `meta-llama/llama-3.3-70b-instruct` | 200 RPD | Fallback — generous daily limit |
| 5 | SambaNova | `Meta-Llama-3.1-405B-Instruct` | 20 RPD | Last resort — largest model |

### 2.2 Health Tracking

Each provider maintains a health record:

```javascript
{
  successes: 0,    // Total successful calls
  failures: 0,     // Total failed calls
  lastSuccess: 0,  // Timestamp of last success
  lastFailure: 0,  // Timestamp of last failure
  lastError: '',   // Most recent error message
  avgLatency: 0,   // Running average response time (ms)
  lastLatency: 0   // Most recent response time (ms)
}
```

### 2.3 Dynamic Ordering Algorithm

Providers are scored and sorted before each request:

```
Score = (successRate × 40)
      + (recencyBonus × 30)          // Higher if last success is recent
      + (failurePenalty × 20)        // Lower if recently failed
      + (latencyBonus × 10)          // Lower latency = higher score
```

- New/unused providers start with base score 50
- Failed providers get exponential cooldown (longer wait before retry)
- Providers that repeatedly fail are deprioritized but never permanently disabled

### 2.4 Failover Chain

```
Provider 1 (best score)
    │ fail
    ▼
Provider 2
    │ fail
    ▼
Provider 3
    │ fail
    ▼
Provider 4
    │ fail
    ▼
Provider 5
    │ fail
    ▼
Fallback SQL (keyword-based, no LLM)
```

If all 5 providers fail, the engine generates a basic SQL query using keyword matching against table/column names.

---

## 3. Query Classification

### 3.1 Types

| Type | Description | Pipeline |
|------|-------------|----------|
| `SQL` | Answerable by database query | SQL generation → execution → graph |
| `RAG` | Domain knowledge question (no data lookup needed) | Knowledge base search → direct answer |
| `HYBRID` | Needs both data + domain knowledge | SQL + RAG combined |
| `INVALID` | Off-topic, harmful, or unanswerable | Rejected with explanation |

### 3.2 Classifier Logic

1. **Invalid check:** Prompt injection patterns, off-topic keywords, harmful intent
2. **RAG check:** Questions about concepts, definitions, processes (e.g., "What is O2C?")
3. **SQL check:** Questions referencing data, entities, counts, amounts, specific IDs
4. **Hybrid:** Both RAG and SQL signals detected

---

## 4. Complexity Classification

### 4.1 Levels

| Level | Criteria | Model Routing |
|-------|----------|---------------|
| `SIMPLE` | Single table, basic filter/count | Fast model preferred |
| `MODERATE` | 2-3 table joins, aggregation, grouping | Standard model |
| `COMPLEX` | 4+ tables, subqueries, multi-hop traversal | Best available model |

### 4.2 Scoring Factors

- Number of tables referenced (inferred from entity keywords)
- Aggregation keywords (SUM, COUNT, AVG, GROUP BY)
- Multi-hop keywords (trace, flow, end-to-end, journey)
- Comparison keywords (compare, vs, between, trend)
- Temporal keywords (month, year, quarter, period)

---

## 5. SQL Generation & Validation

### 5.1 Prompt Construction

The prompt includes:
1. **System role:** SQL expert for the active dataset
2. **Schema context:** Table names, columns, primary keys, relationships
3. **Domain rules:** Dataset-specific join rules (e.g., billing item padding for O2C)
4. **Examples:** Sample questions + correct SQL for the dataset
5. **User query:** The natural language question

### 5.2 Validation (13 Protection Layers)

| # | Check | Action |
|---|-------|--------|
| 1 | SQL injection patterns | Block |
| 2 | DDL statements (CREATE, DROP, ALTER) | Block |
| 3 | DML statements (INSERT, UPDATE, DELETE) | Block |
| 4 | Path traversal in identifiers | Block |
| 5 | System table access (sqlite_master) | Block |
| 6 | Semicolon-separated multi-statements | Block |
| 7 | Scope check (only tables in active config) | Block |
| 8 | SELECT-only enforcement | Block non-SELECT |
| 9 | Row limit injection (LIMIT 1000 max) | Modify |
| 10 | Subquery depth limit | Block if > 3 levels |
| 11 | Quoted identifier validation | Sanitize |
| 12 | Read-only DB connection | Enforce at DB level |
| 13 | Request timeout (30s) | Abort |

### 5.3 Execution & Retry

```
Execute SQL
    │ success → return results
    │ fail (no rows)
    ▼
Relax JOINs (INNER → LEFT)
    │ success → return results
    │ fail
    ▼
Return empty result with explanation
```

The JOIN relaxation step converts `JOIN` to `LEFT JOIN` for known high-drop tables (e.g., billing → delivery joins that may not have all items matched).

---

## 6. Graph Extraction

### 6.1 O2C-Specific Extraction

For the default SAP O2C dataset, the graph extractor uses hardcoded entity recognition:

- Detects SalesOrder, Delivery, BillingDocument, JournalEntry, Payment, Customer nodes
- Builds edges based on known O2C relationships (FULFILLED_BY, BILLED_AS, etc.)
- Extracts node IDs from SQL result columns using column name patterns

### 6.2 Generic Extraction

For user-onboarded datasets, the graph extractor:

- Reads relationships from the active dataset config
- For each row, checks both sides of each relationship for non-null values
- Creates nodes with `tableName_value` IDs and table displayName types
- Creates edges using relationship labels from the config
- Applies same MAX_NODES=200 limit, deduplication, and orphan removal

---

## 7. Dataset Onboarding

### 7.1 Config Upload (Original)

Users provide a JSON config file specifying:
- Table definitions (name, columns, primaryKey, directory)
- Relationships (from, to, joinType, label)
- Domain keywords, entity names, rules, examples

### 7.2 Raw Data Upload (New)

Users upload JSONL/CSV files and the system auto-generates a config:

```
Upload files (.jsonl/.csv)
    │
    ▼
Schema Inference
    ├── Detect format (JSONL vs CSV)
    ├── Parse records
    ├── Infer table names from filenames
    ├── Detect columns from record keys
    └── Identify primary key candidates (unique columns, *Id/*Key patterns)
    │
    ▼
Relationship Inference
    ├── Score column pairs across tables (name match, suffix pattern, value overlap)
    ├── Filter by confidence threshold (≥ 0.3)
    ├── Determine cardinality (1:1, 1:N, N:1, N:M)
    └── Deduplicate bidirectional matches
    │
    ▼
User Review (Frontend)
    ├── Step 1: Edit table names, columns, primary keys
    └── Step 2: Accept/reject relationships, set dataset name
    │
    ▼
Config Generation
    ├── Build full config object from approved schema + relationships
    ├── Auto-generate domain keywords from table/column names
    ├── Validate config → init DB → load data → set active
    └── Ready for querying
```

---

## 8. API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/query` | Natural language query → SQL → results |
| `GET` | `/api/dataset/info` | Active dataset metadata (tables, rows, name) |
| `POST` | `/api/dataset/upload` | Upload dataset config JSON |
| `POST` | `/api/dataset/upload/raw` | Upload raw JSONL/CSV files for onboarding |
| `POST` | `/api/dataset/upload/confirm` | Confirm schema + relationships, finalize dataset |
| `GET` | `/api/providers` | LLM provider health status |

### 8.1 Query Response Shape

```json
{
  "success": true,
  "query": "Show all sales orders",
  "sql": "SELECT * FROM sales_order_headers LIMIT 100",
  "results": [...],
  "rowCount": 100,
  "executionTime": 45,
  "explanation": "Retrieved all sales order headers...",
  "graphData": { "nodes": [...], "edges": [...] },
  "queryType": "SQL",
  "complexity": "SIMPLE",
  "plan": "RULE",
  "confidence": "HIGH",
  "suggestedQueries": [...]
}
```

---

## 9. RAG Knowledge Base

The knowledge base provides answers to domain questions without SQL:

- **Matching:** TF-IDF-style keyword scoring against knowledge entries
- **Threshold:** Minimum score required to return a RAG answer
- **Fallback:** If no match, the query is re-routed to SQL pipeline
- **Hybrid mode:** For HYBRID queries, both RAG answer and SQL results are combined

Knowledge entries are defined per dataset. The default O2C dataset includes entries about SAP concepts, O2C process flow, document types, and status codes.

---

## 10. Observability

### 10.1 Server Logging

Every query logs:
- Query text, classification, complexity
- Provider used, attempt number, latency
- SQL generated, row count, execution time
- Errors and fallback triggers

### 10.2 Frontend Indicators

- **Provider health dot:** Green (3+ healthy), Yellow (1-2 healthy), Red (0 healthy)
- **Active provider count:** "3/5 AI" in navbar
- **Response badges:** Query type, complexity, plan (RULE/LLM), confidence level
- **Suggestion chips:** Shown on INVALID_ID and LLM_UNAVAILABLE results

---

## 11. File Map

```
src/
├── query/
│   ├── queryService.js          ← Main orchestrator (classify → generate → validate → execute)
│   ├── llmClient.js             ← 5-provider LLM client with health tracking
│   ├── promptBuilder.js         ← Schema-aware prompt construction
│   ├── queryClassifier.js       ← SQL / RAG / HYBRID / INVALID classification
│   ├── complexityClassifier.js  ← SIMPLE / MODERATE / COMPLEX scoring
│   ├── graphExtractor.js        ← SQL results → Cytoscape graph (O2C + generic)
│   └── sqlExecutor.js           ← Execute SQL with retry + JOIN relaxation
├── rag/
│   └── knowledgeBase.js         ← Domain knowledge entries + matching
├── config/
│   └── datasetConfig.js         ← Active dataset config management
├── onboarding/
│   ├── schemaInference.js       ← Parse JSONL/CSV, infer tables + columns + PK
│   ├── relationshipInference.js ← Suggest relationships with confidence scores
│   └── configGenerator.js       ← Generate full config from approved schema
├── db/
│   ├── connection.js            ← SQLite connection factory
│   ├── schema.sql               ← CREATE TABLE + CREATE INDEX statements
│   └── loader.js                ← JSONL → SQLite ingestion with transforms
└── routes/
    └── queryRoutes.js           ← Express routes (query, upload, providers)
```
