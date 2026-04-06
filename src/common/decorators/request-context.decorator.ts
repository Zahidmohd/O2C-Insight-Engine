import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Extracts req.db — the tenant-resolved database connection.
 */
export const Db = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.db;
  },
);

/**
 * Extracts req.tenantId — the resolved tenant identifier.
 */
export const TenantId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.tenantId;
  },
);

/**
 * Extracts req.config — the active dataset configuration for the tenant.
 */
export const DatasetConfig = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.config;
  },
);
