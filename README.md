# O2C Insight Engine

**Dataset-agnostic natural language query platform.** Upload any structured dataset, ask questions in plain English, get SQL-backed answers with interactive graph visualizations. Ships with SAP Order-to-Cash as the included demo dataset.

---

## Key Features

- **Natural language to SQL** -- LLM generates, validates, and executes SQL from plain English queries
- **Interactive graph visualization** -- query results rendered as directed graphs (Cytoscape.js)
- **Dataset-agnostic** -- upload any CSV/JSONL/ZIP dataset via onboarding wizard; schema auto-inferred
- **Multi-provider LLM routing** -- 5 providers with health tracking, complexity-based model selection, automatic failover
- **Team mode** -- organizations with invite codes, shared workspaces, workspace switching (personal/team)
- **Redis caching** -- query response cache with TTL, tenant-scoped cache keys
- **BullMQ async queues** -- background job processing for dataset uploads and tenant provisioning
- **Document RAG** -- upload PDF/DOCX/TXT/MD, local embeddings (384-dim), vector search
- **13-layer security** -- query classification, SQL blocklist, read-only enforcement, rate limiting, JWT auth, tenant isolation
- **Observability** -- metrics endpoint with P50/P95/P99 latency, cache hit rate, provider usage, Redis health
- **Multi-tenancy** -- per-tenant cloud databases (Turso), isolated data and config

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Runtime** | Node.js + TypeScript |
| **Framework** | NestJS (10 modules, 6 controllers) |
| **Frontend** | React + Vite + Cytoscape.js |
| **Database** | SQLite (better-sqlite3) / Turso (per-tenant cloud) |
| **Cache** | Redis (ioredis) |
| **Queue** | BullMQ |
| **Auth** | JWT + Passport + bcrypt |
| **LLM Providers** | Groq, NVIDIA NIM, Cerebras, OpenAI GPT-4, Gemini Pro |
| **Embeddings** | HuggingFace Transformers.js (local, Xenova/all-MiniLM-L6-v2) |
| **Deployment** | Azure App Service |

---

## Architecture

### NestJS Modules

```
AppModule
 ├── DatabaseModule      — SQLite connection, Turso adapter, schema init, data loader
 ├── ConfigModule        — Dataset config management (global + per-tenant)
 ├── CacheModule         — Redis client, TTL-based query response cache
 ├── QueueModule         — BullMQ job queue for async processing
 ├── AuthModule          — JWT strategy, Passport guards, registration/login
 ├── TenantModule        — Tenant registry, Turso auto-provisioning, resolution middleware
 ├── QueryModule         — NL-to-SQL pipeline, LLM client, SQL validation, graph extraction
 ├── DocumentModule      — PDF/DOCX upload, text extraction, chunking, RAG retrieval
 ├── OrganizationModule  — Team mode: create/join/leave org, invite codes, workspace switching
 └── MetricsModule       — Observability: latency percentiles, cache rates, provider stats
```

### Request Flow

```
Client → NestJS (Helmet + CORS) → JWT Guard → Tenant Resolver → Controller → Service → Response
                                                    │
                                          ┌─────────┴─────────┐
                                          │                    │
                                    Global SQLite        Turso (tenant DB)
```

---

## Quick Start

```bash
# Install all dependencies (backend + frontend)
npm install

# Configure environment
cp .env.example .env
# Add at least one LLM API key (see Environment Variables below)

# Build (compiles TypeScript + builds React frontend)
npm run build

# Start production server
npm start
```

Open `http://localhost:3000`. The backend serves the React frontend and exposes `/api/*` routes.

For development:

```bash
# Start backend with ts-node
npm run start:dev

# Start frontend dev server (separate terminal)
cd frontend && npm run dev
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GROQ_API_KEY` | At least one LLM key | Groq API key |
| `OPENAI_API_KEY` | At least one LLM key | OpenAI API key |
| `NVIDIA_API_KEY` | Optional | NVIDIA NIM API key (40 RPM limit) |
| `CEREBRAS_API_KEY` | Optional | Cerebras API key |
| `GEMINI_API_KEY` | Optional | Google Gemini API key |
| `PORT` | No | Server port (default: `3000`) |
| `ALLOWED_ORIGINS` | No | Comma-separated CORS origins |
| `JWT_SECRET` | Recommended | Secret for JWT signing (auto-generated if missing) |
| `TURSO_API_TOKEN` | For multi-tenancy | Turso Platform API token |
| `TURSO_ORG_SLUG` | For multi-tenancy | Turso organization slug |
| `REDIS_URL` | No | Redis connection URL (default: `redis://localhost:6379`) |
| `USE_TURSO_VECTOR` | No | Enable Turso native vector search (default: `true`) |
| `DEBUG_MODE` | No | Include debug info in query responses |

---

## API Routes

### AuthController (`/api/auth`) -- 3 routes

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/register` | Create account, provision tenant DB, return JWT |
| `POST` | `/api/auth/login` | Verify credentials, return JWT |
| `GET` | `/api/auth/me` | Verify token, return user email + tenant ID |

### QueryController (`/api`) -- 7 routes

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check with dataset and DB status |
| `GET` | `/api/providers` | Real-time LLM provider health scores |
| `GET` | `/api/dataset` | Active dataset metadata (tables, relationships, counts) |
| `POST` | `/api/query` | Natural language query -- returns SQL, data, graph, NL answer |
| `POST` | `/api/dataset/upload` | Upload JSON config to switch datasets |
| `POST` | `/api/dataset/upload/raw` | Upload CSV/JSONL/ZIP for schema inference |
| `POST` | `/api/dataset/upload/confirm` | Confirm inferred schema, load dataset |

### DocumentController (`/api/documents`) -- 3 routes

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/documents/upload` | Upload PDF/DOCX/TXT/MD for RAG knowledge base |
| `GET` | `/api/documents` | List uploaded documents with chunk counts |
| `DELETE` | `/api/documents/:id` | Delete a document and its vector chunks |

### TenantController (`/api/tenants`) -- 3 routes

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/tenants` | Create tenant, auto-provision Turso DB |
| `GET` | `/api/tenants` | List all tenants with init status |
| `DELETE` | `/api/tenants/:id` | Delete tenant and destroy cloud DB |

### OrganizationController (`/api/organizations`) -- 5 routes

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/organizations` | Create organization (caller becomes admin) |
| `POST` | `/api/organizations/join` | Join organization with invite code |
| `POST` | `/api/organizations/leave` | Leave organization, revert to personal workspace |
| `POST` | `/api/organizations/switch` | Switch between personal and team workspace |
| `GET` | `/api/organizations/me` | Get current user's organization and members |

### MetricsController (`/api/metrics`) -- 1 route

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/metrics` | Uptime, query count, cache hit rate, P50/P95/P99 latency, provider usage, Redis health |

---

## Query Pipeline

```
User Query
  │
  ├─ Validation (length, raw SQL rejection, rate limit)
  │
  ├─ Classification → SQL | RAG | HYBRID | INVALID
  │
  ├─ Complexity Routing → SIMPLE (8B) | MODERATE (32B) | COMPLEX (70B+)
  │
  ├─ Redis Cache Check → hit? return cached response
  │
  ├─ LLM SQL Generation (5 providers, health-sorted failover)
  │
  ├─ SQL Validation (blocklist, read-only, LIMIT enforcement)
  │
  ├─ Execution (SQLite/Turso, tenant-scoped)
  │
  ├─ Graph Extraction (nodes + edges from config relationships)
  │
  ├─ NL Answer Generation (second LLM call with actual data)
  │
  └─ Cache Write → Response
```

Fallback chain: LLM providers (1-5) -> keyword-based SQL -> suggested queries.

---

## Team Mode

Organizations allow multiple users to share a dataset, cache, and workspace.

1. **Create** -- user creates an organization and receives an invite code
2. **Join** -- team members join with the invite code; their queries hit the shared tenant DB
3. **Switch** -- users toggle between personal and team workspaces (like Slack/Notion)
4. **Leave** -- user reverts to their personal workspace and database

Shared resources: dataset, query cache (Redis keys scoped to org tenant), documents, and RAG index.

---

## Caching and Queues

### Redis Cache

- Query responses cached with TTL, keyed by normalized query + tenant ID
- Cache hit skips the entire LLM pipeline (sub-millisecond response)
- Graceful degradation: if Redis is unavailable, requests proceed without cache

### BullMQ Queues

- Background job processing for dataset uploads and tenant DB initialization
- Non-blocking: API responds immediately, jobs complete asynchronously
- Powered by Redis as the message broker

---

## Security

13-layer validation pipeline:

| # | Layer | Description |
|---|---|---|
| 1 | Query classification | SQL/RAG/HYBRID/INVALID routing before LLM |
| 2 | Intent validation | Requires recognizable business action verbs |
| 3 | Domain guardrails | Requires dataset domain keywords |
| 4 | SQL blocklist | Rejects DELETE, UPDATE, DROP, ALTER, PRAGMA |
| 5 | Read-only enforcement | Only SELECT statements pass |
| 6 | Subquery block | No nested SELECT in JOIN conditions |
| 7 | LIMIT enforcement | Auto-appends LIMIT 100 |
| 8 | SQL length cap | 3000 character maximum |
| 9 | Execution timeouts | LLM: 45s, DB: 5s, NL answer: 50s |
| 10 | Payload truncation | Max 100 rows, 200 graph nodes |
| 11 | ID existence checks | Pre-validates document/customer IDs |
| 12 | Rate limiting | 50 requests/minute per IP |
| 13 | Raw SQL rejection | Queries starting with SQL keywords blocked at API layer |

Additional:
- **JWT authentication** with 30-day expiry, Passport strategy
- **Tenant isolation** -- per-tenant DB, config, cache, and document store
- **Helmet** security headers
- **CORS** whitelist

---

## Deployment

Hosted on Azure App Service.

| Setting | Value |
|---|---|
| **Build command** | `npm install && npm run build` |
| **Start command** | `npm start` |
| **Node version** | 18+ |

Set environment variables in the Azure App Service configuration. Redis is optional but recommended (Azure offers managed Redis, or use any external Redis URL via `REDIS_URL`).

---

## Testing

```bash
# Build first
npm run build

# Start the server
npm start

# Run smoke tests (separate terminal)
npm test
```

The test suite validates query processing, guardrails, RAG retrieval, dataset upload, and response shape.

---

## Demo Dataset

The repository ships with **SAP Order-to-Cash (O2C)** as the included test dataset. This is demo data, not the product -- the platform works with any structured dataset.

**Included tables (19):**
- 10 transactional: sales orders, deliveries, billing documents, journal entries, payments, schedule lines (headers + items)
- 9 master data: business partners, addresses, customers, products, plants

**Demo flow:** Customer -> Sales Order -> Delivery -> Billing Document -> Journal Entry -> Payment

Users can replace or supplement this dataset at any time through the upload wizard (CSV, JSONL, ZIP) or by uploading a JSON config file.
