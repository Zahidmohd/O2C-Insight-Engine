import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as path from 'path';
import { extractText } from '../rag/documentExtractor';
import { chunkDocument } from '../rag/chunker';
import { embedBatch } from '../rag/embeddingService';
import {
  initDocumentTables,
  insertDocument,
  insertChunks,
  listDocuments,
  getChunkCount,
  deleteDocument as deleteDoc,
} from '../rag/vectorStore';
import { retrieveContext } from '../rag/knowledgeBase';

@Injectable()
export class DocumentService implements OnModuleInit {
  private readonly logger = new Logger(DocumentService.name);

  async onModuleInit(): Promise<void> {
    this.logger.log('Initializing document tables...');
    await initDocumentTables();
    this.logger.log('Document tables initialized.');
  }

  /**
   * Upload a document: extract text -> chunk -> embed -> store in SQLite.
   */
  async uploadDocument(
    file: Express.Multer.File,
    db: any,
    tenantId?: string,
  ): Promise<{
    documentId: number;
    title: string;
    filename: string;
    chunkCount: number;
    characterCount: number;
  }> {
    const ext = path.extname(file.originalname).toLowerCase();
    const title = file.originalname.replace(/\.[^.]+$/, '');

    this.logger.log(
      `Processing "${file.originalname}" (${(file.size / 1024).toFixed(1)}KB)...`,
    );

    // 1. Extract text
    const text = await extractText(file.path, ext);
    this.logger.log(`Extracted ${text.length} characters.`);

    // 2. Chunk
    const chunks = chunkDocument(text, { title, filename: file.originalname });
    this.logger.log(`Created ${chunks.length} chunks.`);

    // 3. Embed all chunks
    this.logger.log(
      `Embedding ${chunks.length} chunks (this may take a moment on first call)...`,
    );
    const chunkTexts = chunks.map((c: any) => c.text);
    const embeddings = await embedBatch(chunkTexts);

    // 4. Store in SQLite
    const documentId = await insertDocument(db, {
      title,
      filename: file.originalname,
      fileType: ext.slice(1),
      fileSize: file.size,
    });

    const chunksWithEmbeddings = chunks.map((c: any, i: number) => ({
      text: c.text,
      index: c.index,
      embedding: embeddings[i],
    }));
    await insertChunks(db, documentId, chunksWithEmbeddings);

    this.logger.log(
      `Document "${title}" stored (id=${documentId}, ${chunks.length} chunks).`,
    );

    return {
      documentId: Number(documentId),
      title,
      filename: file.originalname,
      chunkCount: chunks.length,
      characterCount: text.length,
    };
  }

  /**
   * List all uploaded documents for a tenant.
   */
  async listDocuments(
    db: any,
    tenantId?: string,
  ): Promise<{ documents: any[]; totalChunks: number }> {
    const documents = await listDocuments(db);
    const totalChunks = await getChunkCount(db);
    return { documents, totalChunks };
  }

  /**
   * Delete a document and its chunks by ID.
   */
  async deleteDocument(db: any, docId: number): Promise<void> {
    await deleteDoc(db, docId);
    this.logger.log(`Document ${docId} deleted.`);
  }

  /**
   * Retrieve RAG context for a query.
   */
  async retrieveContext(query: string): Promise<string | null> {
    return retrieveContext(query);
  }

  /**
   * Re-initialize document tables (useful for testing or reset).
   */
  async initDocumentTables(): Promise<void> {
    await initDocumentTables();
  }
}
