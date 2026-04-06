# Architecture — O2C Insight Engine

## Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              CLIENT                                     │
│  React + Vite + Cytoscape.js                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                 │
│  │ Auth Screen   │  │ Chat Panel   │  │ Graph Panel  │                 │
│  │ Login/Register│  │ NL Query     │  │ Cytoscape.js │                 │
│  │ Team Switcher │  │ Workspace    │  │              │                 │
│  └──────┬───────┘  └──────┬───────┘  └──────────────┘                 │
│         │                  │   Authorization: Bearer <JWT>              │
└─────────┼──────────────────┼───────────────────────────────────────────┘
          │                  │
          ▼                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     SERVER (NestJS + TypeScript)                         │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    NestJS Modules (10)                            │  │
│  │                                                                   │  │
│  │  ┌─────────┐ ┌──────────┐ ┌─────────┐ ┌──────────┐ ┌─────────┐│  │
│  │  │  Auth   │ │  Tenant  │ │  Query  │ │  RAG     │ │  Team   ││  │
│  │  │ Module  │ │  Module  │ │  Module │ │  Module  │ │  Module ││  │
│  │  └────┬────┘ └────┬─────┘ └────┬────┘ └────┬─────┘ └────┬────┘│  │
│  │       │           │            │            │            │      │  │
│  │  ┌────┴────┐ ┌────┴─────┐ ┌───┴────┐ ┌────┴─────┐ ┌───┴────┐│  │
│  │  │ Onboard │ │ Dataset  │ │ Metrics│ │  DB      │ │ Health ││  │
│  │  │ Module  │ │ Module   │ │ Module │ │  Module  │ │ Module ││  │
│  │  └─────────┘ └──────────┘ └────────┘ └──────────┘ └────────┘│  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    INFRASTRUCTURE                                 │  │
│  │                                                                   │  │
│  │  ┌───────────┐  ┌────────────────┐  ┌───────────────────────┐   │  │
│  │  │ Redis     │  │ BullMQ Workers │  │ LLM Providers (5x)   │   │  │
│  │  │ Cache     │  │                │  │                       │   │  │
│  │  │ (5m TTL)  │  │ dataset-proc   │  │ NVIDIA, Cerebras,    │   │  │
│  │  │ fallback: │  │ embedding-gen  │  │ Groq, OpenAI GPT-4,    │   │  │
│  │  │ in-memory │  │ tenant-prov    │  │ Gemini Pro             │   │  │
│  │  └───────────┘  └────────────────┘  └───────────────────────┘   │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    DATA LAYER                                     │  │
│  │                                                                   │  │
│  │  ┌───────────┐  ┌────────────┐  ┌────────────────┐              │  │
│  │  │ Auth DB    │  │ Global     │  │ Tenant DBs     │              │  │
│  │  │ (Turso)   │  │ SQLite     │  │ (Turso cloud)  │              │  │
│  │  │           │  │ (fallback) │  │                 │              │  │
│  │  │ users     │  │ sap_otc.db │  │ o2c-{tenant}   │              │  │
│  │  │ orgs      │  │ (demo data)│  │ ┌─────────────┐│              │  │
│  │  └───────────┘  └────────────┘  │ │ user tables  ││              │  │
│  │                                  │ │ documents   ││              │  │
│  │                                  │ │ doc_chunks  ││              │  │
│  │                                  │ │ F32_BLOB    ││              │  │
│  │                                  │ │ DiskANN idx ││              │  │
│  │                                  │ └─────────────┘│              │  │
│  │                                  └────────────────┘              │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Component Map

### Frontend (`frontend/src/`)

| Component | File | Responsibility |
|-----------|------|----------------|
| Auth Screen | `App.jsx` (AuthScreen) | Login/Register form, JWT storage |
| Chat Panel | `App.jsx` | Query input, conversation history, NL answers |
| Graph Panel | `App.jsx` | Cytoscape.js visualization, node tooltips |
| Upload Modal | `App.jsx` | Config upload, raw data wizard, document management |
| Team Switcher | `App.jsx` | Personal/team workspace switching, invite codes |

### Backend (`src/`) — NestJS + TypeScript (10 Modules)

| Module | Key Files | Responsibility |
|--------|-----------|----------------|
| **Auth** | `auth/auth.module.ts`, `auth.service.ts`, `auth.controller.ts`, `auth.guard.ts` | User registration, login, JWT verification |
| **Tenant** | `tenant/tenant.module.ts`, `tenant.service.ts`, `tenant.controller.ts` | Resolve JWT → tenant DB + config, tenant provisioning |
| **Query** | `query/query.module.ts`, `query.service.ts`, `query.controller.ts` | Orchestrate: classify → generate → validate → execute → format |
| **Classification** | (part of Query module) `query-classifier.service.ts`, `complexity-classifier.service.ts` | SQL/RAG/HYBRID/INVALID + SIMPLE/MODERATE/COMPLEX |
| **LLM** | (part of Query module) `llm-client.service.ts`, `prompt-builder.service.ts` | 5-provider routing, schema-aware prompts |
| **Validation** | (part of Query module) `validator.service.ts` | 13-layer SQL safety checks |
| **Graph** | (part of Query module) `graph-extractor.service.ts` | SQL rows → Cytoscape nodes + edges |
| **RAG** | `rag/rag.module.ts`, `knowledge-base.service.ts`, `vector-store.service.ts`, `embedding.service.ts` | Document upload, chunking, embedding, vector search |
| **Onboarding** | `onboarding/onboarding.module.ts`, `schema-inference.service.ts`, `relationship-inference.service.ts` | Auto-detect schema + relationships from uploaded files |
| **Database** | `db/db.module.ts`, `connection.service.ts`, `turso-adapter.service.ts`, `tenant-registry.service.ts` | SQLite + Turso connections, schema init, data loading |
| **Team** | `team/team.module.ts`, `team.service.ts`, `team.controller.ts` | Organizations, invite codes, personal/team workspace switching |
| **Metrics** | `metrics/metrics.module.ts`, `metrics.service.ts`, `metrics.controller.ts` | Uptime, cache stats, latency P50/P95/P99 via `GET /api/metrics` |
| **Dataset** | `dataset/dataset.module.ts`, `dataset.service.ts`, `dataset.controller.ts` | Dataset upload, config management, raw data wizard |
| **Health** | `health/health.module.ts`, `health.controller.ts` | Health check endpoints |

---

## Request Lifecycle

```
1. HTTP Request arrives
        │
2. Auth Middleware
   ├─ Exempt route (/health, /auth)? → skip auth
   ├─ Has Authorization header? → verify JWT → extract tenantId
   └─ No header? → 401 Unauthorized
        │
3. Tenant Resolver
   ├─ Tenant registered + initialized? → use Turso DB
   ├─ Tenant registered + NOT initialized? → use global SQLite
   └─ Tenant not registered? → use global SQLite
        │
4. Route Handler
   ├─ POST /api/query → Query Pipeline
   ├─ POST /api/documents/upload → RAG Pipeline
   ├─ POST /api/dataset/upload/raw → Onboarding Pipeline
   └─ GET /api/dataset → Return tenant's active config
        │
5. Response
   └─ JSON with NL answer + graph + metadata
```

---

## Database Architecture

```
Turso Cloud (aws-ap-south-1)
├── o2c-auth (shared)
│   └── users (id, email, password_hash, tenant_id, org_id, created_at)
│   └── organizations (id, name, invite_code, owner_id, created_at)
│
├── o2c-{tenant-uuid-1} (User A's data)
│   ├── Uploaded dataset tables (any schema)
│   ├── documents (id, title, filename, ...)
│   └── document_chunks (id, text, embedding F32_BLOB(384), ...)
│       └── DiskANN index: chunk_vec_idx
│
├── o2c-{tenant-uuid-2} (User B's data / Team workspace)
│   ├── Different dataset (user uploaded CSV)
│   ├── documents
│   └── document_chunks
│
└── ... (up to 500 tenants on starter plan)

Redis (Cache-Aside)
├── query:{hash} → cached query results (5-min TTL)
├── schema:{tenantId} → cached schema metadata
└── Graceful fallback → in-memory cache if Redis unavailable

Azure (ephemeral)
└── sap_otc.db (global SQLite — dev/tests fallback)
    ├── 19 demo SAP O2C tables (test dataset)
    ├── documents
    └── document_chunks
```

---

## LLM Provider Architecture

```
Query
  │
  ▼
Provider Health Sort (highest score first)
  │
  ├─ NVIDIA NIM (llama-3.1-8b / qwen2.5-coder-32b / llama-3.3-70b)
  │    └─ Score: 100 base + success/failure adjustments
  │
  ├─ Cerebras (llama3.1-8b / qwen-3-235b)
  │    └─ Score: 100 base + success/failure adjustments
  │
  ├─ Groq (llama-3.3-70b-versatile)
  │    └─ Score: 100 base + success/failure adjustments
  │
  ├─ OpenAI GPT-4 (gpt-4-turbo)
  │    └─ Score: 100 base + success/failure adjustments
  │
  └─ Gemini Pro (gemini-1.5-pro)
       └─ Score: 100 base + success/failure adjustments

Model Selection (per query):
  SIMPLE    → 8B parameter models (fast, cheap)
  MODERATE  → 32B parameter models (balanced)
  COMPLEX   → 70B+ parameter models (accurate)
```

---

## Vector Search Architecture

```
Document Upload:
  PDF/DOCX/TXT/MD → Extract Text → Chunk (500 chars, 50 overlap)
       │
       ▼
  Embed (Xenova/all-MiniLM-L6-v2, 384-dim, local)
       │
       ├─ Turso: INSERT with vector32() → F32_BLOB column
       └─ SQLite: INSERT as JSON text → TEXT column

Search (3-layer fallback):
  Query → Embed → Search
       │
       ├─ Layer 1: vector_top_k (DiskANN indexed, O(log n))
       ├─ Layer 2: vector_distance_cos (Turso native, brute-force)
       └─ Layer 3: In-memory JS cosine similarity (any DB)
```

---

## Technology Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| **Frontend** | React + Vite | Fast dev, optimized build |
| **Visualization** | Cytoscape.js | Industry-standard graph library |
| **Backend** | NestJS + TypeScript | Modular architecture, type safety, dependency injection |
| **Cache** | Redis (Cache-Aside, 5-min TTL) | Query result caching, graceful fallback to in-memory |
| **Job Queue** | BullMQ (3 workers) | dataset-processing, embedding-generation, tenant-provisioning |
| **Database** | Turso (LibSQL) | Cloud SQLite with native vector search |
| **Auth** | bcrypt + JWT | Stateless, zero infra |
| **Embeddings** | HuggingFace Transformers.js | Local, free, 384-dim |
| **LLM** | 3 affordable + 2 premium providers | Redundancy, cost-optimized routing |
| **Deployment** | Azure App Service | Auto-deploy from GitHub |
| **Vector Search** | Turso F32_BLOB + DiskANN | Native indexed search, no extensions |
| **Metrics** | GET /api/metrics | Uptime, cache hit/miss, latency P50/P95/P99 |
