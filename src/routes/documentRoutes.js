/**
 * Document upload API for the RAG pipeline.
 * Handles PDF, DOCX, TXT, MD uploads → extract → chunk → embed → store.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const router = express.Router();

const { extractText } = require('../rag/documentExtractor');
const { chunkDocument } = require('../rag/chunker');
const { embedBatch } = require('../rag/embeddingService');
const { insertDocument, insertChunks, deleteDocument, listDocuments, getChunkCount } = require('../rag/vectorStore');

// ─── Multer Configuration ────────────────────────────────────────────────────

const DOC_UPLOAD_DIR = path.join(os.tmpdir(), 'o2c-doc-uploads');
if (!fs.existsSync(DOC_UPLOAD_DIR)) {
    fs.mkdirSync(DOC_UPLOAD_DIR, { recursive: true });
}
const ALLOWED_DOC_EXTENSIONS = ['.pdf', '.txt', '.md', '.docx'];
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

const docUpload = multer({
    dest: DOC_UPLOAD_DIR,
    limits: { fileSize: MAX_FILE_SIZE, files: 1 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ALLOWED_DOC_EXTENSIONS.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error(`Unsupported file type: ${ext}. Allowed: ${ALLOWED_DOC_EXTENSIONS.join(', ')}`));
        }
    }
});

// ─── Upload Document ─────────────────────────────────────────────────────────

router.post('/documents/upload', docUpload.single('file'), async (req, res) => {
    let tempPath = null;
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: { message: 'No file uploaded.', type: 'VALIDATION_ERROR' }
            });
        }

        tempPath = req.file.path;
        const ext = path.extname(req.file.originalname).toLowerCase();
        const title = req.body.title || req.file.originalname.replace(/\.[^.]+$/, '');

        console.log(`[DOC_UPLOAD] Processing "${req.file.originalname}" (${(req.file.size / 1024).toFixed(1)}KB)...`);

        // 1. Extract text
        const text = await extractText(tempPath, ext);
        console.log(`[DOC_UPLOAD] Extracted ${text.length} characters.`);

        // 2. Chunk
        const chunks = chunkDocument(text, { title, filename: req.file.originalname });
        console.log(`[DOC_UPLOAD] Created ${chunks.length} chunks.`);

        // 3. Embed all chunks
        console.log(`[DOC_UPLOAD] Embedding ${chunks.length} chunks (this may take a moment on first call)...`);
        const chunkTexts = chunks.map(c => c.text);
        const embeddings = await embedBatch(chunkTexts);

        // 4. Store in SQLite
        const dbConn = req.db;
        const documentId = await insertDocument(dbConn, {
            title,
            filename: req.file.originalname,
            fileType: ext.slice(1),
            fileSize: req.file.size
        });

        const chunksWithEmbeddings = chunks.map((c, i) => ({
            text: c.text,
            index: c.index,
            embedding: embeddings[i]
        }));
        await insertChunks(dbConn, documentId, chunksWithEmbeddings);

        console.log(`[DOC_UPLOAD] Document "${title}" stored (id=${documentId}, ${chunks.length} chunks).`);

        return res.status(200).json({
            success: true,
            documentId,
            title,
            filename: req.file.originalname,
            chunkCount: chunks.length,
            characterCount: text.length
        });

    } catch (err) {
        console.error('[DOC_UPLOAD] Error:', err.message);
        return res.status(500).json({
            success: false,
            error: { message: `Document upload failed: ${err.message}`, type: 'PROCESSING_ERROR' }
        });
    } finally {
        // Clean up temp file
        if (tempPath && fs.existsSync(tempPath)) {
            fs.unlink(tempPath, () => {});
        }
    }
});

// ─── List Documents ──────────────────────────────────────────────────────────

router.get('/documents', async (req, res) => {
    try {
        const dbConn = req.db;
        const documents = await listDocuments(dbConn);
        const totalChunks = await getChunkCount(dbConn);
        return res.status(200).json({
            success: true,
            documents,
            totalChunks
        });
    } catch (err) {
        console.error('[DOC_LIST] Error:', err.message);
        return res.status(500).json({
            success: false,
            error: { message: `Failed to list documents: ${err.message}`, type: 'API_ERROR' }
        });
    }
});

// ─── Delete Document ─────────────────────────────────────────────────────────

router.delete('/documents/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) {
            return res.status(400).json({
                success: false,
                error: { message: 'Invalid document ID.', type: 'VALIDATION_ERROR' }
            });
        }

        await deleteDocument(req.db, id);
        console.log(`[DOC_DELETE] Document ${id} deleted.`);

        return res.status(200).json({ success: true, message: `Document ${id} deleted.` });
    } catch (err) {
        console.error('[DOC_DELETE] Error:', err.message);
        return res.status(500).json({
            success: false,
            error: { message: `Failed to delete document: ${err.message}`, type: 'API_ERROR' }
        });
    }
});

// ─── Multer Error Handler ────────────────────────────────────────────────────

router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        return res.status(400).json({
            success: false,
            error: { message: `Upload error: ${err.message}`, type: 'UPLOAD_ERROR' }
        });
    }
    if (err.message && err.message.includes('Unsupported file type')) {
        return res.status(400).json({
            success: false,
            error: { message: err.message, type: 'VALIDATION_ERROR' }
        });
    }
    next(err);
});

module.exports = router;
