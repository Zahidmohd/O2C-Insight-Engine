const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const queryService = require('../query/queryService');

/**
 * In-memory rate limiter — 20 requests per minute per IP.
 * Entries auto-reset after the 1-minute window expires.
 */
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

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

router.post('/query', rateLimit, async (req, res) => {
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

        if (trimmedQuery.length === 0) {
            return res.status(400).json({
                success: false,
                requestId,
                error: { message: 'Query cannot be empty.', type: 'VALIDATION_ERROR' }
            });
        }

        if (trimmedQuery.length > 500) {
            return res.status(400).json({
                success: false,
                requestId,
                error: { message: 'Query exceeds max length of 500 characters.', type: 'VALIDATION_ERROR' }
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

        return res.status(200).json({
            success: true,
            requestId,
            query: trimmedQuery,
            sql: result.generatedSql,                          // undefined when includeSql=false
            rowCount: result.rowCount,                         // Exact total matching
            data: result.data || [],                           // Protected list, max length 100
            graph: result.graph || { nodes: [], edges: [] },
            highlightNodes: result.highlightNodes || [],
            executionTimeMs: Number(result.executionTimeMs),
            reason: result.reason,
            message: result.message || null,                   // Zero-row human-readable message
            suggestions: result.suggestions,
            summary: result.summary,
            nlAnswer: result.nlAnswer || null,
            queryType: result.queryType,                       // "SQL" | "HYBRID" | "RAG"
            explanation: result.explanation || null,           // { intent, entities, strategy, explanationText }
            confidence: result.confidence ?? null,             // 0.0–1.0 reliability score
            confidenceLabel: result.confidenceLabel || null,   // "High" | "Medium" | "Low"
            confidenceReasons: result.confidenceReasons || [], // Human-readable score reasons
            queryPlan: result.queryPlan || null,               // "RULE_BASED" | "LLM" | "FALLBACK"
            truncated: result.truncated || false               // true if rows were capped at 1000
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
