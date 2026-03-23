# Graph-Based Data Modeling and Query System

An intelligent graph-based query engine designed to traverse highly interconnected SAP Order-to-Cash (O2C) datasets using natural language. The system converts raw English questions into secure SQL via large language models (LLMs), executes them safely against a structured SQLite database, and returns mapped graph representations for visual analysis in the browser.

---

## 🏗️ Problem Overview

Traditional enterprise data (like SAP ERPs) is spread across dozens of disconnected tables with complex join paths. Tracking the lifecycle of a single order involves manual database hunting. 

This project solves this by constructing a unified **Graph-based query system** over an extracted SAP Order-to-Cash dataset. It seamlessly tracks the exact multi-hop relationships representing the real-world flow of business objects: 
**SalesOrder → Delivery → Billing → JournalEntry → Payment**

Users can simply ask *"Show me the journal entry linked to billing document 91150187"* and instantly receive accurate table rows alongside an interactive graph rendering.

---

## 🏛️ Architecture

The system follows a strict, layered architecture to separate raw relational data from analytical UI workflows.

**User Query → LLM Generator → Safety Validator → SQLite DB → Response Mapper → Frontend Graph**

- **Data Layer (SQLite):** Stores the denormalized multi-file SAP datasets using precise composite primary keys and strict B-Tree indexes to optimize traversal speeds.
- **Query Engine (LLM → SQL):** An intelligent pipeline relying primarily on Groq with an OpenRouter fallback mechanism. Evaluates natural language to synthesize SQL queries based strictly on the O2C schema context.
- **API Layer (Express.js):** REST API providing synchronous query resolution. It sanitizes inputs, enforces guardrails, explicitly caps payloads geographically, and generates structured JSON graph metadata.
- **Frontend (React + Cytoscape):** A lightweight static React application splitting operations into a dual-pane analytical canvas. It mounts returning tabular JSON rows into strict visual graph nodes representing business interactions securely.

---

## 🧠 Key Design Decisions & Tradeoffs

1. **SQLite Instead of Postgres:** Chose SQLite for local, fast, zero-configuration development tightly tracking the raw source datasets, favoring simplicity over scalable concurrency for this prototype.
2. **Raw SQL over ORM Layer:** Maintained full, unabstracted control over precise multi-hop join operations. Heavy ORMs generate unpredictable schema lookups inherently conflicting with explicit LLM prompt engineering.
3. **Data Normalization at Ingestion:** Intentionally resolved critical string-padding anomalies natively during data ingestion before the records touched the database. This vastly simplified LLM generation logic ensuring index-friendly, simple equality joins.
4. **Graph Abstraction over Tables:** Concealed the messy item-level table complexity (e.g. underlying ledger item rows) and abstracted them into clean, business-friendly node mappings (e.g. `BillingDocument`) returning to the client interface.
5. **LLMs for Code, Not Data:** The LLM does NOT see the dataset or independently attempt to hallucinate facts. It strictly generates structural SQL syntax which is independently validated and ran securely against the factual deterministic database.

---

## 🛡️ Performance & Safety

Production-grade resilient boundaries surround the data querying engine:

- **SQL Validation:** The application employs a static token blocklist aggressively validating queries to ensure read-only operations, preventing data mutations.
- **Query Safety Constraints:** Over-ambitious data extractions are proactively constrained. The engine explicitly enforces payload limits preventing network buffer overflows or database overload.
- **Domain Guardrails:** Invalid or off-topic queries are caught heuristically before reaching the LLM, preserving API token budgets and enhancing response speed.
- **Response Size Limiting:** Returned payload structures are truncated to a safe, strict maximum to protect frontend performance memory footprints.
- **Timeouts:** Strict temporal handlers surround the LLM generation process and SQL query evaluation loops, ensuring the system does not hang on complex network prompts or unoptimized user requests.

---

## 🕸️ Graph Handling

The system bridges relational database output directly into interactive UI visualizations:

- **Node-Edge Mapping:** Tabular database rows are aggregated dynamically translating rigid table concepts (Rows and Foreign Keys) directly into fluid Graph structures (Nodes and Edges) on the backend before sending to the client.
- **State Management:** The frontend physics engine is meticulously managed. The visual lifecycle guarantees previous graphs are fully garbage-collected and destroyed prior to rendering new queries, entirely preventing visual duplication or memory leaks over prolonged sessions.

---

## 💻 Frontend Engineering Highlights

The UI was crafted matching strict dual-pane constraints without bloated CSS preprocessing layers:

- **Loading & Error Management:** Standard UI states properly disable interactive form submissions mapping intuitive visual feedback during execution requests. Exhaustive error boundaries elegantly catch failing database operations or out-of-scope LLM logic, routing details visibly onto the screen instead of solely the console.
- **Graph Rendering Behavior:** Utilizes an integrated physics simulation automatically spreading complex arbitrary network clusters dynamically avoiding manual static geometry plotting.
- **Empty Graph Handling:** Implements an explicit fallback visual block actively guiding the user if the returned payload lacks interconnected network data.

---

## 👁️ Observability

- **Distributed Request Tracing:** The system employs a unique Request ID architecture dynamically assigned per query API hit. This metadata is exposed explicitly back to the Frontend UI, facilitating robust observability correlating specific graphical insights directly to backend console execution steps and LLM API events.

---

## 🤖 AI Usage & Workflow Integration

The entire architecture inherently embeds AI via structured engineering rules:

- **Prompt Iteration & Refinement:** Evolved constraints by pruning irrelevant dataset schemas, improving semantic translation accuracy significantly.
- **Debugging Joins With AI:** Assisted logically navigating multi-hop connections, verifying data modeling paths matching real-world business entity structures.
- **Maintained Automation:** Documented strict internal history logs sequentially tracing exact architectural milestones and prompt metadata: `docs/ai-session-log.md`.

---

## 🚀 API Usage

The backend application provides a JSON stateless REST mechanism.

**`POST /api/query`**

**Request:**
```json
{
  "query": "Show orders not billed"
}
```

**Response:**
```json
{
  "success": true,
  "requestId": "4c8c222b-...",
  "query": "Show orders not billed",
  "sql": "SELECT ... LIMIT 100;",
  "rowCount": 14,
  "data": [...],
  "graph": {
    "nodes": [...],
    "edges": [...]
  },
  "executionTimeMs": "8.55"
}
```

---

## 📂 Project Structure

- `src/` - Backend Node.js Application Layer
  - `query/` - Sub-engine coordinating LLM generation, mapping extraction paths, and validators.
  - `db/` - ETL mapping code, ingestion logic, and SQLite execution abstractions.
  - `routes/` - Express endpoint mappings managing external REST parameters.
- `frontend/` - Standard React Client. Maintains UI states matching queried API payloads into explicitly mapped colored logical documents.
- `docs/` - Original architecture notes, dataset constraints, and historical session logs.

---

## ⚙️ How to Run

### Backend (Node.js/Express)
```bash
# Provide API Access via .env (GROQ_API_KEY & OPENROUTER_API_KEY)
npm install

# Build Dataset and apply normalizations
node src/db/init.js
node src/db/loader.js

# Boot Engine on http://localhost:3000
npm start
```

### Frontend (React/Vite)
```bash
cd frontend
npm install

# Boot dev server on http://localhost:5173
npm run dev
```

---

## 🔮 Future Improvements

1. **PostgreSQL Migration:** Migrate SQLite mappings into distributed Postgres instances empowering robust transactional concurrencies.
2. **Caching Layers:** Introduce Redis bounding for repeated exact NL Query mappings bypassing LLM regeneration overhead entirely.
3. **Advanced Query Planning:** Decouple monolithic SQL generation by executing step-based LLM validation streams proactively catching structural errors recursively.
4. **Enhanced Diagnostics:** Incorporate deeper explicit debugging overlays inside the UI analyzing deeper metrics for executing planners.
