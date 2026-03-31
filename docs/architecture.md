# Architecture — O2C Insight Engine

## Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              CLIENT                                     │
│  React + Vite + Cytoscape.js                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                 │
│  │ Auth Screen   │  │ Chat Panel   │  │ Graph Panel  │                 │
│  │ Login/Register│  │ NL Query     │  │ Cytoscape.js │                 │
│  └──────┬───────┘  └──────┬───────┘  └──────────────┘                 │
│         │                  │   Authorization: Bearer <JWT>              │
└─────────┼──────────────────┼───────────────────────────────────────────┘
          │                  │
          ▼                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           SERVER (Node.js + Express)                    │
│                                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │ Auth         │  │ Tenant       │  │ Query        │                  │
│  │ Middleware   │──▶│ Resolver     │──▶│ Pipeline     │                  │
│  │ (JWT verify) │  │ (req.db)     │  │ (classify →  │                  │
│  └─────────────┘  └──────────────┘  │  generate →   │                  │
│                                      │  validate →   │                  │
│                                      │  execute →    │                  │
│                                      │  graph)       │                  │
│                                      └──────┬───────┘                  │
│                                             │                           │
│  ┌──────────────────────────────────────────┼──────────────────────┐   │
│  │                    DATA LAYER             │                      │   │
│  │                                           │                      │   │
│  │  ┌───────────┐  ┌────────────┐  ┌────────▼───────┐             │   │
│  │  │ Auth DB    │  │ Global     │  │ Tenant DBs     │             │   │
│  │  │ (Turso)   │  │ SQLite     │  │ (Turso cloud)  │             │   │
│  │  │           │  │ (fallback) │  │                 │             │   │
│  │  │ users     │  │ sap_otc.db │  │ o2c-{tenant}   │             │   │
│  │  └───────────┘  └────────────┘  │ ┌─────────────┐│             │   │
│  │                                  │ │ 19 tables   ││             │   │
│  │  ┌───────────┐                  │ │ documents   ││             │   │
│  │  │ LLM       │                  │ │ doc_chunks  ││             │   │
│  │  │ Providers  │                  │ │ F32_BLOB    ││             │   │
│  │  │ (5x)      │                  │ │ DiskANN idx ││             │   │
│  │  └───────────┘                  │ └─────────────┘│             │   │
│  │                                  └────────────────┘             │   │
│  └─────────────────────────────────────────────────────────────────┘   │
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

### Backend (`src/`)

| Layer | Files | Responsibility |
|-------|-------|----------------|
| **Auth** | `auth/authDb.js`, `auth/authRoutes.js`, `auth/authMiddleware.js` | User registration, login, JWT verification |
| **Middleware** | `middleware/tenantResolver.js` | Resolve JWT → tenant DB + config |
| **Query Pipeline** | `query/queryService.js` | Orchestrate: classify → generate → validate → execute → format |
| **Classification** | `query/queryClassifier.js`, `query/complexityClassifier.js` | SQL/RAG/HYBRID/INVALID + SIMPLE/MODERATE/COMPLEX |
| **LLM** | `query/llmClient.js`, `query/promptBuilder.js` | 5-provider routing, schema-aware prompts |
| **Validation** | `query/validator.js` | 13-layer SQL safety checks |
| **Execution** | `query/sqlExecutor.js` | Parameterized query execution with timing |
| **Graph** | `query/graphExtractor.js` | SQL rows → Cytoscape nodes + edges |
| **RAG** | `rag/knowledgeBase.js`, `rag/vectorStore.js`, `rag/embeddingService.js` | Document upload, chunking, embedding, vector search |
| **Onboarding** | `onboarding/schemaInference.js`, `onboarding/relationshipInference.js`, `onboarding/configGenerator.js` | Auto-detect schema + relationships from uploaded files |
| **Database** | `db/connection.js`, `db/tursoAdapter.js`, `db/tenantRegistry.js`, `db/init.js`, `db/loader.js` | SQLite + Turso connections, schema init, data loading |
| **Routes** | `routes/queryRoutes.js`, `routes/documentRoutes.js`, `routes/tenantRoutes.js` | REST API endpoints |

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
│   └── users (id, email, password_hash, tenant_id, created_at)
│
├── o2c-{tenant-uuid-1} (User A's data)
│   ├── 19 SAP tables (or uploaded dataset tables)
│   ├── documents (id, title, filename, ...)
│   └── document_chunks (id, text, embedding F32_BLOB(384), ...)
│       └── DiskANN index: chunk_vec_idx
│
├── o2c-{tenant-uuid-2} (User B's data)
│   ├── Different dataset (user uploaded CSV)
│   ├── documents
│   └── document_chunks
│
└── ... (up to 500 tenants on free tier)

Render (ephemeral)
└── sap_otc.db (global SQLite — dev/tests fallback)
    ├── 19 default SAP O2C tables
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
  ├─ OpenRouter (llama-3.1-70b-instruct)
  │    └─ Score: 100 base + success/failure adjustments
  │
  └─ SambaNova (llama-3.1-8b / Qwen3-32B / llama-3.3-70b)
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
| **Backend** | Node.js + Express | Single language (JS everywhere) |
| **Database** | Turso (LibSQL) | Cloud SQLite with native vector search |
| **Auth** | bcrypt + JWT | Stateless, zero infra |
| **Embeddings** | HuggingFace Transformers.js | Local, free, 384-dim |
| **LLM** | 5 free-tier providers | Redundancy, zero cost |
| **Deployment** | Render | Free tier, auto-deploy from GitHub |
| **Vector Search** | Turso F32_BLOB + DiskANN | Native indexed search, no extensions |
