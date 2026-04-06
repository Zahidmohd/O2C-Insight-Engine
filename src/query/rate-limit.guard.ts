import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request } from 'express';

/**
 * In-memory rate limiter -- 50 requests per minute per IP.
 * Expired entries are swept every 2 minutes to prevent unbounded Map growth.
 *
 * Replicates the exact logic from queryRoutes.js lines 24-60.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly rateLimitMap = new Map<
    string,
    { count: number; timestamp: number }
  >();
  private readonly RATE_LIMIT_MAX = 50;
  private readonly RATE_LIMIT_WINDOW_MS = 60 * 1000;
  private sweepInterval: ReturnType<typeof setInterval>;

  constructor() {
    // Sweep expired entries every 2 minutes
    this.sweepInterval = setInterval(() => {
      const now = Date.now();
      for (const [ip, entry] of this.rateLimitMap) {
        if (now - entry.timestamp > this.RATE_LIMIT_WINDOW_MS) {
          this.rateLimitMap.delete(ip);
        }
      }
      if (this.rateLimitMap.size > 10000) {
        console.warn('[RATE_LIMIT] Map exceeded 10K entries, purging.');
        this.rateLimitMap.clear();
      }
    }, 2 * 60 * 1000);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const ip = request.ip || (request.connection?.remoteAddress ?? 'unknown');
    const now = Date.now();
    const entry = this.rateLimitMap.get(ip);

    if (!entry || now - entry.timestamp > this.RATE_LIMIT_WINDOW_MS) {
      this.rateLimitMap.set(ip, { count: 1, timestamp: now });
      return true;
    }

    entry.count++;
    if (entry.count > this.RATE_LIMIT_MAX) {
      throw new HttpException(
        {
          success: false,
          error: 'Rate limit exceeded. Try again later.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
