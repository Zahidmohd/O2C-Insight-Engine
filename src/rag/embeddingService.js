/**
 * Local embedding service using Hugging Face Transformers.js.
 * Model: Xenova/all-MiniLM-L6-v2 (384-dim, ~80MB, ONNX/WASM).
 *
 * Lazy-loads on first call. No API keys needed.
 */

let pipelineInstance = null;
let loadingPromise = null;

async function getEmbedder() {
    if (pipelineInstance) return pipelineInstance;

    // Prevent concurrent loading
    if (loadingPromise) return loadingPromise;

    loadingPromise = (async () => {
        try {
            console.log('[EMBEDDING] Loading model Xenova/all-MiniLM-L6-v2 (first call may take 10-30s)...');
            const { pipeline } = await import('@huggingface/transformers');
            pipelineInstance = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
                dtype: 'fp32'
            });
            console.log('[EMBEDDING] Model loaded successfully.');
            return pipelineInstance;
        } catch (err) {
            loadingPromise = null;
            throw new Error(`Failed to load embedding model: ${err.message}`);
        }
    })();

    return loadingPromise;
}

/**
 * Embeds a single text string into a 384-dim vector.
 * @param {string} text
 * @returns {Promise<number[]>} Normalized 384-dim embedding
 */
async function embed(text) {
    if (!text || !text.trim()) {
        throw new Error('Cannot embed empty text.');
    }
    const embedder = await getEmbedder();
    const output = await embedder(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}

/**
 * Embeds multiple texts in batches.
 * @param {string[]} texts
 * @param {number} batchSize
 * @returns {Promise<number[][]>}
 */
async function embedBatch(texts, batchSize = 32) {
    const embedder = await getEmbedder();
    const results = [];

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const outputs = await Promise.all(
            batch.map(async (text) => {
                const output = await embedder(text, { pooling: 'mean', normalize: true });
                return Array.from(output.data);
            })
        );
        results.push(...outputs);
    }

    return results;
}

module.exports = { embed, embedBatch };
