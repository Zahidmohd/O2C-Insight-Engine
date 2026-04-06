# High-Level Design (HLD) — O2C Insight Engine

## 1. System Context

```
┌─────────┐         ┌───────────────────┐         ┌──────────────┐
│  User   │────────▶│  O2C Insight      │────────▶│  LLM APIs    │
│ (Browser)│◀────────│  Engine           │◀────────│  (5 providers)│
└─────────┘  HTTPS  │  (NestJS/TS)      │  HTTPS  └──────────────┘
                     │  (Render)         │
                     │                   │────────▶┌──────────────┐
                     │                   │◀────────│  Turso Cloud │
                     │                   │  HTTPS  │  (SQLite DBs)│
                     │                   │         └──────────────┘
                     │                   │
                     │                   │────────▶┌──────────────┐
                     │                   │◀────────│  Redis       │
                     └───────────────────┘         │  (Cache)     │
                                                    └──────────────┘
```

**Actors:**
- **User** — asks natural language questions via browser
- **LLM APIs** — generate SQL from NL queries and NL answers from SQL results
- **Turso Cloud** — stores per-tenant data, documents, embeddings, and auth credentials
- **Redis** — query result cache (Cache-Aside pattern, 5-min TTL, graceful fallback to in-memory)

---

## 2. Functional Requirements

| # | Requirement | Implementation |
|---|------------|----------------|
| F1 | Users can ask questions in natural language | Query pipeline: NL → SQL → Execute → NL Answer |
| F2 | Results shown as interactive graph | Cytoscape.js visualization from SQL rows |
| F3 | Users can upload their own datasets | CSV/JSONL/ZIP upload wizard with schema inference |
| F4 | Users can upload documents for RAG | PDF/DOCX/TXT → chunk → embed → vector search |
| F5 | Each user's data is isolated | Per-tenant Turso cloud database |
| F6 | Users authenticate with email/password | bcrypt + JWT, shared Turso auth DB |
| F7 | System works when LLMs fail | 5-provider failover → fallback SQL → suggestions |
| F8 | System adapts to any dataset | Config-driven prompts, classification, graph extraction |
| F9 | Team collaboration | Organizations with invite codes, personal/team workspace switching |
| F10 | Observability | GET /api/metrics — uptime, cache stats, latency P50/P95/P99 |

---

## 3. Non-Functional Requirements

| # | Requirement | Target | Actual |
|---|------------|--------|--------|
| NF1 | Cost | $0/month | Achieved (all free tier) |
| NF2 | Query latency | <10s | 2-8s (LLM dependent) |
| NF3 | SQL execution time | <100ms | 0.2-80ms (SQLite) / 50-200ms (Turso) |
| NF4 | Availability | 99%+ | 5 LLM providers + multi-layer fallback |
| NF5 | Concurrent users | 250+ | Limited by Turso DB count (500) |
| NF6 | Data isolation | Complete | Separate Turso DB per tenant |
| NF7 | Security | OWASP compliant | 13-layer SQL validation + auth + CORS |

---

## 4. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     PRESENTATION LAYER                        │
│                                                               │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────┐ │
│  │ Auth Screen  │  │ Query Chat  │  │ Graph Visualization  │ │
│  │ Login/SignUp │  │ NL Input    │  │ Cytoscape.js         │ │
│  │ Team Switch  │  │ NL Answer   │  │ Node Tooltips        │ │
│  │             │  │ Badges      │  │ Edge Labels          │ │
│  └─────────────┘  └─────────────┘  └──────────────────────┘ │
└──────────────────────────┬───────────────────────────────────┘
                           │ HTTPS (JWT in Authorization header)
┌──────────────────────────▼───────────────────────────────────┐
│               APPLICATION LAYER (NestJS + TypeScript)         │
│                        10 Modules                             │
│                                                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐│
│  │ Auth     │  │ Tenant   │  │ Query    │  │ RAG          ││
│  │ Module   │  │ Module   │  │ Module   │  │ Module       ││
│  │          │  │          │  │          │  │              ││
│  │ register │  │ resolve  │  │ classify │  │ upload doc   ││
│  │ login    │  │ provision│  │ generate │  │ chunk        ││
│  │ verify   │  │ isolate  │  │ validate │  │ embed        ││
│  │          │  │          │  │ execute  │  │ search       ││
│  └──────────┘  └──────────┘  │ explain  │  └──────────────┘│
│                               │ graph    │                   │
│  ┌──────────┐  ┌──────────┐  └──────────┘  ┌──────────────┐│
│  │ Team     │  │ Metrics  │  ┌──────────┐  │ Dataset      ││
│  │ Module   │  │ Module   │  │ Onboard  │  │ Module       ││
│  │          │  │          │  │ Module   │  │              ││
│  │ orgs     │  │ uptime   │  │          │  │ upload       ││
│  │ invite   │  │ cache    │  │ infer    │  │ config       ││
│  │ switch   │  │ latency  │  │ detect   │  │ manage       ││
│  └──────────┘  └──────────┘  └──────────┘  └──────────────┘│
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│                   INFRASTRUCTURE LAYER                         │
│                                                               │
│  ┌──────────────┐  ┌────────────────┐                        │
│  │ Redis Cache  │  │ BullMQ Workers │                        │
│  │ Cache-Aside  │  │                │                        │
│  │ 5-min TTL    │  │ dataset-proc   │                        │
│  │ fallback:    │  │ embedding-gen  │                        │
│  │ in-memory    │  │ tenant-prov    │                        │
│  └──────────────┘  └────────────────┘                        │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│                      DATA LAYER                               │
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │ Auth DB      │  │ Tenant DBs   │  │ LLM Providers      │ │
│  │ (Turso)      │  │ (Turso x N)  │  │                    │ │
│  │              │  │              │  │ NVIDIA  ──┐         │ │
│  │ users table  │  │ data tables  │  │ Cerebras ─┤ Health  │ │
│  │ orgs table   │  │ documents    │  │ Groq   ───┤ Scored  │ │
│  │              │  │ doc_chunks   │  │ OpenAI GPT-4┤ Ordered │ │
│  │              │  │ (F32_BLOB)   │  │ Gemini Pro─┘         │ │
│  └──────────────┘  └──────────────┘  └────────────────────┘ │
│                                                               │
│  ┌──────────────┐                                            │
│  │ Global SQLite│  (dev/tests fallback — ephemeral on Render)│
│  │ sap_otc.db   │  (demo SAP O2C data)                      │
│  └──────────────┘                                            │
└──────────────────────────────────────────────────────────────┘
```

---

## 5. Key Design Patterns

### 5.1 Adapter Pattern (Database)
Both SQLite (better-sqlite3) and Turso (@libsql/client) expose the same async interface via NestJS services:
```
allAsync(sql, params) → rows[]
runAsync(sql, params) → { lastInsertRowid, changes }
getAsync(sql, params) → row | undefined
execAsync(sql) → void
batchWrite(statements) → void
```
All downstream code works with either adapter — no conditional logic in business code. The Redis cache service also follows this pattern with graceful fallback to in-memory when Redis is unavailable.

### 5.2 Strategy Pattern (LLM Routing)
Query complexity determines model size:
- SIMPLE → 8B models (fast)
- MODERATE → 32B models (balanced)
- COMPLEX → 70B+ models (accurate)

Provider selection is health-score based — the healthiest provider is always tried first.

### 5.3 Chain of Responsibility (Query Validation)
13 validation layers in sequence — any layer can reject:
```
Comment strip → SELECT-only → Multi-statement → Blocklist → SQLite functions →
Subquery in JOIN → Length limit → LIMIT enforcement → Execution timeout → ...
```

### 5.4 Fallback Chain (Degradation)
```
LLM SQL → Next Provider → ... → Fallback SQL → Suggested Queries
```
```
vector_top_k → vector_distance_cos → In-memory cosine → Keyword KB
```

### 5.5 Progressive Disclosure (UI)
Default view shows only the answer + minimal badges. "View details" expands query plan, performance metrics, data sources. Keeps UI clean for non-technical users.

### 5.6 Cache-Aside Pattern (Redis)
Query results are cached in Redis with 5-minute TTL. On cache miss, the full pipeline runs and the result is stored. If Redis is unavailable, the system falls back to an in-memory LRU cache transparently. This avoids redundant LLM calls for repeated queries.

### 5.7 Worker Queue Pattern (BullMQ)
Long-running operations are offloaded to BullMQ workers backed by Redis:
- **dataset-processing** — parse, validate, and load uploaded datasets
- **embedding-generation** — chunk documents and generate embeddings
- **tenant-provisioning** — create and initialize Turso databases

---

## 6. Scalability Path

| Current (Free Tier) | Next Step | Full Scale |
|---------------------|-----------|------------|
| 500 Turso DBs | Turso paid ($9/month, unlimited) | PostgreSQL + pgvector |
| 5 free LLM providers | Paid API keys (higher limits) | Self-hosted LLM |
| UUID auth + Team Mode | Add OAuth (GitHub, Google) | Full IAM |
| Render free tier | Render paid ($7/month) | Kubernetes |
| In-process embedding | Dedicated embedding service | GPU-accelerated |
| JSON tenants.json | Turso registry table | Distributed registry |
| Redis free tier | Redis paid (larger cache) | Redis Cluster |
| BullMQ (3 workers) | Horizontal worker scaling | Dedicated job servers |

---

## 7. Trade-offs

| Decision | Benefit | Cost |
|----------|---------|------|
| NestJS + TypeScript (not Express + JS) | Modular architecture, type safety, DI | Steeper learning curve, more boilerplate |
| Per-tenant DB (not shared tables) | Complete isolation, simple queries | More DBs, slower provisioning |
| Redis Cache-Aside (not write-through) | Simple invalidation, graceful fallback | Stale data for up to 5 minutes |
| BullMQ workers (not in-process) | Non-blocking uploads, reliable retries | Redis dependency, operational complexity |
| Team Mode with invite codes | Simple org onboarding, no email infra | Limited to code-based invitations |
| Local embeddings (not API) | Zero cost, no external dependency | 80MB model download on first use |
| 5 LLM providers (not 1) | High availability | Complex health tracking |
| SQLite (not PostgreSQL) | Zero config, free | No concurrent writes |
| JWT (not sessions) | Stateless, scalable | No server-side revocation |
| Background tenant init | Non-blocking registration | 30-60s before Turso is ready |
| Global SQLite fallback | Instant queries during init | Data in two places temporarily |

---

## 8. Deployment Topology

```
GitHub Repository
       │
       │ git push
       ▼
Render (Auto-deploy)
┌─────────────────────────┐
│ Build: npm install &&   │
│        npm run build    │
│                         │
│ Start: node dist/main.js│
│  (NestJS compiled TS)   │
│                         │
│ Env vars:               │
│  GROQ_API_KEY           │
│  NVIDIA_API_KEY         │
│  CEREBRAS_API_KEY       │
│  OPENAI_API_KEY     │
│  GEMINI_API_KEY      │
│  TURSO_API_TOKEN        │
│  TURSO_ORG_SLUG         │
│  JWT_SECRET             │
│  REDIS_URL              │
└────────────┬────────────┘
             │
     ┌───────┼───────┬──────────┐
     │       │       │          │
     ▼       ▼       ▼          ▼
  Turso   Turso   Turso      Redis
  Auth DB  User A  User B    (Cache +
  (shared) (data)  (data)    BullMQ)
```
