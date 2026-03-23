const express = require('express');
const router = express.Router();
const queryService = require('../query/queryService');

router.post('/query', async (req, res) => {
    try {
        const { query } = req.body;

        // Validation Rules
        if (!query || typeof query !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'Query parameter is missing or invalid type.'
            });
        }

        const trimmedQuery = query.trim();

        if (trimmedQuery.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Query cannot be empty.'
            });
        }

        if (trimmedQuery.length > 500) {
            return res.status(400).json({
                success: false,
                error: 'Query exceeds max length of 500 characters.'
            });
        }

        // Pass to engine
        const result = await queryService.processQuery(trimmedQuery);

        // Format and Return explicitly exactly as required
        if (result.error) {
            return res.status(400).json({
                success: false,
                error: result.error
            });
        }

        return res.status(200).json({
            success: true,
            query: trimmedQuery,
            sql: result.generatedSql,
            rowCount: result.rowCount,
            data: result.data || [],
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
