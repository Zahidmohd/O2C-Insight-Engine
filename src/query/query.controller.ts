import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
  HttpStatus,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { diskStorage } from 'multer';
import * as os from 'os';
import { Public } from '../auth/public.decorator';
import { RateLimitGuard } from './rate-limit.guard';
import { QueryService } from './query.service';
import { MetricsService } from '../metrics/metrics.service';

const UPLOAD_TEMP_DIR = path.join(os.tmpdir(), 'o2c-onboarding-uploads');
const ALLOWED_EXTENSIONS = ['.jsonl', '.csv', '.json', '.zip'];

@Controller()
export class QueryController {
  constructor(
    private readonly queryService: QueryService,
    private readonly metricsService: MetricsService,
  ) {}

  // ─── Health Check ─────────────────────────────────────────────────────────
  @Public()
  @Get('health')
  async health(@Req() req: Request, @Res() res: Response): Promise<any> {
    try {
      const result = await this.queryService.getHealth(
        (req as any).db,
        (req as any).config,
        (req as any).tenantId,
      );
      return res.json(result);
    } catch (err: any) {
      return res
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json({ status: 'unavailable', error: err.message });
    }
  }

  // ─── Provider Health Status ───────────────────────────────────────────────
  @Public()
  @Get('providers')
  providers(@Res() res: Response): any {
    return res.json(this.queryService.getProviders());
  }

  // ─── Dataset Metadata ────────────────────────────────────────────────────
  @Get('dataset')
  dataset(@Req() req: Request, @Res() res: Response): any {
    const config = (req as any).config;
    return res.status(HttpStatus.OK).json(this.queryService.getDataset(config));
  }

  // ─── Main Query Endpoint ──────────────────────────────────────────────────
  @UseGuards(RateLimitGuard)
  @Post('query')
  async query(
    @Body() body: { query: string; includeSql?: boolean; enableGraph?: boolean },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<any> {
    // Block queries while a dataset upload is in progress
    if (this.queryService.isUpdating()) {
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        success: false,
        error: {
          message: 'Dataset is being updated. Please retry shortly.',
          type: 'SERVICE_UNAVAILABLE',
        },
      });
    }

    const requestId = crypto.randomUUID();
    const traceId = requestId;
    const pipelineStart = Date.now();

    try {
      const { query } = body;

      // Validation rules
      if (!query || typeof query !== 'string') {
        return res.status(HttpStatus.BAD_REQUEST).json({
          success: false,
          requestId,
          error: {
            message: 'Query parameter is missing or invalid type.',
            type: 'VALIDATION_ERROR',
          },
        });
      }

      const trimmedQuery = query.trim();

      if (trimmedQuery.length < 5) {
        return res.status(HttpStatus.BAD_REQUEST).json({
          success: false,
          requestId,
          error: {
            message: 'Query must be at least 5 characters.',
            type: 'VALIDATION_ERROR',
          },
        });
      }

      if (trimmedQuery.length > 500) {
        return res.status(HttpStatus.BAD_REQUEST).json({
          success: false,
          requestId,
          error: {
            message: 'Query exceeds max length of 500 characters.',
            type: 'VALIDATION_ERROR',
          },
        });
      }

      // Reject raw SQL input -- this system accepts natural language only
      if (
        /^\s*(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i.test(
          trimmedQuery,
        )
      ) {
        return res.status(HttpStatus.BAD_REQUEST).json({
          success: false,
          requestId,
          error: {
            message:
              'Raw SQL queries are not allowed. Please use natural language.',
            type: 'VALIDATION_ERROR',
          },
        });
      }

      // SQL visibility flag -- defaults to false (SQL hidden from response)
      const includeSql = body.includeSql === true;

      // Pass to engine with options
      const result = await this.queryService.processQuery(
        trimmedQuery,
        requestId,
        { includeSql, tenantId: (req as any).tenantId },
        (req as any).db,
        (req as any).config,
      );

      // Format and return
      if (!result.success && result.error) {
        return res.status(HttpStatus.BAD_REQUEST).json({
          success: false,
          requestId,
          error: result.error,
        });
      }

      const activeConfig = (req as any).config;

      // Derive dataConfidence from existing confidence + query plan
      const qp = result.queryPlan;
      const joinCount = qp && qp.joinPath ? qp.joinPath.length : 0;
      const conf = result.confidence ?? 0;
      const dataConfidence = {
        level: conf >= 0.8 ? 'HIGH' : conf >= 0.5 ? 'MEDIUM' : 'LOW',
        reason:
          joinCount >= 3
            ? `Multi-hop query across ${joinCount} joins — ${conf >= 0.8 ? 'all stages connected' : 'some stages may be incomplete'}`
            : joinCount >= 1
              ? `Cross-table query with ${joinCount} join(s) — data availability ${conf >= 0.8 ? 'confirmed' : 'partial'}`
              : `Direct table query — ${result.rowCount > 0 ? 'data found' : 'no matching records'}`,
      };

      // Timing metrics
      const totalTimeMs = Date.now() - pipelineStart;
      const sqlTimeMs = Number(result.executionTimeMs) || 0;
      const metrics = {
        totalTimeMs,
        sqlTimeMs,
        llmTimeMs: Math.max(0, totalTimeMs - sqlTimeMs),
      };

      // Record metrics for observability
      this.metricsService.recordQuery({
        latencyMs: totalTimeMs,
        cacheHit: result.cacheSource != null,
        provider: result.providerUsed || undefined,
        queryType: result.queryType || 'SQL',
        tenantId: (req as any).tenantId || null,
        error: !result.success,
      });

      // Optional debug info (only in DEBUG_MODE)
      const debug =
        process.env.DEBUG_MODE === 'true'
          ? {
              tenantId: (req as any).tenantId || null,
              mode: (req as any).db?.type || 'sqlite',
              db: (req as any).db?.type || 'sqlite',
              config: activeConfig.name,
              tablesUsed: qp?.tablesUsed || [],
            }
          : undefined;

      return res.status(HttpStatus.OK).json({
        success: true,
        requestId,
        traceId,
        dataset: result.dataset || activeConfig.name,
        query: trimmedQuery,
        sql: result.generatedSql, // undefined when includeSql=false
        rowCount: result.rowCount,
        data: result.data || [],
        graph: result.graph || { nodes: [], edges: [] },
        highlightNodes: result.highlightNodes || [],
        executionTimeMs: Number(result.executionTimeMs),
        metrics,
        reason: result.reason,
        resultStatus: result.resultStatus || null,
        message: result.message || null,
        suggestions: result.suggestions,
        summary: result.summary,
        nlAnswer: result.nlAnswer || null,
        queryType: result.queryType,
        explanation: result.explanation || null,
        confidence: result.confidence ?? null,
        confidenceLabel: result.confidenceLabel || null,
        confidenceReasons: result.confidenceReasons || [],
        dataConfidence,
        executionPlan: result.executionPlan || null,
        queryPlan: result.queryPlan || null,
        complexity: result.complexity || null,
        truncated: result.truncated || false,
        graphTruncated: result.graphTruncated || false,
        debug,
      });
    } catch (e: any) {
      console.error(`[API-${requestId}] Route Error:`, e.message);
      this.metricsService.recordQuery({
        latencyMs: Date.now() - pipelineStart,
        cacheHit: false,
        queryType: 'ERROR',
        tenantId: (req as any).tenantId || null,
        error: true,
      });
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        success: false,
        requestId,
        error: { message: 'Internal processing error', type: 'API_ERROR' },
      });
    }
  }

  // ─── Raw Data Upload (Step 1: Infer Schema + Relationships) ───────────────
  @UseGuards(RateLimitGuard)
  @Post('dataset/upload/raw')
  @UseInterceptors(
    FilesInterceptor('files', 20, {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          if (!fs.existsSync(UPLOAD_TEMP_DIR)) {
            fs.mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });
          }
          cb(null, UPLOAD_TEMP_DIR);
        },
      }),
      limits: { fileSize: 50 * 1024 * 1024, files: 20 },
      fileFilter: (_req: any, file: any, cb: any) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ALLOWED_EXTENSIONS.includes(ext)) {
          cb(null, true);
        } else {
          cb(
            new Error(
              `Unsupported file type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
            ),
          );
        }
      },
    }),
  )
  async uploadRaw(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<any> {
    try {
      const files = (req as any).files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(HttpStatus.BAD_REQUEST).json({
          success: false,
          error: {
            message: 'No files uploaded.',
            type: 'VALIDATION_ERROR',
          },
        });
      }

      const result = this.queryService.uploadRaw(files);

      return res.status(HttpStatus.OK).json({
        success: true,
        ...result,
      });
    } catch (e: any) {
      // Clean up multer temp files on error
      const files = (req as any).files as Express.Multer.File[] | undefined;
      if (files) {
        for (const file of files) {
          fs.unlink(file.path, () => {});
        }
      }
      console.error('[RAW_UPLOAD] Error:', e.message);
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        success: false,
        error: {
          message: `Raw upload failed: ${e.message}`,
          type: 'API_ERROR',
        },
      });
    }
  }

  // ─── Raw Data Confirm (Step 2: Generate Config + Load Dataset) ────────────
  @UseGuards(RateLimitGuard)
  @Post('dataset/upload/confirm')
  async confirmUpload(
    @Body()
    body: {
      sessionId: string;
      name: string;
      tables?: any[];
      relationships?: any[];
    },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<any> {
    if (this.queryService.isUpdating()) {
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        success: false,
        error: {
          message:
            'A dataset upload is already in progress. Please retry shortly.',
          type: 'CONFLICT',
        },
      });
    }

    const result = await this.queryService.confirmUpload(
      body,
      (req as any).db,
      (req as any).tenantId,
    );

    return res.status(result.status).json(result.body);
  }

  // ─── Legacy Dataset Upload (Single-Step Config JSON) ──────────────────────
  @UseGuards(RateLimitGuard)
  @Post('dataset/upload')
  async uploadLegacy(
    @Body() body: { config: any },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<any> {
    if (this.queryService.isUpdating()) {
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        success: false,
        error: {
          message:
            'A dataset upload is already in progress. Please retry shortly.',
          type: 'CONFLICT',
        },
      });
    }

    const result = await this.queryService.uploadLegacy(
      body,
      (req as any).db,
      (req as any).tenantId,
    );

    return res.status(result.status).json(result.body);
  }
}
