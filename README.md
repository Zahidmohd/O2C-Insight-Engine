# Graph-Based Data Modeling and Query System

An intelligent graph-based query engine designed to traverse highly interconnected SAP Order-to-Cash (O2C) datasets using natural language. The system evaluates natural language requirements, securely maps them to structured data queries, and presents the resulting relationships as an interactive visual graph.

---

## 🏗️ Problem Overview

Traditional enterprise data is often scattered across fragmented tables with complex integration paths. Tracing the full lifecycle of a single order typically involves manual and repetitive database navigation. 

This project solves this challenge by constructing a unified graph-based query system over an SAP Order-to-Cash dataset. It seamlessly traces the exact multi-hop relationships representing the real-world flow of business objects: 
**SalesOrder → Delivery → Billing → JournalEntry → Payment**

Users can ask plain-language questions about complex data paths and instantly receive an accurate, interactive graph rendering of the business flow.

---

## 🏛️ Architecture

The system follows a strict, layered architecture to elegantly separate raw relational data from analytical workflows:

- **Data Layer:** A localized, lightweight relational database configured to securely store denormalized SAP datasets. Primary keys and strict indexes are deployed to optimize traversal speeds across interconnected records.
- **Query Engine:** An intelligent linguistic pipeline relying on large language models with automated fallback mechanisms. It synthesizes structured database queries strictly constrained to the authorized schema context.
- **API Layer:** A RESTful abstraction providing synchronous query resolution. It sanitizes inputs, enforces system guardrails, explicitly caps payload sizes, and generates the structured graph metadata.
- **Frontend Layer:** A lightweight, dual-pane analytical canvas. It processes the structured data payloads and translates them into an interactive node-and-edge visual representation.

---

## 🧠 Key Design Decisions & Tradeoffs

1. **Relational Database over Graph Engine Providers:** Chose a highly-indexed relational database for local, fast development directly tracking the raw datasets, favoring prototyping simplicity and zero-configuration over immediate scalable concurrency.
2. **Raw Querying over ORM Layers:** Maintained full, unabstracted control over precise multi-hop join operations. Heavy abstraction tools generate unpredictable schema lookups that inherently conflict with tightly controlled prompt engineering.
3. **Data Normalization at Ingestion:** Intentionally resolved critical string-level formatting anomalies during the initial data ingestion pipeline. This significantly reduced the complexity of language model reasoning, ensuring highly reliable and index-friendly database traversals.
4. **Graph Abstraction over Tables:** Concealed the messy, low-level ledger structures from the user interface. Tabular results are comprehensively abstracted into clean, business-friendly node mappings before reaching the client layer.
5. **Architectural Separation of Duties:** The language model engine does not evaluate the factual dataset or independently deduce business responses. It is strictly limited to synthesizing structural syntax, which is subsequently validated and executed independently against the deterministic database.

---

## 🛡️ Performance & Safety

Production-grade resilient boundaries surround the data querying engine:

- **Query Validation:** A strict token evaluation mechanism aggressively validates incoming queries to ensure they only attempt read-only operations, completely eliminating the risk of accidental data mutations.
- **Query Safety and Limitation:** Unbounded data extractions are proactively constrained. The system enforces strict query size ceilings, preventing network buffer overflows or database overload scenarios.
- **Response Size Limiting:** Returned payload structures are explicitly truncated to a safe mathematical maximum to protect frontend performance and reduce browser memory footprints.
- **Systematic Domain Guardrails:** Irrelevant or off-topic queries are caught heuristically before initiating external evaluation, saving execution budgets and maintaining strict security perimeters.

---

## 🕸️ Graph Handling

The system automatically bridges relational database output into interactive UI visualizations:

- **Node-Edge Mapping:** Tabular interactions are aggregated dynamically, translating rigid table concepts natively into fluid visual relationships represented by interconnected nodes and targeted edge paths.
- **Duplicate Prevention:** Visual physics state are meticulously managed. The rendering engine lifecycle explicitly guarantees that previous graphical representations are entirely cleared and garbage-collected before drawing new visualizations, entirely preventing memory leaks and state duplication.

---

## 💻 Frontend Description

 The client interface is crafted matching strict usability standards without bloated styling frameworks:

- **Loading and Error Handling:** The interactive UI actively mitigates overlapping requests through distinct loading states, clearly preventing concurrent form submissions. Exhaustive error boundaries elegantly catch failing database operations or out-of-scope logic, surfacing the contextual details visibly onto the screen to guide the user rather than failing silently.
- **Graph Rendering Behavior:** Utilizes an integrated physics simulation which automatically calculates and spreads complex network clusters dynamically, ensuring optimal spacing and presentation without manual geometry mapping.
- **Performance Considerations:** Rendering is highly optimized. The system intelligently handles edge cases, displaying structured empty states when queries yield no relationships, effectively preventing blank screens or physics calculation errors.

---

## 👁️ Observability

- **Conceptual Request Tracing:** The system employs distributed request tracing via unique identification codes dynamically assigned to every individual query. This explicit metadata is exposed visibly through the frontend, creating an end-to-end observability chain that securely correlates user-facing visual output directly back to low-level internal execution logs and security validation steps.

---

## 🚀 System Flow

1. **Initiation:** The user inputs an objective request analyzing the business process.
2. **Translation:** The query engine sanitizes and translates the request into a strictly governed data-access syntax.
3. **Validation:** The system parses the instructions through a security review, dropping any potentially excessive or malformed boundaries.
4. **Execution:** Protected syntax explores the relational datasets and pulls highly specific mapped paths.
5. **Presentation:** The API aggregates the relational returns into an abstracted graph logic payload, which the frontend renders dynamically for active interaction.

---

## 🔮 Future Improvements

- **Database Scaling:** Migrate mapping pipelines from localized execution into distributed relational instances, empowering robust transactional concurrencies and continuous uptime.
- **Intelligent Caching:** Introduce high-speed memory bounds for identical repeated queries, bypassing linguistic syntax regeneration budgets entirely.
- **Advanced Query Planning:** Decouple monolithic syntax generation by routing logical phases through segmented validation agents to proactively catch structural anomalies recursively.
