const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const queryService = require('../query/queryService');

router.post('/query', async (req, res) => {
    // 1. Generate unique request ID for tracing
    const requestId = crypto.randomUUID();
    
    try {
        const { query } = req.body;

        // Validation Rules
        if (!query || typeof query !== 'string') {
            return res.status(400).json({
                success: false,
                requestId,
                error: 'Query parameter is missing or invalid type.'
            });
        }

        const trimmedQuery = query.trim();

        if (trimmedQuery.length === 0) {
            return res.status(400).json({
                success: false,
                requestId,
                error: 'Query cannot be empty.'
            });
        }

        if (trimmedQuery.length > 500) {
            return res.status(400).json({
                success: false,
                requestId,
                error: 'Query exceeds max length of 500 characters.'
            });
        }

        // Pass to engine
        const result = await queryService.processQuery(trimmedQuery, requestId);

        // Format and Return explicitly exactly as required
        if (result.error) {
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
            sql: result.generatedSql,
            rowCount: result.rowCount, // Exact total matching
            data: result.data || [],   // Protected list, max length 100
            graph: result.graph || { nodes: [], edges: [] },
            executionTimeMs: result.executionTimeMs
        });

    } catch (e) {
        console.error('[Route Error]', e.message);
        return res.status(500).json({
            success: false,
            error: 'Internal processing error'
        });
    }
});

module.exports = router;
