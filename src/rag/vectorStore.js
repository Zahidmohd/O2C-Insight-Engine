/**
 * SQLite-backed vector store for document chunks.
 * Tables persist across dataset switches (excluded from DROP in init.js).
 *
 * DUAL-MODE:
 * - Turso: F32_BLOB(384) column + vector_top_k() with DiskANN index
 * - SQLite: JSON TEXT embeddings + brute-force cosine similarity
 *
 * All functions accept an optional dbConn parameter for multi-tenant support.
 */

const db = require('../db/connection');

const USE_TURSO_VECTOR = process.env.USE_TURSO_VECTOR !== 'false';

// ─── Table Initialization ────────────────────────────────────────────────────

async function initDocumentTables(dbConn = db) {
    const isTurso = dbConn.type === 'turso';

    if (isTurso && USE_TURSO_VECTOR) {
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
        // Vector index created AFTER first data insert (empty-table index corrupts on Turso)
        console.log('[VECTOR_STORE] Document tables initialized (Turso vector mode).');
    } else {
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

    if (isTurso) {
        // Turso: use individual execute() calls with vector32() — batch() doesn't support vector32()
        for (const chunk of chunks) {
            const embStr = '[' + Array.from(chunk.embedding).map(v => Number(v).toFixed(6)).join(',') + ']';
            const embJson = JSON.stringify(Array.from(chunk.embedding));
            await dbConn.runAsync(
                'INSERT INTO document_chunks (document_id, chunk_index, text, embedding, embedding_json) VALUES (?, ?, ?, vector32(?), ?)',
                [documentId, chunk.index, chunk.text, embStr, embJson]
            );
        }

        // Create vector index after first insert (avoids corrupted empty-table index)
        try {
            const idx = await dbConn.allAsync("SELECT name FROM sqlite_master WHERE type='index' AND name='chunk_vec_idx'");
            if (idx.length === 0) {
                await dbConn.execAsync('CREATE INDEX chunk_vec_idx ON document_chunks(libsql_vector_idx(embedding))');
                console.log('[VECTOR_STORE] Turso DiskANN vector index created.');
            }
        } catch (err) {
            console.warn('[VECTOR_STORE] Vector index creation skipped:', err.message);
        }
    } else {
        // SQLite: use batchWrite for efficiency
        const statements = chunks.map(chunk => ({
            sql: 'INSERT INTO document_chunks (document_id, chunk_index, text, embedding) VALUES (?, ?, ?, ?)',
            args: [documentId, chunk.index, chunk.text, JSON.stringify(Array.from(chunk.embedding))]
        }));
        await dbConn.batchWrite(statements);
    }

    // Update chunk count
    await dbConn.runAsync('UPDATE documents SET chunk_count = ? WHERE id = ?', [chunks.length, documentId]);
    console.log(`[VECTOR_STORE] Stored ${chunks.length} chunks (mode: ${isTurso ? 'turso+F32_BLOB' : 'sqlite+JSON'}).`);
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
 * Turso-native vector search using F32_BLOB + vector_top_k() with DiskANN index.
 * Falls back to vector_distance_cos if index doesn't exist.
 */
async function tursoVectorSearch(dbConn, queryEmbedding, topK = 5) {
    const embStr = '[' + Array.from(queryEmbedding).map(v => v.toFixed(6)).join(',') + ']';

    // Try indexed search first (vector_top_k with DiskANN)
    try {
        const idx = await dbConn.allAsync("SELECT name FROM sqlite_master WHERE type='index' AND name='chunk_vec_idx'");
        if (idx.length > 0) {
            const rows = await dbConn.allAsync(`
                SELECT dc.text, d.title as documentTitle,
                       vector_distance_cos(dc.embedding, vector32(?)) as distance
                FROM vector_top_k('chunk_vec_idx', vector32(?), ${Number(topK)}) AS vt
                JOIN document_chunks dc ON dc.rowid = vt.id
                JOIN documents d ON dc.document_id = d.id
            `, [embStr, embStr]);

            console.log(`[RAG] Turso vector_top_k (DiskANN indexed): ${rows.length} results.`);
            return rows.map(r => ({
                text: r.text,
                score: 1.0 - (r.distance || 0),
                documentTitle: r.documentTitle
            }));
        }
    } catch (err) {
        console.warn(`[RAG] vector_top_k failed: ${err.message}`);
    }

    // Fallback: brute-force with vector_distance_cos (no index needed)
    const rows = await dbConn.allAsync(`
        SELECT dc.text, d.title as documentTitle,
               vector_distance_cos(dc.embedding, vector32(?)) as distance
        FROM document_chunks dc
        JOIN documents d ON dc.document_id = d.id
        WHERE dc.embedding IS NOT NULL
        ORDER BY distance ASC
        LIMIT ${Number(topK)}
    `, [embStr]);

    console.log(`[RAG] Turso vector_distance_cos (brute-force): ${rows.length} results.`);
    return rows.map(r => ({
        text: r.text,
        score: 1.0 - (r.distance || 0),
        documentTitle: r.documentTitle
    }));
}

/**
 * In-memory brute-force cosine similarity search.
 * Works with any DB type (JSON string embeddings).
 */
async function inMemorySearch(dbConn, queryEmbedding, topK = 5, threshold = 0.3) {
    const embeddingCol = dbConn.type === 'turso' && USE_TURSO_VECTOR ? 'embedding_json' : 'embedding';

    const chunks = await dbConn.allAsync(`
        SELECT dc.text, dc.${embeddingCol} as embedding, d.title as documentTitle
        FROM document_chunks dc
        JOIN documents d ON dc.document_id = d.id
    `);

    console.log(`[RAG] In-memory search: ${chunks.length} chunks loaded (col: ${embeddingCol}).`);

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
 * Search for similar chunks. Three-layer fallback:
 * 1. Turso vector_top_k (DiskANN indexed) — fastest, native
 * 2. Turso vector_distance_cos (brute-force) — native math, no index
 * 3. In-memory cosine similarity (JS) — works on any DB
 */
async function searchSimilar(dbConn = db, queryEmbedding, topK = 5, threshold = 0.3) {
    const isTurso = dbConn.type === 'turso' && USE_TURSO_VECTOR;

    if (isTurso) {
        try {
            const results = await tursoVectorSearch(dbConn, queryEmbedding, topK);
            if (results && results.length > 0) {
                return results;
            }
        } catch (err) {
            console.warn(`[RAG] Turso vector search failed, falling back to in-memory: ${err.message}`);
        }
    }

    // Fallback: in-memory JS cosine similarity
    const results = await inMemorySearch(dbConn, queryEmbedding, topK, threshold);
    if (results.length > 0) {
        console.log(`[RAG] In-memory fallback returned ${results.length} chunks.`);
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
