import { Injectable } from '@nestjs/common';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { processQuery, clearCache } from './queryService';
import { inferSchema, recordsToJSONL } from '../onboarding/schemaInference';
import { inferRelationships } from '../onboarding/relationshipInference';
import { generateConfig } from '../onboarding/configGenerator';
import { extractZip } from '../rag/zipExtractor';
import initDB from '../db/init';
import { loadDataset } from '../db/loader';
import { embedKBEntries } from '../rag/knowledgeBase';
import { validateDatasetConfig } from '../config/datasetValidator';
import { getActiveConfig, setActiveConfig, getTenantConfig, setTenantConfig } from '../config/activeDataset';
import { getProviderStatus } from './llmClient';

const UPLOAD_TEMP_DIR = path.join(os.tmpdir(), 'o2c-onboarding-uploads');
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

@Injectable()
export class QueryService {
  /**
   * Global dataset update lock -- prevents queries from executing against a
   * half-loaded dataset. Set to true during upload, false when done.
   */
  private isDatasetUpdatingFlag = false;

  /**
   * In-memory onboarding session store.
   * Maps sessionId -> { tables, dataDir, createdAt }.
   */
  private readonly onboardingSessions = new Map<string, any>();

  private readonly sweepInterval: ReturnType<typeof setInterval>;

  constructor() {
    // Sweep expired onboarding sessions every 10 minutes
    this.sweepInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.onboardingSessions) {
        if (now - session.createdAt > SESSION_TTL_MS) {
          if (session.dataDir && fs.existsSync(session.dataDir)) {
            fs.rmSync(session.dataDir, { recursive: true, force: true });
          }
          this.onboardingSessions.delete(id);
        }
      }
    }, 10 * 60 * 1000);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  isUpdating(): boolean {
    return this.isDatasetUpdatingFlag;
  }

  /**
   * Main query processing -- delegates to the queryService.processQuery().
   */
  async processQuery(
    query: string,
    requestId: string,
    options: { includeSql?: boolean; tenantId?: string | null },
    db: any,
    config: any,
  ): Promise<any> {
    return processQuery(query, requestId, options, db, config);
  }

  /**
   * Health check -- pings the DB.
   */
  async getHealth(db: any, config: any, tenantId: string | null): Promise<any> {
    await db.getAsync('SELECT 1');
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      dataset: config.name,
      tenantId: tenantId || null,
    };
  }

  /**
   * Returns LLM provider health status.
   */
  getProviders(): any {
    return getProviderStatus();
  }

  /**
   * Returns metadata about the active dataset.
   */
  getDataset(config: any): any {
    return {
      name: config.name,
      displayName: config.displayName,
      description: config.description,
      version: config.version || null,
      tables: config.tables.map((t: any) => ({
        name: t.name,
        displayName: t.displayName,
        columns: t.columns,
        primaryKey: t.primaryKey,
      })),
      relationships: config.relationships.map((r: any) => ({
        from: r.from,
        to: r.to,
        label: r.label,
        joinType: r.joinType,
        description: r.description,
      })),
      entityCount: config.entities ? config.entities.length : 0,
      tableCount: config.tables.length,
    };
  }

  /**
   * Step 1 of raw upload: reads uploaded files, infers schema + relationships,
   * stores session, and returns inferred metadata.
   */
  uploadRaw(files: Express.Multer.File[]): {
    sessionId: string;
    schema: any;
    relationships: any;
  } {
    // Read uploaded files -- extract ZIP contents inline
    const parsedFiles: { filename: string; content: string }[] = [];
    for (const file of files) {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ext === '.zip') {
        const zipFiles = extractZip(file.path);
        parsedFiles.push(...zipFiles);
      } else {
        const content = fs.readFileSync(file.path, 'utf8');
        parsedFiles.push({ filename: file.originalname, content });
      }
    }

    // Infer schema
    const schema = inferSchema(parsedFiles);

    // Infer relationships
    const relationships = inferRelationships(schema.tables);

    // Create session directory and write JSONL files in loader-expected structure
    const sessionId = crypto.randomUUID();
    const sessionDir = path.join(UPLOAD_TEMP_DIR, sessionId);

    for (const table of schema.tables) {
      const tableDir = path.join(sessionDir, table.name);
      fs.mkdirSync(tableDir, { recursive: true });
      const jsonlContent = recordsToJSONL(table.records);
      fs.writeFileSync(
        path.join(tableDir, `${table.name}.jsonl`),
        jsonlContent,
        'utf8',
      );
    }

    // Store session
    this.onboardingSessions.set(sessionId, {
      tables: schema.tables,
      dataDir: sessionDir,
      createdAt: Date.now(),
    });

    // Clean up multer temp files
    for (const file of files) {
      fs.unlink(file.path, () => {});
    }

    // Strip records from response (too large for client)
    const clientTables = schema.tables.map(
      ({ records, ...rest }: any) => rest,
    );

    return {
      sessionId,
      schema: { tables: clientTables },
      relationships,
    };
  }

  /**
   * Step 2 of raw upload: generates config from session data and loads dataset.
   */
  async confirmUpload(
    body: {
      sessionId: string;
      name: string;
      tables?: any[];
      relationships?: any[];
    },
    db: any,
    tenantId: string | null,
  ): Promise<any> {
    const previousConfig = tenantId
      ? getTenantConfig(tenantId) || getActiveConfig()
      : getActiveConfig();

    this.isDatasetUpdatingFlag = true;

    try {
      const { sessionId, name, tables, relationships } = body;

      if (!sessionId || !this.onboardingSessions.has(sessionId)) {
        return {
          status: 400,
          body: {
            success: false,
            error: {
              message: 'Invalid or expired session. Please re-upload your files.',
              type: 'VALIDATION_ERROR',
            },
          },
        };
      }

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return {
          status: 400,
          body: {
            success: false,
            error: {
              message: 'Dataset name is required.',
              type: 'VALIDATION_ERROR',
            },
          },
        };
      }

      const session = this.onboardingSessions.get(sessionId);

      // Sanitize dataset name for filesystem
      const safeName = name
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
      if (!safeName) {
        return {
          status: 400,
          body: {
            success: false,
            error: {
              message:
                'Dataset name must contain at least one alphanumeric character.',
              type: 'VALIDATION_ERROR',
            },
          },
        };
      }

      // Copy files from temp session dir to permanent datasets/<name>/ directory
      const permanentDir = path.resolve(__dirname, '../../datasets', safeName);
      if (fs.existsSync(permanentDir)) {
        fs.rmSync(permanentDir, { recursive: true, force: true });
      }
      fs.cpSync(session.dataDir, permanentDir, { recursive: true });

      // Generate config
      let config: any;
      try {
        config = generateConfig({
          name: safeName,
          tables:
            tables ||
            session.tables.map(({ records, ...rest }: any) => rest),
          relationships: relationships || [],
          dataDir: permanentDir,
        });
      } catch (err: any) {
        return {
          status: 400,
          body: {
            success: false,
            error: {
              message: `Config generation failed: ${err.message}`,
              type: 'VALIDATION_ERROR',
            },
          },
        };
      }

      // Validate generated config
      try {
        validateDatasetConfig(config, permanentDir);
      } catch (err: any) {
        return {
          status: 400,
          body: {
            success: false,
            error: {
              message: `Validation failed: ${err.message}`,
              type: 'VALIDATION_ERROR',
            },
          },
        };
      }

      // Stamp version
      config.version = new Date().toISOString();

      // Load into database
      console.log(
        `[RAW_CONFIRM] Activating dataset: ${config.name} (v${config.version})`,
      );

      try {
        await initDB(config, db);
        const totalRows = await loadDataset(config, db);
        if (tenantId) {
          setTenantConfig(tenantId, config);
        } else {
          setActiveConfig(config);
        }
        clearCache(tenantId);

        // Embed KB entries as vector chunks for semantic schema search
        try { await embedKBEntries(config, db); } catch (_) {}

        // Clean up session
        if (session.dataDir && fs.existsSync(session.dataDir)) {
          fs.rmSync(session.dataDir, { recursive: true, force: true });
        }
        this.onboardingSessions.delete(sessionId);

        console.log(
          `[RAW_CONFIRM] Dataset "${config.name}" activated. ${totalRows} rows loaded.`,
        );

        return {
          status: 200,
          body: {
            success: true,
            message: `Dataset '${config.name}' loaded successfully.`,
            dataset: config.name,
            version: config.version,
            tablesCreated: config.tables.length,
            rowsLoaded: totalRows,
            queryPlan: 'INFER -> VALIDATE -> INIT -> LOAD -> QUERY',
          },
        };
      } catch (loadErr: any) {
        console.error(
          `[RAW_CONFIRM] Load failed, restoring "${previousConfig.name}":`,
          loadErr.message,
        );
        try {
          await initDB(previousConfig, db);
          if (previousConfig.dataDir) {
            await loadDataset(previousConfig, db);
          }
        } catch (restoreErr: any) {
          console.error(
            '[RAW_CONFIRM] Restore also failed:',
            restoreErr.message,
          );
        }
        if (tenantId) {
          setTenantConfig(tenantId, previousConfig);
        } else {
          setActiveConfig(previousConfig);
        }

        return {
          status: 500,
          body: {
            success: false,
            error: {
              message: `Dataset load failed (restored previous): ${loadErr.message}`,
              type: 'LOAD_ERROR',
            },
          },
        };
      }
    } catch (e: any) {
      console.error('[RAW_CONFIRM] Error:', e.message);
      return {
        status: 500,
        body: {
          success: false,
          error: {
            message: `Confirm failed: ${e.message}`,
            type: 'API_ERROR',
          },
        },
      };
    } finally {
      this.isDatasetUpdatingFlag = false;
    }
  }

  /**
   * Legacy single-step dataset upload (JSON config body).
   */
  async uploadLegacy(
    body: { config: any },
    db: any,
    tenantId: string | null,
  ): Promise<any> {
    const previousConfig = tenantId
      ? getTenantConfig(tenantId) || getActiveConfig()
      : getActiveConfig();

    this.isDatasetUpdatingFlag = true;

    try {
      const { config } = body;

      // Basic shape validation
      if (!config || typeof config !== 'object') {
        return {
          status: 400,
          body: {
            success: false,
            error: {
              message: 'Request body must contain a "config" object.',
              type: 'VALIDATION_ERROR',
            },
          },
        };
      }

      if (!config.name || typeof config.name !== 'string') {
        return {
          status: 400,
          body: {
            success: false,
            error: {
              message: 'Config must have a "name" string.',
              type: 'VALIDATION_ERROR',
            },
          },
        };
      }

      if (
        !Array.isArray(config.domainKeywords) ||
        config.domainKeywords.length === 0
      ) {
        return {
          status: 400,
          body: {
            success: false,
            error: {
              message:
                'Config must contain a non-empty "domainKeywords" array.',
              type: 'VALIDATION_ERROR',
            },
          },
        };
      }

      // Strict schema + relationship + data validation
      const resolvedDataDir = config.dataDir
        ? path.resolve(__dirname, '../db', config.dataDir)
        : null;

      try {
        validateDatasetConfig(config, resolvedDataDir);
      } catch (validationErr: any) {
        return {
          status: 400,
          body: {
            success: false,
            error: {
              message: validationErr.message,
              type: 'VALIDATION_ERROR',
            },
          },
        };
      }

      // Stamp version
      config.version = new Date().toISOString();

      console.log(
        `[DATASET_UPLOAD] Activating dataset: ${config.name} (v${config.version})`,
      );

      try {
        // 1. Drop existing tables, init schema from new config
        await initDB(config, db);

        // 2. Load data from config.dataDir (if data exists)
        let totalRows = 0;
        if (config.dataDir) {
          totalRows = await loadDataset(config, db);
        }

        // 3. Only set active config AFTER successful load
        if (tenantId) {
          setTenantConfig(tenantId, config);
        } else {
          setActiveConfig(config);
        }

        // 4. Clear query cache (stale for new dataset)
        clearCache(tenantId);

        console.log(
          `[DATASET_UPLOAD] Dataset "${config.name}" activated. ${totalRows} rows loaded.`,
        );

        return {
          status: 200,
          body: {
            success: true,
            message: `Dataset '${config.name}' loaded successfully.`,
            dataset: config.name,
            version: config.version,
            tablesCreated: config.tables.length,
            rowsLoaded: totalRows,
            queryPlan: 'VALIDATE -> INIT -> LOAD -> QUERY',
          },
        };
      } catch (loadErr: any) {
        console.error(
          `[DATASET_UPLOAD] Load failed, restoring "${previousConfig.name}":`,
          loadErr.message,
        );
        try {
          await initDB(previousConfig, db);
          if (previousConfig.dataDir) {
            await loadDataset(previousConfig, db);
          }
        } catch (restoreErr: any) {
          console.error(
            '[DATASET_UPLOAD] Restore also failed:',
            restoreErr.message,
          );
        }
        if (tenantId) {
          setTenantConfig(tenantId, previousConfig);
        } else {
          setActiveConfig(previousConfig);
        }

        return {
          status: 500,
          body: {
            success: false,
            error: {
              message: `Dataset load failed (restored previous): ${loadErr.message}`,
              type: 'LOAD_ERROR',
            },
          },
        };
      }
    } catch (e: any) {
      if (tenantId) {
        setTenantConfig(tenantId, previousConfig);
      } else {
        setActiveConfig(previousConfig);
      }
      console.error('[DATASET_UPLOAD] Error:', e.message);
      return {
        status: 500,
        body: {
          success: false,
          error: {
            message: `Dataset upload failed: ${e.message}`,
            type: 'API_ERROR',
          },
        },
      };
    } finally {
      this.isDatasetUpdatingFlag = false;
    }
  }
}
