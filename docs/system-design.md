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

### 4. Why NestJS over Express?

| Factor | NestJS | Express |
|--------|--------|---------|
| Architecture | Modular (10 feature modules) | Flat route files |
| Type safety | TypeScript-first, decorators, DTOs | Requires manual typing |
| Dependency injection | Built-in DI container | Manual wiring |
| Testability | Module isolation, easy mocking | Requires test setup |
| Code organization | Enforced module boundaries | Convention-dependent |
| Middleware | Guards, interceptors, pipes | Middleware functions |

**Decision:** NestJS with TypeScript. The codebase grew to 10 modules (Auth, Tenant, Query, RAG, Team, Metrics, Onboarding, Dataset, DB, Health). NestJS's module system keeps each concern isolated with clear dependency boundaries. Entry point is `main.ts`.

### 5. Why JWT over Sessions?

| Factor | JWT | Sessions |
|--------|-----|----------|
| State | Stateless (token contains all info) | Requires session store |
| Cost | Zero (token stored client-side) | Additional infra |
| Scaling | Works across multiple servers | Needs shared session store |
| Simplicity | One guard function | Session management + cleanup |

**Decision:** JWT with bcrypt password hashing. Token contains `{ email, tenantId }`, expires in 30 days.

### 6. Why Redis for Caching?

| Factor | Redis | In-Memory Only |
|--------|-------|----------------|
| Persistence | Survives restarts | Lost on deploy |
| Shared state | Works across workers | Per-process only |
| TTL management | Native TTL support | Manual expiry |
| BullMQ backing | Required for job queues | Not compatible |

**Decision:** Redis with Cache-Aside pattern (5-minute TTL). Graceful fallback to in-memory LRU cache if Redis is unavailable. This means the system works even without Redis — it just loses cache persistence.

### 7. Why BullMQ for Background Jobs?

| Factor | BullMQ | In-Process |
|--------|--------|------------|
| Reliability | Retries, dead-letter queues | Lost on crash |
| Concurrency | Rate-limited workers | Blocks event loop |
| Observability | Job status, progress tracking | Console logs only |
| Scaling | Add workers independently | Scale entire server |

**Decision:** 3 BullMQ workers backed by Redis:
- **dataset-processing** — parse and load uploaded CSV/JSONL/ZIP files
- **embedding-generation** — chunk documents and generate vector embeddings
- **tenant-provisioning** — create and initialize Turso databases

### 8. Why Not a Graph Database?

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
│             API Layer (NestJS Guards + Pipes)         │
│  Auth Guard (JWT) → Tenant Resolver (req.db)         │
└──────────────────────┬───────────────────────────────┘
                       │
    ┌──────────────────▼──────────────────┐
    │   Redis Cache Check (Cache-Aside)    │
    │   Hit? → Return cached result        │
    │   Miss? ↓                            │
    └──────────────────┬──────────────────┘
                       │
    ┌──────────────────▼──────────────────┐
    │          Query Pipeline              │
    │                                      │
    │  1. Query Classification             │
    │     └─ SQL / RAG / HYBRID / INVALID  │
    │  2. Complexity Scoring               │
    │     └─ SIMPLE / MODERATE / COMPLEX   │
    │  3. Guardrails (intent + domain)     │
    │  4. SQL Generation (5 LLM providers) │
    │  5. SQL Validation (13 layers)       │
    │  6. Execution (tenant's Turso DB)    │
    │  7. Graph Extraction                 │
    │  8. NL Answer Generation             │
    │  9. Response Assembly                │
    │  10. Cache Store (5-min TTL)         │
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
| Redis unavailable | Connection error | Graceful fallback to in-memory cache |
| BullMQ job fails | Worker error handler | Automatic retry with backoff |

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
| Redis memory | ~25 MB (free tier) | ~1 KB per cached query result |

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
| **Team isolation** | Organization-scoped workspaces with invite-code access |
