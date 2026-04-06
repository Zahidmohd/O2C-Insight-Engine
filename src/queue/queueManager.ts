/**
 * BullMQ queue manager — async job processing backed by Redis.
 *
 * Queues:
 *   - dataset-processing: schema inference, data loading, KB generation
 *   - embedding-generation: document chunking + HuggingFace embedding
 *   - tenant-provisioning: Turso database creation for new users
 *
 * Each queue has configurable retries with exponential backoff.
 * If Redis is unavailable, jobs run synchronously as a fallback.
 */
import { Queue, Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { getRedis, isRedisConnected } from '../cache/redisClient';

/**
 * Create a BullMQ-compatible Redis connection.
 * BullMQ requires maxRetriesPerRequest: null for blocking operations.
 */
function createBullMQConnection(): Redis | null {
    const redis = getRedis();
    if (!redis) return null;
    // duplicate() creates a new connection with the same config
    // but we override maxRetriesPerRequest for BullMQ compatibility
    const conn = redis.duplicate({ maxRetriesPerRequest: null });
    return conn;
}

const QUEUES: Record<string, Queue> = {};
const WORKERS: Record<string, Worker> = {};

const DEFAULT_OPTS: any = {
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
    },
};

/**
 * Initialize a named queue. Safe to call multiple times (idempotent).
 */
function getQueue(name: string): Queue | null {
    if (QUEUES[name]) return QUEUES[name];

    if (!isRedisConnected()) return null;

    const conn = createBullMQConnection();
    if (!conn) return null;
    QUEUES[name] = new Queue(name, {
        connection: conn,
        ...DEFAULT_OPTS,
    });

    console.log(`[BullMQ] Queue "${name}" initialized`);
    return QUEUES[name];
}

/**
 * Register a worker for a named queue.
 * @param name - queue name
 * @param processor - async function(job) => result
 * @param opts - worker options (concurrency, etc.)
 */
function registerWorker(name: string, processor: (job: Job) => Promise<any>, opts: any = {}): Worker | null {
    if (!isRedisConnected()) {
        console.warn(`[BullMQ] Redis not available — "${name}" jobs will run synchronously`);
        return null;
    }

    const conn = createBullMQConnection();
    if (!conn) return null;
    const worker = new Worker(name, processor, {
        connection: conn,
        concurrency: opts.concurrency || 2,
    });

    worker.on('completed', (job: Job) => {
        console.log(`[BullMQ] Job ${job.id} in "${name}" completed`);
    });

    worker.on('failed', (job: Job | undefined, err: Error) => {
        console.error(`[BullMQ] Job ${job?.id} in "${name}" failed (attempt ${job?.attemptsMade}/${job?.opts?.attempts}):`, err.message);
    });

    WORKERS[name] = worker;
    console.log(`[BullMQ] Worker for "${name}" started (concurrency: ${opts.concurrency || 2})`);
    return worker;
}

/**
 * Add a job to a queue. Falls back to running synchronously if Redis unavailable.
 * @param queueName
 * @param jobName
 * @param data
 * @param fallbackFn - sync/async function to run if queue unavailable
 */
async function addJob(queueName: string, jobName: string, data: any, fallbackFn?: (data: any) => Promise<void> | void): Promise<{ queued: boolean; jobId?: string; sync?: boolean }> {
    const queue = getQueue(queueName);

    if (queue && isRedisConnected()) {
        try {
            const job = await queue.add(jobName, data);
            console.log(`[BullMQ] Job "${jobName}" added to "${queueName}" (id: ${job.id})`);
            return { queued: true, jobId: job.id };
        } catch (err: any) {
            console.warn(`[BullMQ] Failed to queue "${jobName}", running synchronously:`, err.message);
        }
    }

    // Fallback: run synchronously
    if (fallbackFn) {
        console.log(`[BullMQ] Running "${jobName}" synchronously (no Redis)`);
        await fallbackFn(data);
        return { queued: false, sync: true };
    }

    return { queued: false, sync: false };
}

/**
 * Graceful shutdown — close all workers and queues.
 */
async function closeQueues(): Promise<void> {
    for (const [name, worker] of Object.entries(WORKERS)) {
        try { await worker.close(); } catch (_) {}
        console.log(`[BullMQ] Worker "${name}" closed`);
    }
    for (const [name, queue] of Object.entries(QUEUES)) {
        try { await queue.close(); } catch (_) {}
        console.log(`[BullMQ] Queue "${name}" closed`);
    }
}

export { getQueue, registerWorker, addJob, closeQueues };
