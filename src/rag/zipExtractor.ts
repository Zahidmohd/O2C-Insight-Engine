/**
 * ZIP file extraction for structured data uploads.
 * Extracts CSV/JSONL/JSON files from a ZIP archive, flattens nested directories,
 * and returns an array compatible with inferSchema(files).
 */

import AdmZip from 'adm-zip';
import path from 'path';

const ALLOWED_DATA_EXTENSIONS: string[] = ['.csv', '.jsonl', '.json'];
const SKIP_PATTERNS: string[] = ['__MACOSX', '.DS_Store', 'Thumbs.db'];

interface ExtractedFile {
    filename: string;
    content: string;
}

/**
 * Extracts supported data files from a ZIP buffer or file path.
 */
function extractZip(zipInput: Buffer | string): ExtractedFile[] {
    const zip = new AdmZip(zipInput);
    const entries = zip.getEntries();
    const files: ExtractedFile[] = [];

    for (const entry of entries) {
        // Skip directories
        if (entry.isDirectory) continue;

        const entryPath = entry.entryName;

        // Skip hidden/system files
        if (SKIP_PATTERNS.some((p: string) => entryPath.includes(p))) continue;

        // Skip files starting with .
        const basename = path.basename(entryPath);
        if (basename.startsWith('.')) continue;

        // Only extract supported data file types
        const ext = path.extname(basename).toLowerCase();
        if (!ALLOWED_DATA_EXTENSIONS.includes(ext)) continue;

        // Flatten nested dirs: "orders/items.csv" → "orders_items.csv"
        const flatName = entryPath.replace(/\//g, '_').replace(/\\/g, '_');

        const content = entry.getData().toString('utf8');
        if (!content.trim()) continue; // Skip empty files

        files.push({ filename: flatName, content });
    }

    if (files.length === 0) {
        throw new Error('ZIP file contains no supported data files (.csv, .jsonl, .json).');
    }

    return files;
}

export { extractZip };
