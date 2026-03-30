const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const router = express.Router();
const queryService = require('../query/queryService');
const { getActiveConfig, setActiveConfig, defaultConfig } = require('../config/activeDataset');
const initDB = require('../db/init');
const { loadDataset } = require('../db/loader');
const db = require('../db/connection');
const { validateDatasetConfig } = require('../config/datasetValidator');
const { inferSchema, recordsToJSONL } = require('../onboarding/schemaInference');
const { inferRelationships } = require('../onboarding/relationshipInference');
const { generateConfig } = require('../onboarding/configGenerator');
const { extractZip } = require('../rag/zipExtractor');

/**
 * Global dataset update lock — prevents queries from executing against a
 * half-loaded dataset. Set to true during upload, false when done.
 */
let isDatasetUpdating = false;

/**
 * In-memory rate limiter — 20 requests per minute per IP.
 * Expired entries are swept every 2 minutes to prevent unbounded Map growth.
 */
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 50;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
        if (now - entry.timestamp > RATE_LIMIT_WINDOW_MS) {
            rateLimitMap.delete(ip);
        }
    }
    if (rateLimitMap.size > 10000) {
        console.warn(`[RATE_LIMIT] Map exceeded 10K entries, purging.`);
        rateLimitMap.clear();
    }
}, 2 * 60 * 1000);

function rateLimit(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const entry = rateLimitMap.get(ip);

    if (!entry || now - entry.timestamp > RATE_LIMIT_WINDOW_MS) {
        rateLimitMap.set(ip, { count: 1, timestamp: now });
        return next();
    }

    entry.count++;
    if (entry.count > RATE_LIMIT_MAX) {
        return res.status(429).json({
            success: false,
            error: 'Rate limit exceeded. Try again later.'
        });
    }

    return next();
}

// ─── Multer Configuration ────────────────────────────────────────────────────
const UPLOAD_TEMP_DIR = path.join(os.tmpdir(), 'o2c-onboarding-uploads');
const ALLOWED_EXTENSIONS = ['.jsonl', '.csv', '.json', '.zip'];

const upload = multer({
    dest: UPLOAD_TEMP_DIR,
    limits: { fileSize: 50 * 1024 * 1024, files: 20 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ALLOWED_EXTENSIONS.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error(`Unsupported file type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`));
        }
    }
});

// ─── Onboarding Session Store ────────────────────────────────────────────────
const onboardingSessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

setInterval(() => {
    const now = Date.now();
    for (const [id, session] of onboardingSessions) {
        if (now - session.createdAt > SESSION_TTL_MS) {
            // Clean up temp directory
            if (session.dataDir && fs.existsSync(session.dataDir)) {
                fs.rmSync(session.dataDir, { recursive: true, force: true });
            }
            onboardingSessions.delete(id);
        }
    }
}, 10 * 60 * 1000); // Sweep every 10 minutes

// ─── Health Check ────────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
    try {
        const db = require('../db/connection');
        db.prepare('SELECT 1').get();
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            dataset: getActiveConfig().name
        });
    } catch (err) {
        res.status(503).json({ status: 'unavailable', error: err.message });
    }
});

// ─── Provider Health Status ──────────────────────────────────────────────────
router.get('/providers', (req, res) => {
    const { getProviderStatus } = require('../query/llmClient');
    res.json(getProviderStatus());
});

// ─── Dataset Metadata Endpoint ───────────────────────────────────────────────
router.get('/dataset', (req, res) => {
    const config = getActiveConfig();
    return res.status(200).json({
        name: config.name,
        displayName: config.displayName,
        description: config.description,
        version: config.version || null,
        tables: config.tables.map(t => ({
            name: t.name,
            displayName: t.displayName,
            columns: t.columns,
            primaryKey: t.primaryKey
        })),
        relationships: config.relationships.map(r => ({
            from: r.from,
            to: r.to,
            label: r.label,
            joinType: r.joinType,
            description: r.description
        })),
        entityCount: config.entities ? config.entities.length : 0,
        tableCount: config.tables.length,
    });
});

// ─── Raw Data Upload (Step 1: Infer Schema + Relationships) ─────────────────
router.post('/dataset/upload/raw', rateLimit, upload.array('files', 20), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({
                success: false,
                error: { message: 'No files uploaded.', type: 'VALIDATION_ERROR' }
            });
        }

        // Read uploaded files — extract ZIP contents inline
        const files = [];
        for (const file of req.files) {
            const ext = path.extname(file.originalname).toLowerCase();
            if (ext === '.zip') {
                try {
                    const zipFiles = extractZip(file.path);
                    files.push(...zipFiles);
                } catch (zipErr) {
                    // Clean up all multer temp files before returning
                    for (const f of req.files) {
                        fs.unlink(f.path, () => {});
                    }
                    return res.status(400).json({
                        success: false,
                        error: { message: `ZIP extraction failed: ${zipErr.message}`, type: 'VALIDATION_ERROR' }
                    });
                }
            } else {
                const content = fs.readFileSync(file.path, 'utf8');
                files.push({ filename: file.originalname, content });
            }
        }

        // Infer schema
        let schema;
        try {
            schema = inferSchema(files);
        } catch (err) {
            return res.status(400).json({
                success: false,
                error: { message: `Schema inference failed: ${err.message}`, type: 'VALIDATION_ERROR' }
            });
        }

        // Infer relationships
        const relationships = inferRelationships(schema.tables);

        // Create session directory and write JSONL files in loader-expected structure
        const sessionId = crypto.randomUUID();
        const sessionDir = path.join(UPLOAD_TEMP_DIR, sessionId);

        for (const table of schema.tables) {
            const tableDir = path.join(sessionDir, table.name);
            fs.mkdirSync(tableDir, { recursive: true });
            const jsonlContent = recordsToJSONL(table.records);
            fs.writeFileSync(path.join(tableDir, `${table.name}.jsonl`), jsonlContent, 'utf8');
        }

        // Store session
        onboardingSessions.set(sessionId, {
            tables: schema.tables,
            dataDir: sessionDir,
            createdAt: Date.now()
        });

        // Clean up multer temp files
        for (const file of req.files) {
            fs.unlink(file.path, () => {});
        }

        // Strip records from response (too large for client)
        const clientTables = schema.tables.map(({ records, ...rest }) => rest);

        return res.status(200).json({
            success: true,
            sessionId,
            schema: { tables: clientTables },
            relationships
        });

    } catch (e) {
        // Clean up multer temp files on error
        if (req.files) {
            for (const file of req.files) {
                fs.unlink(file.path, () => {});
            }
        }
        console.error('[RAW_UPLOAD] Error:', e.message);
        return res.status(500).json({
            success: false,
            error: { message: `Raw upload failed: ${e.message}`, type: 'API_ERROR' }
        });
    }
});

// ─── Raw Data Confirm (Step 2: Generate Config + Load Dataset) ──────────────
router.post('/dataset/upload/confirm', rateLimit, async (req, res) => {
    if (isDatasetUpdating) {
        return res.status(503).json({
            success: false,
            error: { message: 'A dataset upload is already in progress. Please retry shortly.', type: 'CONFLICT' }
        });
    }

    const previousConfig = getActiveConfig();
    isDatasetUpdating = true;

    try {
        const { sessionId, name, tables, relationships } = req.body;

        if (!sessionId || !onboardingSessions.has(sessionId)) {
            return res.status(400).json({
                success: false,
                error: { message: 'Invalid or expired session. Please re-upload your files.', type: 'VALIDATION_ERROR' }
            });
        }

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return res.status(400).json({
                success: false,
                error: { message: 'Dataset name is required.', type: 'VALIDATION_ERROR' }
            });
        }

        const session = onboardingSessions.get(sessionId);

        // Sanitize dataset name for filesystem
        const safeName = name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
        if (!safeName) {
            return res.status(400).json({
                success: false,
                error: { message: 'Dataset name must contain at least one alphanumeric character.', type: 'VALIDATION_ERROR' }
            });
        }

        // Copy files from temp session dir to permanent datasets/<name>/ directory
        const permanentDir = path.resolve(__dirname, '../../datasets', safeName);
        if (fs.existsSync(permanentDir)) {
            fs.rmSync(permanentDir, { recursive: true, force: true });
        }
        fs.cpSync(session.dataDir, permanentDir, { recursive: true });

        // Generate config
        let config;
        try {
            config = generateConfig({
                name: safeName,
                tables: tables || session.tables.map(({ records, ...rest }) => rest),
                relationships: relationships || [],
                dataDir: permanentDir
            });
        } catch (err) {
            return res.status(400).json({
                success: false,
                error: { message: `Config generation failed: ${err.message}`, type: 'VALIDATION_ERROR' }
            });
        }

        // Validate generated config (schema + relationships only, no data file check yet)
        try {
            validateDatasetConfig(config, permanentDir);
        } catch (err) {
            return res.status(400).json({
                success: false,
                error: { message: `Validation failed: ${err.message}`, type: 'VALIDATION_ERROR' }
            });
        }

        // Stamp version
        config.version = new Date().toISOString();

        // Load into database
        console.log(`[RAW_CONFIRM] Activating dataset: ${config.name} (v${config.version})`);

        try {
            await initDB(config);
            const totalRows = await loadDataset(config);
            setActiveConfig(config);
            queryService.clearCache();

            // Clean up session
            if (session.dataDir && fs.existsSync(session.dataDir)) {
                fs.rmSync(session.dataDir, { recursive: true, force: true });
            }
            onboardingSessions.delete(sessionId);

            console.log(`[RAW_CONFIRM] Dataset "${config.name}" activated. ${totalRows} rows loaded.`);

            return res.status(200).json({
                success: true,
                message: `Dataset '${config.name}' loaded successfully.`,
                dataset: config.name,
                version: config.version,
                tablesCreated: config.tables.length,
                rowsLoaded: totalRows,
                queryPlan: 'INFER → VALIDATE → INIT → LOAD → QUERY'
            });

        } catch (loadErr) {
            console.error(`[RAW_CONFIRM] Load failed, restoring "${previousConfig.name}":`, loadErr.message);
            try {
                await initDB(previousConfig);
                if (previousConfig.dataDir) await loadDataset(previousConfig);
            } catch (restoreErr) {
                console.error(`[RAW_CONFIRM] Restore also failed:`, restoreErr.message);
            }
            setActiveConfig(previousConfig);

            return res.status(500).json({
                success: false,
                error: { message: `Dataset load failed (restored previous): ${loadErr.message}`, type: 'LOAD_ERROR' }
            });
        }

    } catch (e) {
        setActiveConfig(previousConfig);
        console.error('[RAW_CONFIRM] Error:', e.message);
        return res.status(500).json({
            success: false,
            error: { message: `Confirm failed: ${e.message}`, type: 'API_ERROR' }
        });
    } finally {
        isDatasetUpdating = false;
    }
});

// ─── Dataset Upload & Activation Endpoint (Config JSON) ─────────────────────
router.post('/dataset/upload', rateLimit, async (req, res) => {
    if (isDatasetUpdating) {
        return res.status(503).json({
            success: false,
            error: { message: 'A dataset upload is already in progress. Please retry shortly.', type: 'CONFLICT' }
        });
    }

    const previousConfig = getActiveConfig();
    isDatasetUpdating = true;

    try {
        const { config } = req.body;

        // ── Basic Shape Validation ──────────────────────────────
        if (!config || typeof config !== 'object') {
            return res.status(400).json({
                success: false,
                error: { message: 'Request body must contain a "config" object.', type: 'VALIDATION_ERROR' }
            });
        }

        if (!config.name || typeof config.name !== 'string') {
            return res.status(400).json({
                success: false,
                error: { message: 'Config must have a "name" string.', type: 'VALIDATION_ERROR' }
            });
        }

        if (!Array.isArray(config.domainKeywords) || config.domainKeywords.length === 0) {
            return res.status(400).json({
                success: false,
                error: { message: 'Config must contain a non-empty "domainKeywords" array.', type: 'VALIDATION_ERROR' }
            });
        }

        // ── Strict Schema + Relationship + Data Validation ──────
        // Fails fast BEFORE any loader/DB work begins.
        const resolvedDataDir = config.dataDir
            ? path.resolve(__dirname, '../db', config.dataDir)
            : null;

        try {
            validateDatasetConfig(config, resolvedDataDir);
        } catch (validationErr) {
            return res.status(400).json({
                success: false,
                error: { message: validationErr.message, type: 'VALIDATION_ERROR' }
            });
        }

        // ── Stamp version ───────────────────────────────────────
        config.version = new Date().toISOString();

        // ── Load Dataset ─────────────────────────────────────────
        // On failure: restore previous config and reinitialize previous schema.
        // The loader manages its own per-table transactions internally.
        console.log(`[DATASET_UPLOAD] Activating dataset: ${config.name} (v${config.version})`);

        try {
            // 1. Drop existing tables, init schema from new config
            await initDB(config);

            // 2. Load data from config.dataDir (if data exists)
            let totalRows = 0;
            if (config.dataDir) {
                totalRows = await loadDataset(config);
            }

            // 3. Only set active config AFTER successful load
            setActiveConfig(config);

            // 4. Clear query cache (stale for new dataset)
            queryService.clearCache();

            console.log(`[DATASET_UPLOAD] Dataset "${config.name}" activated. ${totalRows} rows loaded.`);

            return res.status(200).json({
                success: true,
                message: `Dataset '${config.name}' loaded successfully.`,
                dataset: config.name,
                version: config.version,
                tablesCreated: config.tables.length,
                rowsLoaded: totalRows,
                queryPlan: 'VALIDATE → INIT → LOAD → QUERY'
            });

        } catch (loadErr) {
            // Restore previous dataset — reinit schema and reload data
            console.error(`[DATASET_UPLOAD] Load failed, restoring "${previousConfig.name}":`, loadErr.message);
            try {
                await initDB(previousConfig);
                if (previousConfig.dataDir) await loadDataset(previousConfig);
            } catch (restoreErr) {
                console.error(`[DATASET_UPLOAD] Restore also failed:`, restoreErr.message);
            }
            setActiveConfig(previousConfig);

            return res.status(500).json({
                success: false,
                error: { message: `Dataset load failed (restored previous): ${loadErr.message}`, type: 'LOAD_ERROR' }
            });
        }

    } catch (e) {
        // Restore previous config on any unexpected error
        setActiveConfig(previousConfig);
        console.error('[DATASET_UPLOAD] Error:', e.message);
        return res.status(500).json({
            success: false,
            error: { message: `Dataset upload failed: ${e.message}`, type: 'API_ERROR' }
        });
    } finally {
        isDatasetUpdating = false;
    }
});

router.post('/query', rateLimit, async (req, res) => {
    // Block queries while a dataset upload is in progress
    if (isDatasetUpdating) {
        return res.status(503).json({
            success: false,
            error: { message: 'Dataset is being updated. Please retry shortly.', type: 'SERVICE_UNAVAILABLE' }
        });
    }

    // 1. Generate unique request ID for tracing
    const requestId = crypto.randomUUID();

    try {
        const { query } = req.body;

        // Validation Rules
        if (!query || typeof query !== 'string') {
            return res.status(400).json({
                success: false,
                requestId,
                error: { message: 'Query parameter is missing or invalid type.', type: 'VALIDATION_ERROR' }
            });
        }

        const trimmedQuery = query.trim();

        if (trimmedQuery.length < 5) {
            return res.status(400).json({
                success: false,
                requestId,
                error: { message: 'Query must be at least 5 characters.', type: 'VALIDATION_ERROR' }
            });
        }

        if (trimmedQuery.length > 500) {
            return res.status(400).json({
                success: false,
                requestId,
                error: { message: 'Query exceeds max length of 500 characters.', type: 'VALIDATION_ERROR' }
            });
        }

        // Reject raw SQL input — this system accepts natural language only
        if (/^\s*(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i.test(trimmedQuery)) {
            return res.status(400).json({
                success: false,
                requestId,
                error: { message: 'Raw SQL queries are not allowed. Please use natural language.', type: 'VALIDATION_ERROR' }
            });
        }

        // SQL visibility flag — defaults to false (SQL hidden from response)
        const includeSql = req.body.includeSql === true;

        // Pass to engine with options
        const result = await queryService.processQuery(trimmedQuery, requestId, { includeSql });

        // Format and Return explicitly exactly as required
        if (!result.success && result.error) {
            return res.status(400).json({
                success: false,
                requestId,
                error: result.error
            });
        }

        const activeConfig = getActiveConfig();

        return res.status(200).json({
            success: true,
            requestId,
            dataset: result.dataset || activeConfig.name,
            query: trimmedQuery,
            sql: result.generatedSql,                          // undefined when includeSql=false
            rowCount: result.rowCount,                         // Exact total matching
            data: result.data || [],                           // Protected list, max length 100
            graph: result.graph || { nodes: [], edges: [] },
            highlightNodes: result.highlightNodes || [],
            executionTimeMs: Number(result.executionTimeMs),
            reason: result.reason,
            resultStatus: result.resultStatus || null,         // "INCOMPLETE_FLOW" | "NO_GAPS_FOUND" | "NO_MATCH" | null
            message: result.message || null,                   // Zero-row human-readable message
            suggestions: result.suggestions,
            summary: result.summary,
            nlAnswer: result.nlAnswer || null,
            queryType: result.queryType,                       // "SQL" | "HYBRID" | "RAG"
            explanation: result.explanation || null,           // { intent, entities, strategy, explanationText }
            confidence: result.confidence ?? null,             // 0.0–1.0 reliability score
            confidenceLabel: result.confidenceLabel || null,   // "High" | "Medium" | "Low"
            confidenceReasons: result.confidenceReasons || [], // Human-readable score reasons
            executionPlan: result.executionPlan || null,         // "RULE_BASED" | "LLM" | "FALLBACK"
            queryPlan: result.queryPlan || null,               // { type, tablesUsed, joinPath, reasoning }
            complexity: result.complexity || null,             // "SIMPLE" | "MODERATE" | "COMPLEX" (model routing)
            truncated: result.truncated || false,              // true if rows were capped at 1000
            graphTruncated: result.graphTruncated || false     // true if graph nodes were capped at 200
        });

    } catch (e) {
        console.error(`[API-${requestId}] Route Error:`, e.message);
        return res.status(500).json({
            success: false,
            requestId,
            error: { message: 'Internal processing error', type: 'API_ERROR' }
        });
    }
});

module.exports = router;
