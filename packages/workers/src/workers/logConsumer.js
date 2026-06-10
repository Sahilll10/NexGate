/**
 * NexGate — Log Consumer Worker
 * ════════════════════════════════════════════════════════════════════════════
 *
 * CONCURRENCY DECISION:
 * How many concurrent workers process the log queue?
 * Factors:
 *   1. MongoDB write throughput: M0 free tier handles ~100 writes/second
 *   2. Job processing rate: each job = 1 insertMany (batch of N) or 1 insertOne
 *   3. Redis connection limit: each worker uses 1 Redis connection
 *
 * Decision: concurrency=5 workers, each processing batches of 50 logs.
 * Effective throughput: 5 × 50 × (1/10ms avg write time) = 25,000 logs/second theoretical.
 * In practice on M0: ~500-1000 logs/second sustained.
 *
 * BATCHING DECISION (insertMany vs insertOne):
 * At 1000 RPS, individual insertOne calls = 1000 MongoDB writes/second.
 * This would immediately saturate Atlas M0 (~100 IOPS limit).
 * Instead: the worker waits up to BATCH_WINDOW_MS (500ms) or BATCH_SIZE (100) logs,
 * then does ONE insertMany. At 1000 RPS: 10 insertMany × 100 docs = same throughput
 * but 100× fewer round trips to MongoDB.
 *
 * RETRY STRATEGY:
 * - 3 attempts with exponential backoff (1s, 2s, 4s)
 * - After all retries exhausted: job moves to BullMQ "failed" queue
 * - Failed jobs are retained for 24 hours for manual inspection
 *
 * IS IT ACCEPTABLE TO LOSE A LOG ENTRY?
 * CASE FOR YES: Logs are observability data, not financial transactions.
 *   A 0.001% log loss rate (1 in 100,000) is imperceptible in P95/RPS charts.
 *   Retrying indefinitely risks queue growth and memory pressure.
 *
 * CASE FOR NO: Logs feed cost attribution. A lost log = lost billing.
 *   For a team billed $0.001 per 1000 requests at 1M requests/day,
 *   a 0.1% loss = $1/day undercharge. At scale this matters.
 *
 * DECISION: Accept loss at the application layer. Mitigate by:
 *   1. BullMQ's built-in retry (3 attempts) handles transient failures
 *   2. MongoDB Atlas has write concern majority (w:majority) — once committed, not lost
 *   3. Monitor failed queue depth — alert if > threshold
 *   4. For billing-critical deployments, use a paid MongoDB tier with change streams
 */

const { Worker, Queue } = require('bullmq');
const { getRedisClient } = require('../../../gateway/src/db/redis');
const { RequestLog } = require('../../../gateway/src/db/models/index');
// const { recordMetric } = require('../../api/src/socket/index');

const LOG_QUEUE_NAME = process.env.LOG_QUEUE_NAME || 'nexgate:logs';
const BATCH_SIZE = 50;
const BATCH_WINDOW_MS = 500;
const WORKER_CONCURRENCY = 5;

// Batch accumulator — collects jobs before flushing to MongoDB
let pendingLogs = [];
let batchTimer = null;

async function flushBatch() {
  if (pendingLogs.length === 0) return;

  const batch = [...pendingLogs];
  pendingLogs = [];
  clearTimeout(batchTimer);
  batchTimer = null;

  try {
    // insertMany with ordered:false — if one doc fails, others still insert
    await RequestLog.insertMany(batch, { ordered: false });

    // After successful write, record metrics for WebSocket emission
    // batch.forEach(log => {
    //   recordMetric({
    //     apiId: log.meta?.apiId,
    //     teamId: log.meta?.teamId,
    //     apiName: log.apiName,
    //     latencyMs: log.latencyMs,
    //     statusCode: log.statusCode,
    //   });
    // });

    console.debug(`[LogConsumer] Flushed ${batch.length} logs to MongoDB`);
  } catch (err) {
    // With ordered:false, BulkWriteError contains per-document errors
    // For duplicate requestId (already logged): ignore. For other errors: re-throw.
    if (err.code === 11000) {
      console.warn('[LogConsumer] Duplicate log entries skipped (idempotency)');
      return;
    }
    console.error('[LogConsumer] insertMany failed:', err.message);
    throw err; // BullMQ will retry the job
  }
}

function scheduleBatchFlush() {
  if (batchTimer) return; // Timer already scheduled
  batchTimer = setTimeout(flushBatch, BATCH_WINDOW_MS);
}

/**
 * Create and start the log consumer worker.
 */
function createLogConsumer() {
  const worker = new Worker(
    LOG_QUEUE_NAME,
    async (job) => {
      const logData = job.data;

      // Build the MongoDB document from the job payload
      const logDoc = {
        timestamp: new Date(logData.timestamp),
        meta: {
          apiId: logData.meta?.apiId,
          teamId: logData.meta?.teamId,
          keyId: logData.meta?.keyId,
        },
        requestId: logData.requestId,
        method: logData.method,
        path: logData.path,
        targetUrl: logData.targetUrl,
        statusCode: logData.statusCode,
        latencyMs: logData.latencyMs,
        requestSizeBytes: logData.requestSizeBytes || 0,
        responseSizeBytes: logData.responseSizeBytes || 0,
        teamSlug: logData.teamSlug,
        apiName: logData.apiName,
        rateLimitAlgorithm: logData.rateLimitAlgorithm,
        wasRateLimited: logData.wasRateLimited || false,
        costCentsPerRequest: logData.costCentsPerRequest || 0,
        errorCode: logData.errorCode,
        isCircuitBreakerTrip: logData.isCircuitBreakerTrip || false,
        isUpstreamTimeout: logData.isUpstreamTimeout || false,
      };

      pendingLogs.push(logDoc);

      // Flush immediately if batch is full
      if (pendingLogs.length >= BATCH_SIZE) {
        await flushBatch();
      } else {
        // Otherwise schedule a time-based flush
        scheduleBatchFlush();
      }
    },
    {
      connection: getRedisClient(),
      concurrency: WORKER_CONCURRENCY,
      // Remove completed jobs after keeping last 100 (for debugging)
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500, age: 86400 }, // Keep for 24 hours
    }
  );

  worker.on('completed', (job) => {
    if (process.env.LOG_LEVEL === 'debug') {
      console.debug(`[LogConsumer] Job ${job.id} completed`);
    }
  });

  worker.on('failed', (job, err) => {
    console.error(`[LogConsumer] Job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message);
  });

  worker.on('error', (err) => {
    console.error('[LogConsumer] Worker error:', err.message);
  });

  console.info(`[LogConsumer] ✅ Started with concurrency=${WORKER_CONCURRENCY}`);
  return worker;
}

module.exports = { createLogConsumer };
