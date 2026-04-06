import { Injectable } from '@nestjs/common';
import { isRedisConnected, getRedis } from '../cache/redisClient';

/**
 * In-memory metrics collector.
 * Tracks query performance, cache efficiency, and provider health.
 * Exposed via GET /api/metrics for observability.
 */

interface QueryMetric {
    timestamp: number;
    latencyMs: number;
    cacheHit: boolean;
    provider: string;
    queryType: string;
    tenantId: string | null;
}

const metrics: {
    totalQueries: number;
    cacheHits: number;
    cacheMisses: number;
    queryLatencies: number[];
    providerUsage: Record<string, number>;
    queryTypeDistribution: Record<string, number>;
    recentQueries: QueryMetric[];
    startedAt: number;
    errors: number;
} = {
    totalQueries: 0,
    cacheHits: 0,
    cacheMisses: 0,
    queryLatencies: [],
    providerUsage: {},
    queryTypeDistribution: {},
    recentQueries: [],
    startedAt: Date.now(),
    errors: 0,
};

const MAX_RECENT = 100;
const MAX_LATENCIES = 1000;

@Injectable()
export class MetricsService {

    /**
     * Record a completed query for metrics.
     */
    recordQuery(opts: {
        latencyMs: number;
        cacheHit: boolean;
        provider?: string;
        queryType?: string;
        tenantId?: string | null;
        error?: boolean;
    }): void {
        metrics.totalQueries++;

        if (opts.cacheHit) {
            metrics.cacheHits++;
        } else {
            metrics.cacheMisses++;
        }

        if (opts.error) metrics.errors++;

        // Latency tracking (ring buffer)
        metrics.queryLatencies.push(opts.latencyMs);
        if (metrics.queryLatencies.length > MAX_LATENCIES) {
            metrics.queryLatencies.shift();
        }

        // Provider usage
        if (opts.provider) {
            metrics.providerUsage[opts.provider] = (metrics.providerUsage[opts.provider] || 0) + 1;
        }

        // Query type distribution
        if (opts.queryType) {
            metrics.queryTypeDistribution[opts.queryType] = (metrics.queryTypeDistribution[opts.queryType] || 0) + 1;
        }

        // Recent queries (ring buffer)
        metrics.recentQueries.push({
            timestamp: Date.now(),
            latencyMs: opts.latencyMs,
            cacheHit: opts.cacheHit,
            provider: opts.provider || 'cache',
            queryType: opts.queryType || 'unknown',
            tenantId: opts.tenantId || null,
        });
        if (metrics.recentQueries.length > MAX_RECENT) {
            metrics.recentQueries.shift();
        }
    }

    /**
     * Calculate percentile from sorted latency array.
     */
    private percentile(sorted: number[], p: number): number {
        if (sorted.length === 0) return 0;
        const idx = Math.ceil((p / 100) * sorted.length) - 1;
        return sorted[Math.max(0, idx)];
    }

    /**
     * Get full metrics snapshot.
     */
    async getMetrics(): Promise<any> {
        const sorted = [...metrics.queryLatencies].sort((a, b) => a - b);
        const uptimeMs = Date.now() - metrics.startedAt;

        const result: any = {
            uptime: {
                ms: uptimeMs,
                human: `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`,
            },
            queries: {
                total: metrics.totalQueries,
                errors: metrics.errors,
                errorRate: metrics.totalQueries > 0
                    ? `${((metrics.errors / metrics.totalQueries) * 100).toFixed(1)}%`
                    : '0%',
            },
            cache: {
                hits: metrics.cacheHits,
                misses: metrics.cacheMisses,
                hitRate: metrics.totalQueries > 0
                    ? `${((metrics.cacheHits / metrics.totalQueries) * 100).toFixed(1)}%`
                    : '0%',
                redisConnected: isRedisConnected(),
            },
            latency: {
                p50: this.percentile(sorted, 50),
                p95: this.percentile(sorted, 95),
                p99: this.percentile(sorted, 99),
                avg: sorted.length > 0
                    ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length)
                    : 0,
                unit: 'ms',
            },
            providers: metrics.providerUsage,
            queryTypes: metrics.queryTypeDistribution,
        };

        // Add Redis stats if connected
        if (isRedisConnected()) {
            try {
                const redis = getRedis();
                if (redis) {
                    const info = await redis.info('memory');
                    const usedMemMatch = info.match(/used_memory_human:(\S+)/);
                    result.redis = {
                        connected: true,
                        memoryUsed: usedMemMatch ? usedMemMatch[1] : 'unknown',
                    };
                }
            } catch (_) {
                result.redis = { connected: true, memoryUsed: 'unavailable' };
            }
        } else {
            result.redis = { connected: false };
        }

        return result;
    }
}
