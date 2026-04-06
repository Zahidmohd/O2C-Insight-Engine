/**
 * Local embedding service using Hugging Face Transformers.js.
 * Model: Xenova/all-MiniLM-L6-v2 (384-dim, ~80MB, ONNX/WASM).
 *
 * Lazy-loads on first call. No API keys needed.
 */

let pipelineInstance: any = null;
let loadingPromise: Promise<any> | null = null;

async function getEmbedder(): Promise<any> {
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
        } catch (err: any) {
            loadingPromise = null;
            throw new Error(`Failed to load embedding model: ${err.message}`);
        }
    })();

    return loadingPromise;
}

/**
 * Embeds a single text string into a 384-dim vector.
 */
async function embed(text: string): Promise<number[]> {
    if (!text || !text.trim()) {
        throw new Error('Cannot embed empty text.');
    }
    const embedder = await getEmbedder();
    const output = await embedder(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data) as number[];
}

/**
 * Embeds multiple texts in batches.
 */
async function embedBatch(texts: string[], batchSize: number = 32): Promise<number[][]> {
    const embedder = await getEmbedder();
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const outputs = await Promise.all(
            batch.map(async (text: string) => {
                const output = await embedder(text, { pooling: 'mean', normalize: true });
                return Array.from(output.data) as number[];
            })
        );
        results.push(...outputs);
    }

    return results;
}

export { embed, embedBatch };
