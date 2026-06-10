/**
 * NexGate — SLA Monitor Worker (Every 5 Minutes)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * SCHEDULE: Every 5 minutes (*/5 * * * *)
 *
 * WHY 5 MINUTES (not 1 minute)?
 * Trade-off: evaluation frequency vs. MongoDB aggregation load.
 * Each run executes a heavy aggregation on request_logs (sort + percentile).
 * At 1000 RPS, request_logs has ~300,000 documents in the 5-minute window.
 * At 1-minute intervals: 6× more aggregation runs per hour.
 * MongoDB Atlas M0 is severely constrained — 5 minutes is the minimum safe interval.
 *
 * WHEN DOES 5-MINUTE BECOME INADEQUATE?
 * When SLA breach → user impact window must be < 5 minutes.
 * For financial-grade SLAs (latency > 200ms means transaction timeout), 1-minute
 * or sub-minute monitoring is needed. That requires:
 *   - Moving to a streaming approach (change streams or Redis time-series)
 *   - A dedicated time-series DB (InfluxDB, TimescaleDB) for sub-minute queries
 *   - MongoDB Atlas M10+ tier
 *
 * SLIDING vs. FIXED 5-MINUTE WINDOW:
 * FIXED: Evaluate from :00 to :05, then :05 to :10, etc.
 *   - Simple: window = floor(now/5min) × 5min
 *   - Lower sensitivity: a breach that starts at :04 is mostly in the "next" window
 *
 * SLIDING: Always evaluate the last 5 minutes from NOW.
 *   - Higher sensitivity: detects breaches as soon as they accumulate 5 minutes of data
 *   - Slightly more expensive: range query changes every run
 *
 * DECISION: SLIDING window. Better for catching breaches quickly.
 * A fixed window could miss a breach that spans two windows.
 *
 * P95 CALCULATION:
 * $percentile operator (MongoDB 7.0+): exact percentile computation in the pipeline.
 * For MongoDB 6.x / M0: sort all latencies and pick the 95th percentile index.
 * This is sort-based — exact, but requires loading all latency values.
 * Alternative: $approxQuantiles operator (MongoDB 7.0+) — uses T-Digest algorithm.
 *   Accuracy: ±1% at P95 with 5x better memory usage.
 *   For a monitoring system, ±1% error is acceptable.
 * We use sort-based for correctness (works on all MongoDB versions).
 *
 * ALERT DEDUPLICATION (state machine):
 * State transitions for each SLA definition:
 *   ok → pre_breach: current metric crossed threshold % but < 100% of SLA limit
 *   pre_breach → breach: current metric crossed 100% of SLA limit
 *   breach → ok: metric is back below threshold % of SLA limit
 *   pre_breach → ok: metric recovered before reaching 100%
 *
 * Deduplication: if state is already 'breach', no new BREACH alert created.
 * This prevents 3 consecutive breach evaluations → 3 alert documents.
 * dedupKey = SLA_BREACH:{slaId} — one open alert per SLA per breach episode.
 */

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
        // For large windows this could be expensive — acceptable at 5-minute granularity
        latencies: { $push: '$latencyMs' },
      },
    },
    {
      $project: {
        totalRequests: 1,
        errorCount: 1,
        // Sort latencies and pick P95 index
        // $sortArray + $arrayElemAt: available MongoDB 5.2+
        // For older versions: use $reduce to accumulate sorted order (expensive)
        // We compute P95 in application code after the aggregate for compatibility
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
    // No traffic in window — mark as ok (no data = no breach)
    await SlaDefinition.findByIdAndUpdate(sla._id, {
      currentStatus: 'ok',
      lastEvaluatedAt: windowEnd,
      lastP95LatencyMs: 0,
      lastErrorRatePct: 0,
    });
    return;
  }

  // Compute exact P95 latency (sort-based — works on all MongoDB versions)
  const sortedLatencies = [...stats.latencies].sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(sortedLatencies.length * 0.95) - 1);
  const p95LatencyMs = sortedLatencies[p95Index] || 0;
  const errorRatePct = parseFloat(stats.errorRatePct.toFixed(4));

  // ─── SLA EVALUATION LOGIC ─────────────────────────────────────────────────
  // alertThresholdPct = 90 means: fire PRE_BREACH at 90% of the SLA limit.
  // For maxP95LatencyMs=500 + alertThresholdPct=90:
  //   Pre-breach threshold = 500 × 0.90 = 450ms
  //   Breach threshold     = 500ms

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

  // Update SLA status document
  await SlaDefinition.findByIdAndUpdate(sla._id, {
    currentStatus: newStatus,
    lastEvaluatedAt: windowEnd,
    lastP95LatencyMs: Math.round(p95LatencyMs),
    lastErrorRatePct: errorRatePct,
  });

  // ─── ALERT CREATION ───────────────────────────────────────────────────────
  // State machine prevents flooding:
  // - breach → breach: no new alert (already alerted on first transition)
  // - pre_breach → pre_breach: no new alert
  // - ok → pre_breach: create PRE_BREACH alert
  // - ok/pre_breach → breach: create BREACH alert
  // - breach → ok: resolve existing BREACH alert

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
    // Auto-resolve existing open alerts for this SLA
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
  // Include a time-bucketed dedupKey to allow a new alert each evaluation run if needed,
  // but prevent the same state from creating duplicate alerts within one run.
  const timeBucket = Math.floor(Date.now() / EVALUATION_WINDOW_MS);
  const dedupKey = `${type}:${sla._id}:${timeBucket}`;

  const existing = await Alert.findOne({ dedupKey });
  if (existing) return; // Already alerted for this evaluation window

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
