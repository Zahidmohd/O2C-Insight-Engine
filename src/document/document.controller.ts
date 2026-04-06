import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Res,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { diskStorage } from 'multer';
import { DocumentService } from './document.service';
import { Db, TenantId } from '../common/decorators/request-context.decorator';

const DOC_UPLOAD_DIR = path.join(os.tmpdir(), 'o2c-doc-uploads');
if (!fs.existsSync(DOC_UPLOAD_DIR)) {
  fs.mkdirSync(DOC_UPLOAD_DIR, { recursive: true });
}

const ALLOWED_DOC_EXTENSIONS = ['.pdf', '.txt', '.md', '.docx'];
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

@Controller('documents')
export class DocumentController {
  constructor(private readonly documentService: DocumentService) {}

  // ─── POST /documents/upload ───────────────────────────────────────────────
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({ destination: DOC_UPLOAD_DIR }),
      limits: { fileSize: MAX_FILE_SIZE, files: 1 },
      fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ALLOWED_DOC_EXTENSIONS.includes(ext)) {
          cb(null, true);
        } else {
          cb(
            new BadRequestException(
              `Unsupported file type: ${ext}. Allowed: ${ALLOWED_DOC_EXTENSIONS.join(', ')}`,
            ),
            false,
          );
        }
      },
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Db() db: any,
    @TenantId() tenantId: string,
    @Res() res: Response,
  ): Promise<void> {
    let tempPath: string | null = null;

    try {
      if (!file) {
        res.status(HttpStatus.BAD_REQUEST).json({
          success: false,
          error: { message: 'No file uploaded.', type: 'VALIDATION_ERROR' },
        });
        return;
      }

      tempPath = file.path;

      const result = await this.documentService.uploadDocument(
        file,
        db,
        tenantId,
      );

      res.status(HttpStatus.OK).json({
        success: true,
        ...result,
      });
    } catch (err: any) {
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        success: false,
        error: {
          message: `Document upload failed: ${err.message}`,
          type: 'PROCESSING_ERROR',
        },
      });
    } finally {
      // Clean up temp file
      if (tempPath && fs.existsSync(tempPath)) {
        fs.unlink(tempPath, () => {});
      }
    }
  }

  // ─── GET /documents ───────────────────────────────────────────────────────
  @Get()
  async list(
    @Db() db: any,
    @TenantId() tenantId: string,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const { documents, totalChunks } =
        await this.documentService.listDocuments(db, tenantId);

      res.status(HttpStatus.OK).json({
        success: true,
        documents,
        totalChunks,
      });
    } catch (err: any) {
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        success: false,
        error: {
          message: `Failed to list documents: ${err.message}`,
          type: 'API_ERROR',
        },
      });
    }
  }

  // ─── DELETE /documents/:id ────────────────────────────────────────────────
  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Db() db: any,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const docId = parseInt(id, 10);
      if (isNaN(docId)) {
        res.status(HttpStatus.BAD_REQUEST).json({
          success: false,
          error: { message: 'Invalid document ID.', type: 'VALIDATION_ERROR' },
        });
        return;
      }

      await this.documentService.deleteDocument(db, docId);

      res.status(HttpStatus.OK).json({
        success: true,
        message: `Document ${docId} deleted.`,
      });
    } catch (err: any) {
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        success: false,
        error: {
          message: `Failed to delete document: ${err.message}`,
          type: 'API_ERROR',
        },
      });
    }
  }
}
