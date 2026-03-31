# System Design — O2C Insight Engine

## Problem Statement

Build a system where users ask natural language questions about business data and receive SQL-backed answers with interactive graph visualizations. The system must:
- Support any dataset (not just SAP O2C)
- Isolate each user's data completely
- Run on zero-cost infrastructure
- Work reliably even when LLM providers fail

---

## Design Decisions

### 1. Why SQLite over PostgreSQL?

| Factor | SQLite | PostgreSQL |
|--------|--------|------------|
| Setup | Zero config | Requires server |
| Cost | Free (file-based) | Free tier limited |
| Per-tenant isolation | One DB per tenant (Turso) | Schema-per-tenant or tenant_id column |
| Vector search | Turso native (F32_BLOB + DiskANN) | Requires pgvector extension |
| Deployment | Works on Render free tier | Needs separate DB service |

**Decision:** SQLite via Turso — each tenant gets a cloud SQLite database with native vector search. Zero cost, zero ops.

### 2. Why 5 LLM Providers?

Free-tier API keys have aggressive rate limits (20-40 RPM). A single provider would fail under sustained use. With 5 providers and health-based ordering:
- If Provider 1 is rate-limited → Provider 2 catches it in <1s
- All 5 fail → keyword-to-table fallback SQL (no LLM needed)
- All fallbacks fail → return suggested queries

**Result:** System never returns an empty error. Always degrades gracefully.

### 3. Why Local Embeddings?

Paid embedding APIs (OpenAI, Cohere) cost money per request. HuggingFace Transformers.js runs Xenova/all-MiniLM-L6-v2 directly on the server:
- 384-dimension vectors
- ~80MB model (downloads once, cached)
- Zero API cost
- Works offline

### 4. Why JWT over Sessions?

| Factor | JWT | Sessions |
|--------|-----|----------|
| State | Stateless (token contains all info) | Requires session store (Redis) |
| Cost | Zero (token stored client-side) | Redis costs money |
| Scaling | Works across multiple servers | Needs shared session store |
| Simplicity | One middleware function | Session management + cleanup |

**Decision:** JWT with bcrypt password hashing. Token contains `{ email, tenantId }`, expires in 30 days.

### 5. Why Not a Graph Database?

| Factor | SQLite | Neo4j/Graph DB |
|--------|--------|----------------|
| Cost | Free | Requires hosting |
| Data format | Raw JSONL maps directly to tables | Requires ETL to graph model |
| Query generation | LLM generates SQL (well-documented) | LLM generates Cypher (less common) |
| Joins | 18+ indexes make multi-hop JOINs fast (~3-6ms) | Native traversals |

**Decision:** SQLite with targeted indexes. Graph visualization is computed at response time from SQL results — the data doesn't need to be stored as a graph.

---

## Data Flow

```
User Question
    │
    ▼
┌──────────────────────────────────────────────────────┐
│                   API Layer                           │
│  Auth Middleware (JWT) → Tenant Resolver (req.db)    │
└──────────────────────┬───────────────────────────────┘
                       │
    ┌──────────────────▼──────────────────┐
    │          Query Pipeline              │
    │                                      │
    │  1. Cache Check (tenant-scoped)      │
    │  2. Query Classification             │
    │     └─ SQL / RAG / HYBRID / INVALID  │
    │  3. Complexity Scoring               │
    │     └─ SIMPLE / MODERATE / COMPLEX   │
    │  4. Guardrails (intent + domain)     │
    │  5. SQL Generation (5 LLM providers) │
    │  6. SQL Validation (13 layers)       │
    │  7. Execution (tenant's Turso DB)    │
    │  8. Graph Extraction                 │
    │  9. NL Answer Generation             │
    │  10. Response Assembly               │
    └──────────────────┬──────────────────┘
                       │
    ┌──────────────────▼──────────────────┐
    │           Response                   │
    │  NL Answer + Graph + Metadata        │
    └─────────────────────────────────────┘
```

---

## Failure Modes

| Failure | Detection | Recovery |
|---------|-----------|----------|
| LLM timeout (45s) | AbortController | Next provider in health order |
| All LLMs fail | Provider loop exhausted | Keyword-to-table fallback SQL |
| Fallback SQL fails | Execution error | Return suggested queries |
| SQL injection attempt | 13-layer validation | Block before execution |
| Zero rows returned | rowCount === 0 | JOIN relaxation → semantic status |
| Turso DB unavailable | Connection error | Fall back to global SQLite |
| Tenant not initialized | initialized === false | Use global SQLite until ready |
| Invalid JWT | jwt.verify fails | Return 401 |
| Document embedding fails | Catch in upload | Return error, data not lost |

---

## Capacity Planning (Free Tier)

| Resource | Limit | Usage per User |
|----------|-------|----------------|
| Turso databases | 500 | 1 per user + 1 auth DB |
| Turso storage | 9 GB | ~2 MB per user (21K rows) |
| Turso reads | 25M/month | ~100 reads per query |
| LLM requests | ~150 RPM (combined) | 2 per query (SQL + NL answer) |
| Render RAM | 512 MB | ~200 MB (Node + embedding model) |
| Render disk | Ephemeral | Global SQLite only (tenant data in Turso) |

**Max concurrent users:** ~250 (limited by Turso DB count)
**Max queries/minute:** ~75 (limited by LLM rate limits)

---

## Security Model

| Layer | Protection |
|-------|-----------|
| **Authentication** | bcrypt password hashing + JWT tokens |
| **Authorization** | Tenant isolation — each user's DB is separate |
| **Input validation** | 5-500 char limit, no raw SQL allowed |
| **SQL safety** | 13-layer validation (blocklist, SELECT-only, no subqueries in JOINs) |
| **Rate limiting** | 50 requests/minute per IP |
| **CORS** | Whitelist-based origin checking |
| **Headers** | Helmet.js security headers |
| **Data isolation** | Per-tenant Turso cloud DB (no shared tables) |
