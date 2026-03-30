/**
 * SQLite-backed vector store for document chunks.
 * Tables persist across dataset switches (excluded from DROP in init.js).
 *
 * DUAL-MODE:
 * - Turso connections: Uses F32_BLOB(384) + vector_top_k() for native indexed search
 * - SQLite connections: Stores embeddings as JSON, uses brute-force cosine similarity
 *
 * All functions accept an optional dbConn parameter for multi-tenant support.
 * When omitted, falls back to the global SQLite connection.
 */

const db = require('../db/connection');

const USE_TURSO_VECTOR = process.env.USE_TURSO_VECTOR !== 'false'; // default: true

// ─── Table Initialization ────────────────────────────────────────────────────

async function initDocumentTables(dbConn = db) {
    const isTurso = dbConn.type === 'turso';

    if (isTurso && USE_TURSO_VECTOR) {
        // Turso: use F32_BLOB for native vector support
        await dbConn.execAsync(`
            CREATE TABLE IF NOT EXISTS documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                filename TEXT NOT NULL,
                file_type TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                chunk_count INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS document_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_id INTEGER NOT NULL,
                chunk_index INTEGER NOT NULL,
                text TEXT NOT NULL,
                embedding F32_BLOB(384),
                embedding_json TEXT,
                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(document_id);
        `);

        // Create vector index (separate statement — may fail if already exists)
        try {
            await dbConn.execAsync(`
                CREATE INDEX IF NOT EXISTS chunk_vec_idx ON document_chunks(libsql_vector_idx(embedding));
            `);
            console.log('[VECTOR_STORE] Turso vector index created.');
        } catch (err) {
            console.warn('[VECTOR_STORE] Vector index creation skipped:', err.message);
        }

        console.log('[VECTOR_STORE] Document tables initialized (Turso vector mode).');
    } else {
        // SQLite: JSON string embeddings with brute-force search
        await dbConn.execAsync(`
            CREATE TABLE IF NOT EXISTS documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                filename TEXT NOT NULL,
                file_type TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                chunk_count INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS document_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_id INTEGER NOT NULL,
                chunk_index INTEGER NOT NULL,
                text TEXT NOT NULL,
                embedding TEXT NOT NULL,
                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(document_id);
        `);
        console.log('[VECTOR_STORE] Document tables initialized (SQLite in-memory mode).');
    }
}

// ─── CRUD Operations ─────────────────────────────────────────────────────────

async function insertDocument(dbConn = db, { title, filename, fileType, fileSize }) {
    const result = await dbConn.runAsync(
        'INSERT INTO documents (title, filename, file_type, file_size) VALUES (?, ?, ?, ?)',
        [title, filename, fileType, fileSize]
    );
    return result.lastInsertRowid;
}

async function insertChunks(dbConn = db, documentId, chunks) {
    const isTurso = dbConn.type === 'turso' && USE_TURSO_VECTOR;
    const statements = [];

    for (const chunk of chunks) {
        const embeddingJson = JSON.stringify(Array.from(chunk.embedding));

        if (isTurso) {
            // Turso: store in both F32_BLOB (for vector search) and JSON (for fallback)
            statements.push({
                sql: 'INSERT INTO document_chunks (document_id, chunk_index, text, embedding, embedding_json) VALUES (?, ?, ?, vector32(?), ?)',
                args: [documentId, chunk.index, chunk.text, embeddingJson, embeddingJson]
            });
        } else {
            // SQLite: JSON string only
            statements.push({
                sql: 'INSERT INTO document_chunks (document_id, chunk_index, text, embedding) VALUES (?, ?, ?, ?)',
                args: [documentId, chunk.index, chunk.text, embeddingJson]
            });
        }
    }
    await dbConn.batchWrite(statements);

    // Update chunk count on the document
    await dbConn.runAsync('UPDATE documents SET chunk_count = ? WHERE id = ?', [chunks.length, documentId]);
}

async function deleteDocument(dbConn = db, id) {
    await dbConn.runAsync('DELETE FROM document_chunks WHERE document_id = ?', [id]);
    await dbConn.runAsync('DELETE FROM documents WHERE id = ?', [id]);
}

async function listDocuments(dbConn = db) {
    return await dbConn.allAsync(
        'SELECT id, title, filename, file_type, file_size, chunk_count, created_at FROM documents ORDER BY created_at DESC'
    );
}

async function getChunkCount(dbConn = db) {
    const row = await dbConn.getAsync('SELECT COUNT(*) as count FROM document_chunks');
    return row ? row.count : 0;
}

// ─── Vector Search ───────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

/**
 * Turso-native vector search using F32_BLOB + vector_top_k().
 * Returns top-K chunks by vector similarity (indexed, O(log n)).
 */
async function tursoVectorSearch(dbConn, queryEmbedding, topK = 5) {
    const embeddingJson = JSON.stringify(Array.from(queryEmbedding));

    const rows = await dbConn.allAsync(`
        SELECT dc.text, d.title as documentTitle
        FROM vector_top_k('chunk_vec_idx', vector32(?), ?) AS vt
        JOIN document_chunks dc ON dc.rowid = vt.id
        JOIN documents d ON dc.document_id = d.id
    `, [embeddingJson, topK]);

    // vector_top_k returns results ordered by similarity (best first)
    return rows.map((r, i) => ({
        text: r.text,
        score: 1.0 - (i * 0.05), // approximate score from rank position
        documentTitle: r.documentTitle
    }));
}

/**
 * In-memory brute-force cosine similarity search.
 * Works with any DB type (JSON string embeddings).
 */
async function inMemorySearch(dbConn, queryEmbedding, topK = 5, threshold = 0.3) {
    // Determine which column has the embedding data
    const embeddingCol = dbConn.type === 'turso' && USE_TURSO_VECTOR ? 'embedding_json' : 'embedding';

    const chunks = await dbConn.allAsync(`
        SELECT dc.text, dc.${embeddingCol} as embedding, d.title as documentTitle
        FROM document_chunks dc
        JOIN documents d ON dc.document_id = d.id
    `);

    const results = [];
    for (const chunk of chunks) {
        let embedding;
        try {
            embedding = JSON.parse(chunk.embedding);
        } catch {
            continue;
        }
        const score = cosineSimilarity(queryEmbedding, embedding);
        if (score >= threshold) {
            results.push({ text: chunk.text, score, documentTitle: chunk.documentTitle });
        }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
}

/**
 * Searches for chunks most similar to the query embedding.
 * Turso connections: tries native vector search first, falls back to in-memory.
 * SQLite connections: always uses in-memory brute-force.
 *
 * @param {object} dbConn - Database connection
 * @param {number[]} queryEmbedding - 384-dim embedding vector
 * @param {number} topK - Max results to return
 * @param {number} threshold - Minimum cosine similarity (in-memory only)
 * @returns {Promise<Array<{text: string, score: number, documentTitle: string}>>}
 */
async function searchSimilar(dbConn = db, queryEmbedding, topK = 5, threshold = 0.3) {
    const isTurso = dbConn.type === 'turso' && USE_TURSO_VECTOR;

    if (isTurso) {
        try {
            const results = await tursoVectorSearch(dbConn, queryEmbedding, topK);
            if (results && results.length > 0) {
                console.log(`[RAG] Turso native vector search returned ${results.length} chunks.`);
                return results;
            }
        } catch (err) {
            console.warn(`[RAG] Turso vector search failed, falling back to in-memory: ${err.message}`);
        }
    }

    // Fallback: in-memory brute-force cosine similarity
    const results = await inMemorySearch(dbConn, queryEmbedding, topK, threshold);
    if (results.length > 0) {
        console.log(`[RAG] In-memory vector search returned ${results.length} chunks.`);
    }
    return results;
}

module.exports = {
    initDocumentTables,
    insertDocument,
    insertChunks,
    deleteDocument,
    listDocuments,
    getChunkCount,
    searchSimilar,
    cosineSimilarity
};
