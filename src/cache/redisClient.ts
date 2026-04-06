/**
 * Redis client with graceful fallback.
 * If Redis is unavailable, the system continues working with in-memory cache.
 * Used for: query caching (5-min TTL), rate limiting backing, BullMQ.
 */
import Redis from 'ioredis';

let redis: Redis | null = null;
let isConnected: boolean = false;

function getRedisUrl(): string {
    return process.env.REDIS_URL || 'redis://localhost:6379';
}

async function createRedisClient(): Promise<Redis | null> {
    if (redis) return redis;

    try {
        redis = new Redis(getRedisUrl(), {
            maxRetriesPerRequest: 3,
            retryStrategy(times: number): number | null {
                if (times > 5) return null;
                return Math.min(times * 200, 2000);
            },
            lazyConnect: true,
            enableOfflineQueue: false,
        });

        redis.on('error', (err: Error) => {
            if (isConnected) {
                console.warn('[Redis] Connection lost, falling back to in-memory cache:', err.message);
            }
            isConnected = false;
        });

        redis.on('close', () => {
            isConnected = false;
        });

        // Await connection (with 5s timeout)
        await Promise.race([
            redis.connect().then(() => {
                isConnected = true;
                console.log('[Redis] Connected successfully');
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
        ]);

    } catch (err: any) {
        console.warn('[Redis] Not available — using in-memory cache fallback');
        if (redis) {
            try { redis.disconnect(); } catch (_) {}
        }
        redis = null;
        isConnected = false;
    }

    return redis;
}

function getRedis(): Redis | null {
    if (!redis) createRedisClient();
    return redis;
}

function isRedisConnected(): boolean {
    return isConnected && redis !== null;
}

/**
 * Graceful shutdown — called on SIGTERM/SIGINT
 */
async function closeRedis(): Promise<void> {
    if (redis) {
        try {
            await redis.quit();
        } catch (_) { /* ignore */ }
        redis = null;
        isConnected = false;
    }
}

export { getRedis, isRedisConnected, createRedisClient, closeRedis };
