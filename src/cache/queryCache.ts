/**
 * Query cache — Redis-backed with in-memory Map fallback.
 * Pattern: Cache-Aside (Lazy Loading)
 *   1. Check Redis first
 *   2. On hit → return immediately (zero LLM cost)
 *   3. On miss → run pipeline, store result in Redis with TTL
 *   4. If Redis unavailable → transparent fallback to in-memory Map
 *
 * Cache key: {tenantId}:{datasetConfig}:{normalizedQuery}
 * TTL: 5 minutes
 */
import { getRedis, isRedisConnected } from './redisClient';

const CACHE_TTL_SECONDS: number = 300;     // 5 minutes
const CACHE_PREFIX: string = 'qcache:';

// In-memory fallback (same as original implementation)
const memoryCache: Map<string, { response: any; timestamp: number }> = new Map();
const MEMORY_TTL_MS: number = CACHE_TTL_SECONDS * 1000;
const MAX_MEMORY_SIZE: number = 500;

const STOPWORDS: Set<string> = new Set([
    'the', 'is', 'show', 'all', 'give', 'me', 'a', 'an',
    'of', 'for', 'and', 'with', 'in', 'to', 'by'
]);

function normalizeQuery(query: string): string {
    return query
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter((w: string) => w && !STOPWORDS.has(w))
        .join(' ');
}

function buildKey(query: string, includeSql: boolean, tenantId: string | null, config: any): string {
    const dsKey: string = `${tenantId || 'global'}:${config.name}:${config.version || 'default'}`;
    return `${CACHE_PREFIX}${dsKey}:${normalizeQuery(query)}${includeSql ? ':sql' : ''}`;
}

// ─── Memory fallback ────────────────────────────────────────────────────────

function memGet(key: string): any | null {
    const entry = memoryCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > MEMORY_TTL_MS) {
        memoryCache.delete(key);
        return null;
    }
    return entry.response;
}

function memSet(key: string, response: any): void {
    if (memoryCache.size >= MAX_MEMORY_SIZE) {
        const oldest = memoryCache.keys().next().value;
        if (oldest !== undefined) {
            memoryCache.delete(oldest);
        }
    }
    memoryCache.set(key, { response, timestamp: Date.now() });
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Get cached query result. Tries Redis first, falls back to in-memory.
 */
async function getCached(query: string, includeSql: boolean, tenantId: string | null, config: any): Promise<any | null> {
    const key = buildKey(query, includeSql, tenantId, config);

    // Try Redis
    if (isRedisConnected()) {
        try {
            const redis = getRedis();
            const cached = await redis!.get(key);
            if (cached) {
                return { ...JSON.parse(cached), cacheSource: 'redis' };
            }
        } catch (_) { /* Redis failed, try memory */ }
    }

    // Fallback to in-memory
    const memResult = memGet(key);
    if (memResult) {
        return { ...memResult, cacheSource: 'memory' };
    }

    return null;
}

/**
 * Store query result in cache. Writes to both Redis and in-memory.
 */
async function setCached(query: string, includeSql: boolean, response: any, tenantId: string | null, config: any): Promise<void> {
    const key = buildKey(query, includeSql, tenantId, config);

    // Always store in memory (fast fallback)
    memSet(key, response);

    // Also store in Redis if available
    if (isRedisConnected()) {
        try {
            const redis = getRedis();
            await redis!.setex(key, CACHE_TTL_SECONDS, JSON.stringify(response));
        } catch (_) { /* Redis write failed, memory cache still works */ }
    }
}

/**
 * Clear all cache entries for a tenant (called on dataset upload).
 */
async function clearTenantCache(tenantId: string): Promise<void> {
    // Clear memory cache entries for this tenant
    for (const key of memoryCache.keys()) {
        if (key.includes(`${CACHE_PREFIX}${tenantId}:`)) {
            memoryCache.delete(key);
        }
    }

    // Clear Redis entries for this tenant
    if (isRedisConnected()) {
        try {
            const redis = getRedis();
            const keys = await redis!.keys(`${CACHE_PREFIX}${tenantId}:*`);
            if (keys.length > 0) {
                await redis!.del(...keys);
            }
        } catch (_) { /* best-effort */ }
    }
}

export { getCached, setCached, clearTenantCache, normalizeQuery };
