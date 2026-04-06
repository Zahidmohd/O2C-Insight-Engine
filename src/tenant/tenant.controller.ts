import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Body,
  Res,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { Public } from '../auth/public.decorator';
import { TenantService } from './tenant.service';
import initDB from '../db/init';
import { loadDataset } from '../db/loader';
import { initDocumentTables } from '../rag/vectorStore';
import { getActiveConfig, setTenantConfig } from '../config/activeDataset';

const TURSO_API_TOKEN = process.env.TURSO_API_TOKEN;
const TURSO_ORG_SLUG = process.env.TURSO_ORG_SLUG;

@Controller('tenants')
export class TenantController {
  constructor(private readonly tenantService: TenantService) {}

  // ─── Create Tenant ──────────────────────────────────────────────────────────
  @Public()
  @Post()
  async create(
    @Body() body: { tenantId: string; tursoUrl?: string; authToken?: string },
    @Res() res: Response,
  ): Promise<any> {
    try {
      const { tenantId, tursoUrl, authToken } = body;

      if (!tenantId || typeof tenantId !== 'string' || tenantId.trim().length < 3) {
        return res.status(HttpStatus.BAD_REQUEST).json({
          success: false,
          error: {
            message: 'tenantId is required (min 3 characters).',
            type: 'VALIDATION_ERROR',
          },
        });
      }

      const safeTenantId = tenantId
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

      if (this.tenantService.getTenant(safeTenantId)) {
        return res.status(HttpStatus.CONFLICT).json({
          success: false,
          error: {
            message: `Tenant '${safeTenantId}' already exists.`,
            type: 'CONFLICT',
          },
        });
      }

      let finalUrl = tursoUrl;
      let finalToken = authToken;

      // Auto-provision via Turso Platform API if no URL provided
      if (!finalUrl) {
        if (!TURSO_API_TOKEN || !TURSO_ORG_SLUG) {
          return res.status(HttpStatus.BAD_REQUEST).json({
            success: false,
            error: {
              message:
                'Turso credentials not configured. Provide tursoUrl + authToken manually, or set TURSO_API_TOKEN and TURSO_ORG_SLUG env vars.',
              type: 'CONFIG_ERROR',
            },
          });
        }

        console.log(
          `[TENANT] Auto-provisioning Turso DB for tenant: ${safeTenantId}...`,
        );

        // Create database
        const createRes = await fetch(
          `https://api.turso.tech/v1/organizations/${TURSO_ORG_SLUG}/databases`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${TURSO_API_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: `o2c-${safeTenantId}`,
              group: 'default',
            }),
          },
        );

        if (createRes.ok) {
          const createData = await createRes.json();
          finalUrl = `libsql://${createData.database.Hostname}`;
        } else if (
          createRes.status === 409 ||
          createRes.status === 422
        ) {
          // DB already exists -- reuse
          console.log(
            `[TENANT] Turso DB already exists for tenant: ${safeTenantId}, reusing.`,
          );
          try {
            const infoRes = await fetch(
              `https://api.turso.tech/v1/organizations/${TURSO_ORG_SLUG}/databases/o2c-${safeTenantId}`,
              {
                headers: { Authorization: `Bearer ${TURSO_API_TOKEN}` },
              },
            );
            if (infoRes.ok) {
              const infoData = await infoRes.json();
              finalUrl = `libsql://${infoData.database.Hostname}`;
            } else {
              finalUrl = `libsql://o2c-${safeTenantId}-${TURSO_ORG_SLUG}.turso.io`;
            }
          } catch {
            finalUrl = `libsql://o2c-${safeTenantId}-${TURSO_ORG_SLUG}.turso.io`;
          }
        } else {
          const err = await createRes.text();
          console.error(
            `[TENANT] Turso DB creation failed (${createRes.status}): ${err}`,
          );
          return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            error: {
              message: `Turso DB creation failed: ${err}`,
              type: 'TURSO_ERROR',
            },
          });
        }

        // Generate auth token
        const tokenRes = await fetch(
          `https://api.turso.tech/v1/organizations/${TURSO_ORG_SLUG}/databases/o2c-${safeTenantId}/auth/tokens`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${TURSO_API_TOKEN}` },
          },
        );

        if (!tokenRes.ok) {
          const err = await tokenRes.text();
          return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            error: {
              message: `Turso token generation failed: ${err}`,
              type: 'TURSO_ERROR',
            },
          });
        }

        const tokenData = await tokenRes.json();
        finalToken = tokenData.jwt;

        console.log(`[TENANT] Turso DB provisioned: ${finalUrl}`);
      }

      // Register tenant immediately
      this.tenantService.registerTenant(
        safeTenantId,
        finalUrl!,
        finalToken!,
      );

      // Respond immediately
      res.status(HttpStatus.CREATED).json({
        success: true,
        tenantId: safeTenantId,
        tursoUrl: finalUrl,
        message: `Tenant '${safeTenantId}' created. Database initializing in background — queries work immediately via shared dataset.`,
      });

      // Initialize tenant DB in background (non-blocking)
      (async () => {
        try {
          const tenantDb = this.tenantService.getDbForTenant(safeTenantId);

          // Check if Turso DB already has tables
          const existingTables = await tenantDb.allAsync(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('documents', 'document_chunks', '_litestream_seq', '_litestream_lock')",
          );

          if (existingTables.length > 0) {
            console.log(
              `[TENANT] Turso DB already has ${existingTables.length} tables, skipping init for: ${safeTenantId}`,
            );
            setTenantConfig(safeTenantId, getActiveConfig());
            this.tenantService.markInitialized(safeTenantId);
          } else {
            console.log(
              `[TENANT] Background init starting for: ${safeTenantId}...`,
            );
            const defaultConfig = getActiveConfig();

            await initDocumentTables(tenantDb);
            await initDB(defaultConfig, tenantDb);
            await loadDataset(defaultConfig, tenantDb);
            setTenantConfig(safeTenantId, defaultConfig);
            this.tenantService.markInitialized(safeTenantId);

            console.log(
              `[TENANT] Background init complete for: ${safeTenantId}`,
            );
          }
        } catch (initErr: any) {
          console.error(
            `[TENANT] Background init failed for ${safeTenantId}:`,
            initErr.message,
          );
        }
      })();

      return;
    } catch (err: any) {
      console.error('[TENANT] Creation error:', err.message);
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        success: false,
        error: {
          message: `Tenant creation failed: ${err.message}`,
          type: 'API_ERROR',
        },
      });
    }
  }

  // ─── List Tenants ───────────────────────────────────────────────────────────
  @Public()
  @Get()
  list(@Res() res: Response): any {
    const tenants = this.tenantService.listTenants().map((t: any) => ({
      id: t.id,
      configName: t.configName,
      initialized: t.initialized,
      createdAt: t.createdAt,
    }));
    return res.status(HttpStatus.OK).json({ success: true, tenants });
  }

  // ─── Delete Tenant ──────────────────────────────────────────────────────────
  @Public()
  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<any> {
    try {
      const tenant = this.tenantService.getTenant(id);

      if (!tenant) {
        return res.status(HttpStatus.NOT_FOUND).json({
          success: false,
          error: {
            message: `Tenant '${id}' not found.`,
            type: 'NOT_FOUND',
          },
        });
      }

      // Optionally destroy Turso DB via API
      if (TURSO_API_TOKEN && TURSO_ORG_SLUG) {
        try {
          await fetch(
            `https://api.turso.tech/v1/organizations/${TURSO_ORG_SLUG}/databases/o2c-${id}`,
            {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${TURSO_API_TOKEN}` },
            },
          );
          console.log(`[TENANT] Turso DB destroyed for tenant: ${id}`);
        } catch (tursoErr: any) {
          console.warn(
            `[TENANT] Failed to destroy Turso DB: ${tursoErr.message}`,
          );
        }
      }

      this.tenantService.removeTenant(id);

      return res.status(HttpStatus.OK).json({
        success: true,
        message: `Tenant '${id}' deleted.`,
      });
    } catch (err: any) {
      console.error('[TENANT] Deletion error:', err.message);
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        success: false,
        error: {
          message: `Tenant deletion failed: ${err.message}`,
          type: 'API_ERROR',
        },
      });
    }
  }
}
