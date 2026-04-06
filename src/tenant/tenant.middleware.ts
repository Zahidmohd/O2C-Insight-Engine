import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import db from '../db/connection';
import { getTenant, getDbForTenant } from '../db/tenantRegistry';
import { getActiveConfig, getTenantConfig } from '../config/activeDataset';

/**
 * NestJS middleware replicating the exact logic from tenantResolver.js:
 *
 * - No X-Tenant-Id header  --> global SQLite DB (backward compat)
 * - X-Tenant-Id + registered tenant --> tenant's Turso DB (strict isolation)
 * - X-Tenant-Id + unregistered      --> global SQLite DB (graceful fallback)
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const tenantId = req.headers['x-tenant-id'] as string | undefined;

    // No tenant header --> global DB
    if (!tenantId) {
      (req as any).db = db;
      (req as any).tenantId = null;
      (req as any).config = getActiveConfig();
      return next();
    }

    // Check if tenant is registered (has a Turso DB)
    const tenant = getTenant(tenantId);

    if (!tenant) {
      // Unregistered tenant --> use global DB
      (req as any).db = db;
      (req as any).tenantId = tenantId;
      (req as any).config = getActiveConfig();
      return next();
    }

    // Registered but NOT yet initialized --> use global DB until background init finishes
    if (!tenant.initialized) {
      (req as any).db = db;
      (req as any).tenantId = tenantId;
      (req as any).config = getActiveConfig();
      return next();
    }

    // Registered + initialized tenant: use Turso DB
    const tenantDb = getDbForTenant(tenantId);
    if (!tenantDb) {
      console.warn(
        `[TENANT] Connection failed for '${tenantId}', falling back to global.`,
      );
      (req as any).db = db;
      (req as any).tenantId = tenantId;
      (req as any).config = getTenantConfig(tenantId) || getActiveConfig();
      return next();
    }

    (req as any).db = tenantDb;
    (req as any).tenantId = tenantId;
    (req as any).config = getTenantConfig(tenantId) || getActiveConfig();

    console.log(
      `[TENANT] ${req.method} ${req.path} | tenant=${tenantId} | db=turso | config=${(req as any).config.name}`,
    );
    next();
  }
}
