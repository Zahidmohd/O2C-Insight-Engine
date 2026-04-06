import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { createRedisClient, getRedis, isRedisConnected, closeRedis } from './redisClient';
import { getCached, setCached, clearTenantCache } from './queryCache';

@Injectable()
export class RedisCacheService implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await createRedisClient();
  }

  getRedis(): any {
    return getRedis();
  }

  isRedisConnected(): boolean {
    return isRedisConnected();
  }

  async getCached(key: string): Promise<any> {
    return (getCached as any)(key);
  }

  async setCached(key: string, value: any, ttl?: number): Promise<void> {
    return (setCached as any)(key, value, ttl);
  }

  async clearTenantCache(tenantId: string): Promise<void> {
    return clearTenantCache(tenantId);
  }

  async onModuleDestroy(): Promise<void> {
    await closeRedis();
  }
}
