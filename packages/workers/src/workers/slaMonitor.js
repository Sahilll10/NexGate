const cron = require('node-cron');
const { getRedisClient } = require('../../../gateway/src/db/redis');
const {
  SlaDefinition,
  RequestLog,
  Alert,
} = require('../../../gateway/src/db/models/index');
const mongoose = require('mongoose');

const EVALUATION_WINDOW_MS = 5 * 60 * 1000; // 5 minutes sliding window
const INSTANCE_ID = `sla-${Date.now()}`;

async function acquireSlaLock() {
  const redis = getRedisClient();
  const lockKey = `nexgate:lock:sla-monitor:${Math.floor(Date.now() / EVALUATION_WINDOW_MS)}`;
  const result = await redis.set(lockKey, INSTANCE_ID, 'EX', 300, 'NX');
  return result === 'OK';
}

async function runSlaEvaluation() {
  const locked = await acquireSlaLock();
  if (!locked) {
    console.debug('[SlaMonitor] Another instance running. Skipping.');
    return;
  }

  const now = new Date();
  const windowStart = new Date(now - EVALUATION_WINDOW_MS);

  console.info(`[SlaMonitor] Evaluating SLAs (window: last 5 minutes)`);

  const slaDefinitions = await SlaDefinition.find({ isActive: true }).lean();

  for (const sla of slaDefinitions) {
    try {
      await evaluateSla(sla, windowStart, now);
    } catch (err) {
      console.error(`[SlaMonitor] Error evaluating SLA ${sla._id}:`, err.message);
    }
  }

  console.info(`[SlaMonitor] ✅ Evaluation complete (${slaDefinitions.length} SLAs checked)`);
}

async function evaluateSla(sla, windowStart, windowEnd) {
  const matchStage = {
    timestamp: { $gte: windowStart, $lt: windowEnd },
    'meta.apiId': sla.apiId,
  };

  // If SLA is team-scoped, filter by teamId
  if (sla.teamId) {
    matchStage['meta.teamId'] = sla.teamId;
  }

  // MongoDB aggregation for the 5-minute window
  const [stats] = await RequestLog.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: null,
        totalRequests: { $sum: 1 },
        errorCount: {
          $sum: { $cond: [{ $gte: ['$statusCode', 500] }, 1, 0] },
        },
        // Collect all latencies for P95 computation
        latencies: { $push: '$latencyMs' },
      },
    },
    {
      $project: {
        totalRequests: 1,
        errorCount: 1,
        latencies: 1,
        errorRatePct: {
          $cond: [
            { $gt: ['$totalRequests', 0] },
            { $multiply: [{ $divide: ['$errorCount', '$totalRequests'] }, 100] },
            0,
          ],
        },
      },
    },
  ]);

  if (!stats || stats.totalRequests === 0) {
    // No traffic in window — mark as ok
    await SlaDefinition.findByIdAndUpdate(sla._id, {
      currentStatus: 'ok',
      lastEvaluatedAt: windowEnd,
      lastP95LatencyMs: 0,
      lastErrorRatePct: 0,
    });
    return;
  }

  // Compute exact P95 latency (sort-based)
  const sortedLatencies = [...stats.latencies].sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(sortedLatencies.length * 0.95) - 1);
  const p95LatencyMs = sortedLatencies[p95Index] || 0;
  const errorRatePct = parseFloat(stats.errorRatePct.toFixed(4));

  const thresholdFactor = sla.alertThresholdPct / 100;
  const latencyPreBreachMs = sla.maxP95LatencyMs * thresholdFactor;
  const errorRatePreBreachPct = sla.maxErrorRatePct * thresholdFactor;

  const latencyBreached = p95LatencyMs >= sla.maxP95LatencyMs;
  const latencyPreBreached = p95LatencyMs >= latencyPreBreachMs && !latencyBreached;
  const errorBreached = errorRatePct >= sla.maxErrorRatePct;
  const errorPreBreached = errorRatePct >= errorRatePreBreachPct && !errorBreached;

  const isBreached = latencyBreached || errorBreached;
  const isPreBreached = latencyPreBreached || errorPreBreached;

  let newStatus = 'ok';
  if (isBreached) newStatus = 'breach';
  else if (isPreBreached) newStatus = 'pre_breach';

  const previousStatus = sla.currentStatus || 'unknown';

  await SlaDefinition.findByIdAndUpdate(sla._id, {
    currentStatus: newStatus,
    lastEvaluatedAt: windowEnd,
    lastP95LatencyMs: Math.round(p95LatencyMs),
    lastErrorRatePct: errorRatePct,
  });

  if (newStatus === 'breach' && previousStatus !== 'breach') {
    await createSlaAlert(sla, 'SLA_BREACH', 'critical', {
      p95LatencyMs: Math.round(p95LatencyMs),
      maxP95LatencyMs: sla.maxP95LatencyMs,
      errorRatePct,
      maxErrorRatePct: sla.maxErrorRatePct,
      windowStart,
      windowEnd,
    });
  } else if (newStatus === 'pre_breach' && previousStatus === 'ok') {
    await createSlaAlert(sla, 'SLA_PRE_BREACH', 'warning', {
      p95LatencyMs: Math.round(p95LatencyMs),
      thresholdMs: Math.round(latencyPreBreachMs),
      limitMs: sla.maxP95LatencyMs,
      windowStart,
      windowEnd,
    });
  } else if (newStatus === 'ok' && ['breach', 'pre_breach'].includes(previousStatus)) {
    await Alert.updateMany(
      {
        dedupKey: { $regex: `^SLA_(BREACH|PRE_BREACH):${sla._id}:` },
        status: { $in: ['open', 'acknowledged'] },
      },
      { status: 'resolved', resolvedAt: new Date(), resolvedBy: 'sla-monitor-auto' }
    );
    console.info(`[SlaMonitor] SLA ${sla._id} recovered — alerts auto-resolved`);
  }

  if (newStatus !== 'ok') {
    console.warn(
      `[SlaMonitor] SLA ${sla._id} status=${newStatus} | ` +
      `P95=${Math.round(p95LatencyMs)}ms (limit=${sla.maxP95LatencyMs}ms) | ` +
      `errorRate=${errorRatePct.toFixed(2)}% (limit=${sla.maxErrorRatePct}%)`
    );
  }
}

async function createSlaAlert(sla, type, severity, details) {
  const timeBucket = Math.floor(Date.now() / EVALUATION_WINDOW_MS);
  const dedupKey = `${type}:${sla._id}:${timeBucket}`;

  const existing = await Alert.findOne({ dedupKey });
  if (existing) return;

  await Alert.create({
    type,
    severity,
    teamId: sla.teamId,
    apiId: sla.apiId,
    message:
      type === 'SLA_BREACH'
        ? `SLA breach detected: P95 latency ${details.p95LatencyMs}ms exceeds ${details.maxP95LatencyMs}ms limit`
        : `SLA pre-breach warning: P95 latency ${details.p95LatencyMs}ms approaching ${details.limitMs}ms limit`,
    details,
    dedupKey,
  });

  console.warn(`[SlaMonitor] 🚨 Alert created: ${type} for SLA ${sla._id}`);
}

function scheduleSlaMonitor() {
  cron.schedule('*/5 * * * *', async () => {
    try {
      await runSlaEvaluation();
    } catch (err) {
      console.error('[SlaMonitor] Cron run failed:', err.message);
    }
  });

  console.info('[SlaMonitor] ✅ Cron scheduled (every 5 minutes)');
}

module.exports = { scheduleSlaMonitor, runSlaEvaluation };