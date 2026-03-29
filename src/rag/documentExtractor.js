/**
 * Text extraction from uploaded documents (PDF, DOCX, TXT, MD).
 * Uses pdf-parse for PDFs and officeparser for DOCX/PPTX/ODT.
 */

const fs = require('fs');
const path = require('path');

/**
 * Extracts plain text from a file based on its extension.
 * @param {string} filePath - Absolute path to the uploaded file
 * @param {string} ext - File extension (lowercase, with dot)
 * @returns {Promise<string>} Extracted text content
 */
async function extractText(filePath, ext) {
    switch (ext) {
        case '.pdf': {
            const pdfParse = require('pdf-parse');
            const buffer = fs.readFileSync(filePath);
            const data = await pdfParse(buffer);
            const text = data.text.trim();
            if (!text) throw new Error('PDF file contains no extractable text.');
            return text;
        }

        case '.docx':
        case '.pptx':
        case '.odt': {
            const { parseOfficeAsync } = require('officeparser');
            const text = await parseOfficeAsync(filePath);
            if (!text || !text.trim()) throw new Error(`${ext.toUpperCase()} file contains no extractable text.`);
            return text.trim();
        }

        case '.txt':
        case '.md': {
            const text = fs.readFileSync(filePath, 'utf8').trim();
            if (!text) throw new Error('Text file is empty.');
            return text;
        }

        default:
            throw new Error(`Unsupported file type: ${ext}`);
    }
}

module.exports = { extractText };
