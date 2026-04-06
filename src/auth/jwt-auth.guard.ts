import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from './public.decorator';
import { Request } from 'express';

/** Paths that skip JWT validation entirely (mirrors authMiddleware.js). */
const EXEMPT_PATHS = ['/api/health', '/api/providers', '/api/auth', '/api/tenants'];

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    // 1. Check @Public() decorator
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const requestPath = request.path;

    // 2. Check exempt paths
    const isExempt = EXEMPT_PATHS.some(
      (p) => requestPath === p || requestPath.startsWith(p + '/'),
    );
    if (isExempt) {
      return true;
    }

    // 3. No Authorization header → allow unauthenticated (backward compat)
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      const legacyTenantId = request.headers['x-tenant-id'] as string | undefined;
      (request as any).user = null;
      (request as any).tenantId = legacyTenantId || null;
      return true;
    }

    // 4. Authorization header present → validate JWT via Passport
    return super.canActivate(context) as Promise<boolean>;
  }

  handleRequest<T = any>(err: any, user: T, _info: any): T {
    if (err) {
      throw err || new UnauthorizedException('Invalid or expired token. Please login again.');
    }
    // user can be falsy when no auth header was present (handled above)
    return user;
  }
}
