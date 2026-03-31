# High-Level Design (HLD) — O2C Insight Engine

## 1. System Context

```
┌─────────┐         ┌───────────────────┐         ┌──────────────┐
│  User   │────────▶│  O2C Insight      │────────▶│  LLM APIs    │
│ (Browser)│◀────────│  Engine           │◀────────│  (5 providers)│
└─────────┘  HTTPS  │  (Render)         │  HTTPS  └──────────────┘
                     │                   │
                     │                   │────────▶┌──────────────┐
                     │                   │◀────────│  Turso Cloud │
                     └───────────────────┘  HTTPS  │  (SQLite DBs)│
                                                    └──────────────┘
```

**Actors:**
- **User** — asks natural language questions via browser
- **LLM APIs** — generate SQL from NL queries and NL answers from SQL results
- **Turso Cloud** — stores per-tenant data, documents, embeddings, and auth credentials

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
│  └─────────────┘  │ NL Answer   │  │ Node Tooltips        │ │
│                    │ Badges      │  │ Edge Labels          │ │
│                    └─────────────┘  └──────────────────────┘ │
└──────────────────────────┬───────────────────────────────────┘
                           │ HTTPS (JWT in Authorization header)
┌──────────────────────────▼───────────────────────────────────┐
│                     APPLICATION LAYER                         │
│                                                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐│
│  │ Auth     │  │ Tenant   │  │ Query    │  │ RAG          ││
│  │ Service  │  │ Service  │  │ Service  │  │ Service      ││
│  │          │  │          │  │          │  │              ││
│  │ register │  │ resolve  │  │ classify │  │ upload doc   ││
│  │ login    │  │ provision│  │ generate │  │ chunk        ││
│  │ verify   │  │ isolate  │  │ validate │  │ embed        ││
│  │          │  │          │  │ execute  │  │ search       ││
│  └──────────┘  └──────────┘  │ explain  │  └──────────────┘│
│                               │ graph    │                   │
│                               └──────────┘                   │
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
│  │              │  │ documents    │  │ Groq   ───┤ Scored  │ │
│  │              │  │ doc_chunks   │  │ OpenRouter┤ Ordered │ │
│  │              │  │ (F32_BLOB)   │  │ SambaNova─┘         │ │
│  └──────────────┘  └──────────────┘  └────────────────────┘ │
│                                                               │
│  ┌──────────────┐                                            │
│  │ Global SQLite│  (dev/tests fallback — ephemeral on Render)│
│  │ sap_otc.db   │                                            │
│  └──────────────┘                                            │
└──────────────────────────────────────────────────────────────┘
```

---

## 5. Key Design Patterns

### 5.1 Adapter Pattern (Database)
Both SQLite (better-sqlite3) and Turso (@libsql/client) expose the same async interface:
```
allAsync(sql, params) → rows[]
runAsync(sql, params) → { lastInsertRowid, changes }
getAsync(sql, params) → row | undefined
execAsync(sql) → void
batchWrite(statements) → void
```
All downstream code works with either adapter — no conditional logic in business code.

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

---

## 6. Scalability Path

| Current (Free Tier) | Next Step | Full Scale |
|---------------------|-----------|------------|
| 500 Turso DBs | Turso paid ($9/month, unlimited) | PostgreSQL + pgvector |
| 5 free LLM providers | Paid API keys (higher limits) | Self-hosted LLM |
| UUID auth | Add OAuth (GitHub, Google) | Full IAM |
| Render free tier | Render paid ($7/month) | Kubernetes |
| In-process embedding | Dedicated embedding service | GPU-accelerated |
| JSON tenants.json | Turso registry table | Distributed registry |

---

## 7. Trade-offs

| Decision | Benefit | Cost |
|----------|---------|------|
| Per-tenant DB (not shared tables) | Complete isolation, simple queries | More DBs, slower provisioning |
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
│ Start: node src/db/     │
│        loader.js &&     │
│        node src/server.js│
│                         │
│ Env vars:               │
│  GROQ_API_KEY           │
│  NVIDIA_API_KEY         │
│  CEREBRAS_API_KEY       │
│  OPENROUTER_API_KEY     │
│  SAMBANOVA_API_KEY      │
│  TURSO_API_TOKEN        │
│  TURSO_ORG_SLUG         │
│  JWT_SECRET             │
└────────────┬────────────┘
             │
     ┌───────┼───────┐
     │       │       │
     ▼       ▼       ▼
  Turso   Turso   Turso
  Auth DB  User A  User B
  (shared) (data)  (data)
```
