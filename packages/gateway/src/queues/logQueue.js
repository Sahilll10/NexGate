/**
 * NexGate — BullMQ Log Queue Producer
 * ════════════════════════════════════════════════════════════════════════════
 *
 * WHY BULLMQ (not direct MongoDB writes)?
 * ─────────────────────────────────────────────────────────────────────────
 * Direct MongoDB insertOne() on the hot path is UNACCEPTABLE because:
 *
 * 1. TAIL LATENCY (P99): MongoDB writes have variable latency.
 *    P50: ~5ms, P95: ~50ms, P99: ~200ms under load.
 *    Every request would incur this latency BEFORE responding to the consumer.
 *    BullMQ.add() is a Redis XADD/LPUSH (~0.5ms P99) — one order of magnitude faster.
 *
 * 2. BACKPRESSURE ISOLATION: If MongoDB slows down (e.g., Atlas throttling on M0),
 *    a direct write blocks the request. With BullMQ, the queue absorbs the load —
 *    jobs accumulate in Redis, workers drain them at MongoDB's pace.
 *
 * 3. RETRY SEMANTICS: BullMQ handles failed writes with configurable retry + backoff.
 *    A direct write has no automatic retry — a network blip loses the log entry.
 *
 * EVENT LOOP MECHANICS:
 * ─────────────────────────────────────────────────────────────────────────
 * `res.send()` is called first, sending the response to the consumer.
 * BullMQ.add() is called in a `res.on('finish', ...)` callback — after the response
 * is fully flushed to the OS network buffer.
 *
 * Node.js event loop phases relevant here:
 *   1. Poll phase: incoming I/O (request data) — the request arrives here
 *   2. Execute handler: Express middleware runs synchronously
 *   3. res.send() triggers write to socket (OS buffer, async)
 *   4. 'finish' event fires in the "close" callback phase
 *   5. BullMQ.add() is called — schedules a Redis XADD via the event loop I/O phase
 *
 * The consumer NEVER sees the BullMQ.add() latency. It happens after the response
 * is committed. The only scenario where this could add latency: if BullMQ's Redis
 * connection is BLOCKED (very slow XADD). Mitigation: connection timeout + fire-and-forget
 * with error logging (we accept potential log loss in exchange for response time guarantee).
 *
 * JOB PAYLOAD DESIGN (denormalization):
 * ─────────────────────────────────────────────────────────────────────────
 * All values are captured at request time — NOT looked up by the worker.
 * Reason: by the time the worker processes the job (seconds to minutes later),
 * the source data might have changed (API renamed, team deleted).
 * Denormalizing at capture time ensures historical accuracy.
 *
 * BACKPRESSURE:
 * ─────────────────────────────────────────────────────────────────────────
 * BullMQ jobs are stored in Redis (not Node.js heap).
 * The gateway's memory is NOT at risk from queue growth.
 * The risk is Redis memory exhaustion — mitigated by:
 *   1. Job TTL (removeOnComplete: true — completed jobs auto-purged)
 *   2. Redis maxmemory-policy (noeviction or allkeys-lru on Upstash)
 *   3. Monitoring queue depth via BullMQ's getJobCounts() in the observability dashboard
 */

const { Queue } = require('bullmq');
const { getRedisClient } = require('../db/redis');
const env = require('../config/env');

let logQueue = null;

function getLogQueue() {
  if (!logQueue) {
    logQueue = new Queue(env.LOG_QUEUE_NAME, {
      connection: getRedisClient(),
      defaultJobOptions: {
        // Remove from Redis immediately on success — prevents unbounded memory growth
        removeOnComplete: { count: 100 }, // Keep last 100 completed for debugging
        removeOnFail: { count: 500 },     // Keep failed jobs for inspection
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      },
    });
  }
  return logQueue;
}

/**
 * Enqueue a request log entry.
 * Called after res.on('finish') — never blocks the response.
 *
 * @param {object} logData - Complete log payload (see field definitions below)
 */
async function enqueueLog(logData) {
  try {
    const queue = getLogQueue();

    // Check queue depth — if > MAX_JOBS, drop the log (memory protection)
    const jobCounts = await queue.getJobCounts('waiting', 'active');
    const totalQueued = (jobCounts.waiting || 0) + (jobCounts.active || 0);

    if (totalQueued > env.LOG_QUEUE_MAX_JOBS) {
      console.warn(`[LogQueue] Queue full (${totalQueued} jobs) — dropping log for ${logData.requestId}`);
      return;
    }

    await queue.add('request-log', logData, {
      jobId: logData.requestId, // Idempotency — prevent duplicate log entries
    });
  } catch (err) {
    // CRITICAL: Never throw here — a log queue failure must never affect the response
    // The response has already been sent at this point (called from 'finish' event)
    console.error('[LogQueue] Failed to enqueue log:', err.message);
  }
}

/**
 * Build the complete log payload from request context.
 * Called just before response is sent — captures full request/response state.
 *
 * Fields explanation:
 * - requestId: UUID generated at request entry (for tracing and log deduplication)
 * - timestamp: exact request arrival time (NOT Date.now() at log time — could be delayed)
 * - meta.{apiId,teamId,keyId}: grouped as "meta" for time-series collection compression
 * - latencyMs: captured via req._startTime set at middleware entry (high-resolution timer)
 * - teamSlug/apiName: denormalized for analytics without join
 * - costCentsPerRequest: denormalized from cost model at request time
 * - wasRateLimited: false (we only log allowed requests — 429s are logged as separate metric)
 */
function buildLogPayload(req, res, { apiDoc, keyDoc, startTime }) {
  const latencyMs = Date.now() - startTime;
  const responseSizeBytes = parseInt(res.getHeader('content-length') || '0', 10);

  return {
    // Identity
    requestId: req.requestId,
    timestamp: new Date(startTime).toISOString(),

    // Time-series meta (for MongoDB time-series collection metaField)
    meta: {
      apiId: apiDoc?._id?.toString(),
      teamId: keyDoc?.teamId?.toString(),
      keyId: keyDoc?._id?.toString(),
    },

    // Request
    method: req.method,
    path: req.path,
    targetUrl: req._proxyTargetUrl || '',
    requestSizeBytes: parseInt(req.headers['content-length'] || '0', 10),

    // Response
    statusCode: res.statusCode,
    latencyMs,
    responseSizeBytes,

    // Denormalized for analytics
    teamSlug: keyDoc?._teamSlug || '',
    apiName: apiDoc?.name || '',

    // Rate limit context
    rateLimitAlgorithm: req._rateLimitAlgorithm || '',
    wasRateLimited: false,

    // Cost (denormalized from cost model resolved at request time)
    costCentsPerRequest: req._costCentsPerRequest || 0,

    // Error context
    errorCode: res.statusCode >= 500 ? 'UPSTREAM_ERROR' : undefined,
    isCircuitBreakerTrip: req._isCircuitBreakerTrip || false,
    isUpstreamTimeout: req._isUpstreamTimeout || false,
  };
}

module.exports = { enqueueLog, buildLogPayload, getLogQueue };
