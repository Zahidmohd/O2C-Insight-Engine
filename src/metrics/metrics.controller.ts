import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { MetricsService } from './metrics.service';

@Controller('metrics')
export class MetricsController {
    constructor(private readonly metricsService: MetricsService) {}

    /**
     * GET /api/metrics — System observability endpoint.
     * Returns: uptime, query count, cache hit rate, latency P50/P95/P99,
     * provider usage, query type distribution, Redis health.
     */
    @Get()
    @Public()
    async getMetrics() {
        const metrics = await this.metricsService.getMetrics();
        return {
            success: true,
            timestamp: new Date().toISOString(),
            ...metrics,
        };
    }
}
