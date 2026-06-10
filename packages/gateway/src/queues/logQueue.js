const { Queue } = require('bullmq');
const { getRedisClient } = require('../db/redis');
const env = require('../config/env');

let logQueue = null;

function getLogQueue() {
  if (!logQueue) {
    logQueue = new Queue(env.LOG_QUEUE_NAME, {
      connection: getRedisClient(),
      defaultJobOptions: {
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      },
    });
  }
  return logQueue;
}

async function enqueueLog(logData) {
  try {
    const queue = getLogQueue();

    const jobCounts = await queue.getJobCounts('waiting', 'active');
    const totalQueued = (jobCounts.waiting || 0) + (jobCounts.active || 0);

    if (totalQueued > env.LOG_QUEUE_MAX_JOBS) {
      console.warn(`[LogQueue] Queue full (${totalQueued} jobs) — dropping log for ${logData.requestId}`);
      return;
    }

    await queue.add('request-log', logData, {
      jobId: logData.requestId,
    });
  } catch (err) {
    console.error('[LogQueue] Failed to enqueue log:', err.message);
  }
}

function buildLogPayload(req, res, { apiDoc, keyDoc, startTime }) {
  const latencyMs = Date.now() - startTime;
  const responseSizeBytes = parseInt(res.getHeader('content-length') || '0', 10);

  return {
    requestId: req.requestId,
    timestamp: new Date(startTime).toISOString(),
    meta: {
      apiId: apiDoc?._id?.toString(),
      teamId: keyDoc?.teamId?.toString(),
      keyId: keyDoc?._id?.toString(),
    },
    method: req.method,
    path: req.path,
    targetUrl: req._proxyTargetUrl || '',
    requestSizeBytes: parseInt(req.headers['content-length'] || '0', 10),
    statusCode: res.statusCode,
    latencyMs,
    responseSizeBytes,
    teamSlug: keyDoc?._teamSlug || '',
    apiName: apiDoc?.name || '',
    rateLimitAlgorithm: req._rateLimitAlgorithm || '',
    wasRateLimited: false,
    costCentsPerRequest: req._costCentsPerRequest || 0,
    errorCode: res.statusCode >= 500 ? 'UPSTREAM_ERROR' : undefined,
    isCircuitBreakerTrip: req._isCircuitBreakerTrip || false,
    isUpstreamTimeout: req._isUpstreamTimeout || false,
  };
}

module.exports = { enqueueLog, buildLogPayload, getLogQueue };