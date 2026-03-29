/**
 * SQLite-backed vector store for document chunks.
 * Tables persist across dataset switches (excluded from DROP in init.js).
 *
 * Stores embeddings as JSON arrays of 384 floats (Xenova/all-MiniLM-L6-v2).
 * Search uses brute-force cosine similarity — fast enough for <10K chunks.
 */

const db = require('../db/connection');

// ─── Table Initialization ────────────────────────────────────────────────────

function initDocumentTables() {
    db.exec(`
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
    console.log('[VECTOR_STORE] Document tables initialized.');
}

// ─── CRUD Operations ─────────────────────────────────────────────────────────

function insertDocument({ title, filename, fileType, fileSize }) {
    const stmt = db.prepare(
        'INSERT INTO documents (title, filename, file_type, file_size) VALUES (?, ?, ?, ?)'
    );
    const result = stmt.run(title, filename, fileType, fileSize);
    return result.lastInsertRowid;
}

function insertChunks(documentId, chunks) {
    const insert = db.prepare(
        'INSERT INTO document_chunks (document_id, chunk_index, text, embedding) VALUES (?, ?, ?, ?)'
    );
    const transaction = db.transaction((items) => {
        for (const chunk of items) {
            insert.run(documentId, chunk.index, chunk.text, JSON.stringify(Array.from(chunk.embedding)));
        }
    });
    transaction(chunks);

    // Update chunk count on the document
    db.prepare('UPDATE documents SET chunk_count = ? WHERE id = ?').run(chunks.length, documentId);
}

function deleteDocument(id) {
    db.prepare('DELETE FROM document_chunks WHERE document_id = ?').run(id);
    db.prepare('DELETE FROM documents WHERE id = ?').run(id);
}

function listDocuments() {
    return db.prepare(
        'SELECT id, title, filename, file_type, file_size, chunk_count, created_at FROM documents ORDER BY created_at DESC'
    ).all();
}

function getChunkCount() {
    const row = db.prepare('SELECT COUNT(*) as count FROM document_chunks').get();
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
 * Searches for chunks most similar to the query embedding.
 * @param {number[]} queryEmbedding - 384-dim embedding vector
 * @param {number} topK - Max results to return
 * @param {number} threshold - Minimum cosine similarity
 * @returns {Array<{text: string, score: number, documentTitle: string}>}
 */
function searchSimilar(queryEmbedding, topK = 5, threshold = 0.3) {
    const chunks = db.prepare(`
        SELECT dc.text, dc.embedding, d.title as documentTitle
        FROM document_chunks dc
        JOIN documents d ON dc.document_id = d.id
    `).all();

    const results = [];
    for (const chunk of chunks) {
        let embedding;
        try {
            embedding = JSON.parse(chunk.embedding);
        } catch {
            continue; // Skip chunks with corrupted embedding data
        }
        const score = cosineSimilarity(queryEmbedding, embedding);
        if (score >= threshold) {
            results.push({ text: chunk.text, score, documentTitle: chunk.documentTitle });
        }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
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
