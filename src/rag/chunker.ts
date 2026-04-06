/**
 * Recursive character text splitter for document chunking.
 * No external dependencies — pure TS implementation.
 *
 * chunkText(text, opts) → string[]
 * chunkDocument(text, metadata) → Array<{text, index, metadata}>
 */

const DEFAULT_CHUNK_SIZE: number = 500;
const DEFAULT_CHUNK_OVERLAP: number = 50;
const SEPARATORS: string[] = ['\n\n', '\n', '. ', ' '];

interface ChunkOptions {
    chunkSize?: number;
    chunkOverlap?: number;
}

interface DocumentChunk {
    text: string;
    index: number;
    metadata: any;
}

/**
 * Splits text into chunks using a recursive separator hierarchy.
 * Tries the largest separator first; if a segment exceeds chunkSize,
 * recurses with the next separator.
 */
function chunkText(text: string, { chunkSize = DEFAULT_CHUNK_SIZE, chunkOverlap = DEFAULT_CHUNK_OVERLAP }: ChunkOptions = {}): string[] {
    if (!text || text.length <= chunkSize) {
        return text ? [text] : [];
    }

    return splitRecursive(text, SEPARATORS, chunkSize, chunkOverlap);
}

function splitRecursive(text: string, separators: string[], chunkSize: number, chunkOverlap: number): string[] {
    if (text.length <= chunkSize) return [text];
    if (separators.length === 0) {
        // No separator left — hard split by character count
        return hardSplit(text, chunkSize, chunkOverlap);
    }

    const sep = separators[0];
    const remaining = separators.slice(1);
    const parts = text.split(sep).filter((p: string) => p.length > 0);

    if (parts.length === 0) return [text];

    const chunks: string[] = [];
    let current = '';

    for (const part of parts) {
        const candidate = current ? current + sep + part : part;

        if (candidate.length <= chunkSize) {
            current = candidate;
        } else {
            if (current) chunks.push(current);

            // If this single part exceeds chunkSize, recurse with next separator
            if (part.length > chunkSize) {
                const subChunks = splitRecursive(part, remaining, chunkSize, chunkOverlap);
                chunks.push(...subChunks);
                current = '';
            } else {
                current = part;
            }
        }
    }

    if (current) chunks.push(current);

    // Apply overlap between consecutive chunks
    if (chunkOverlap > 0 && chunks.length > 1) {
        return applyOverlap(chunks, chunkOverlap);
    }

    return chunks;
}

function hardSplit(text: string, chunkSize: number, chunkOverlap: number): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
        chunks.push(text.slice(start, start + chunkSize));
        start += chunkSize - chunkOverlap;
    }
    return chunks;
}

function applyOverlap(chunks: string[], overlap: number): string[] {
    const result: string[] = [chunks[0]];
    for (let i = 1; i < chunks.length; i++) {
        const prev = chunks[i - 1];
        const overlapText = prev.slice(-overlap);
        result.push(overlapText + chunks[i]);
    }
    return result;
}

/**
 * Chunks text and attaches metadata to each chunk.
 */
function chunkDocument(text: string, metadata: any = {}, opts: ChunkOptions = {}): DocumentChunk[] {
    const texts = chunkText(text, opts);
    return texts.map((t: string, i: number) => ({
        text: t,
        index: i,
        metadata
    }));
}

export { chunkText, chunkDocument };
