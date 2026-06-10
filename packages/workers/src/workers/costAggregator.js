/**
 * NexGate — Cost Aggregator Worker (Nightly Cron)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * SCHEDULE: Every night at midnight UTC (0 0 * * *)
 *
 * WHY NIGHTLY (not real-time)?
 * Real-time aggregation requires a running total updated on every request.
 * This would mean a MongoDB $inc operation on a cost_reports document for EVERY
 * single proxied request — adding write contention on the hot path.
 * Nightly batch: reads request_logs once, aggregates, writes cost_reports once.
 * Far more efficient. Trade-off: cost visibility is up to 24 hours delayed.
 *
 * IF HOURLY WERE NEEDED:
 * The architecture would change:
 *   1. cost_reports would need a sub-document per hour (not per month)
 *   2. The aggregation pipeline would run every hour on a 1-hour window
 *   3. Redis would cache the running day total to avoid re-aggregating from scratch
 *   4. MongoDB Atlas must handle the increased read load (still reads request_logs hourly)
 *
 * READ/WRITE CONTENTION MITIGATION:
 * The request_logs collection has continuous writes from the log consumer worker.
 * Reading from it with a heavy aggregation while writes are happening causes
 * read/write lock contention in WiredTiger (MongoDB's storage engine).
 * MITIGATION: Use a secondary node for reads (readPreference: 'secondaryPreferred').
 * This routes the aggregation read to a replica secondary, not the primary that
 * handles writes. Atlas M0 has no replicas — contention is accepted at this tier.
 *
 * DISTRIBUTED LOCKING (prevents duplicate aggregation):
 * Problem: Cloud deployments may start two instances simultaneously (blue/green deploy,
 * health check restart). Both instances see midnight, both start the aggregation.
 * Both compute the same totals. Both write to cost_reports. Result: doubled cost totals.
 *
 * Solution: Redis SETNX (SET if Not eXists) distributed lock.
 * Lock key: nexgate:lock:cost-aggregator:{month}
 * Lock value: instance-ID (UUID, set at worker startup)
 * Lock TTL: 30 minutes (longer than max expected job duration)
 *
 * SEQUENCE:
 *   1. Worker A: SETNX lock → succeeds (returns 1) → proceeds with aggregation
 *   2. Worker B: SETNX lock → fails (returns 0, key already exists) → exits
 *   3. Worker A: finishes → DEL lock (optional; TTL handles it)
 * If Worker A crashes mid-job: TTL expires the lock after 30 min, next run can proceed.
 *
 * REDIS COMMANDS: SET key value NX EX ttl
 * (SET with NX=only set if not exists + EX=expiry seconds, atomic in Redis 2.6.12+)
 *
 * MID-MONTH PRICE CHANGES:
 * If cost_models has effectiveFrom=2024-01-15, pricing splits:
 *   Jan 1–14: use cost model valid before Jan 15
 *   Jan 15–31: use new cost model
 * The aggregation pipeline handles this with multiple $facet stages or
 * a $cond on the request timestamp vs. effectiveFrom.
 */

const cron = require('node-cron');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { getRedisClient } = require('../../../gateway/src/db/redis');
const {
  Team,
  RequestLog,
  CostModel,
  CostReport,
  Alert,
} = require('../../../gateway/src/db/models/index');

const INSTANCE_ID = uuidv4(); // Unique per worker process

async function acquireLock(lockKey, ttlSeconds = 1800) {
  const redis = getRedisClient();
  // SET key value NX EX ttl — atomic "set if not exists with expiry"
  const result = await redis.set(lockKey, INSTANCE_ID, 'EX', ttlSeconds, 'NX');
  return result === 'OK'; // 'OK' = lock acquired, null = already locked
}

async function releaseLock(lockKey) {
  const redis = getRedisClient();
  // Only release if WE hold the lock (compare-and-delete via Lua script)
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    else
      return 0
    end
  `;
  await redis.eval(script, 1, lockKey, INSTANCE_ID);
}

/**
 * Aggregate month-to-date costs for all teams.
 * @param {string} month - 'YYYY-MM' format. Defaults to current month.
 */
async function runCostAggregation(month) {
  const targetMonth = month || new Date().toISOString().slice(0, 7);
  const lockKey = `nexgate:lock:cost-aggregator:${targetMonth}`;

  console.info(`[CostAggregator] Starting aggregation for month: ${targetMonth}`);

  // Acquire distributed lock
  const locked = await acquireLock(lockKey, 1800);
  if (!locked) {
    console.info('[CostAggregator] Another instance is running aggregation. Skipping.');
    return;
  }

  try {
    const [year, monthNum] = targetMonth.split('-').map(Number);
    const monthStart = new Date(year, monthNum - 1, 1);
    const monthEnd = new Date(year, monthNum, 1); // Exclusive (first of next month)

    // Get all active teams
    const teams = await Team.find({ isActive: true }).lean();
    console.info(`[CostAggregator] Processing ${teams.length} teams`);

    for (const team of teams) {
      await aggregateTeamCost(team, monthStart, monthEnd, targetMonth);
    }

    console.info(`[CostAggregator] ✅ Aggregation complete for ${targetMonth}`);
  } catch (err) {
    console.error('[CostAggregator] ❌ Aggregation failed:', err.message);
    throw err;
  } finally {
    await releaseLock(lockKey);
  }
}

async function aggregateTeamCost(team, monthStart, monthEnd, month) {
  const teamId = team._id;

  // Aggregation pipeline — handles mid-month price changes
  // The pipeline groups by apiId, then computes cost per API.
  //
  // MID-MONTH PRICE CHANGE LOGIC:
  // We fetch cost models separately and apply them in application code,
  // since MongoDB aggregation pipelines are not suited for date-range pricing joins.
  // Pipeline: aggregate raw request counts per API per day.
  // Application code: join with cost_models using effectiveFrom/effectiveTo ranges.

  const dailyRequestCounts = await RequestLog.aggregate([
    {
      $match: {
        timestamp: { $gte: monthStart, $lt: monthEnd },
        'meta.teamId': teamId,
      },
    },
    {
      $group: {
        _id: {
          apiId: '$meta.apiId',
          // Group by day (truncate timestamp to day boundary)
          day: {
            $dateToString: { format: '%Y-%m-%d', date: '$timestamp' },
          },
        },
        requestCount: { $sum: 1 },
        apiName: { $first: '$apiName' },
      },
    },
  ]);

  // Fetch all cost models that could apply to this period
  const costModels = await CostModel.find({
    $or: [
      { apiId: { $in: dailyRequestCounts.map(d => d._id.apiId) } },
      { apiId: null }, // Default cost model
    ],
    effectiveFrom: { $lte: monthEnd },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gt: monthStart } }],
  }).sort({ effectiveFrom: 1 }).lean();

  // Compute total cost — applying correct price model per day
  let totalCents = 0;
  let totalRequests = 0;
  const apiBreakdown = {};

  for (const daily of dailyRequestCounts) {
    const { apiId, day } = daily._id;
    const dayDate = new Date(day);
    const apiIdStr = apiId?.toString();

    // Find the applicable cost model for this API on this day
    // Priority: API-specific model > default model
    const applicableModel = costModels.find(m =>
      m.apiId?.toString() === apiIdStr &&
      new Date(m.effectiveFrom) <= dayDate &&
      (!m.effectiveTo || new Date(m.effectiveTo) > dayDate)
    ) || costModels.find(m =>
      m.apiId === null &&
      new Date(m.effectiveFrom) <= dayDate &&
      (!m.effectiveTo || new Date(m.effectiveTo) > dayDate)
    );

    const centsPerThousand = applicableModel?.centsPerThousandRequests || 0;
    const costCents = Math.round((daily.requestCount / 1000) * centsPerThousand);

    totalCents += costCents;
    totalRequests += daily.requestCount;

    if (!apiBreakdown[apiIdStr]) {
      apiBreakdown[apiIdStr] = {
        apiId,
        apiName: daily.apiName,
        requestCount: 0,
        totalCents: 0,
      };
    }
    apiBreakdown[apiIdStr].requestCount += daily.requestCount;
    apiBreakdown[apiIdStr].totalCents += costCents;
  }

  const budgetUtilizationPct = team.monthlyBudgetCents > 0
    ? ((totalCents / team.monthlyBudgetCents) * 100)
    : 0;

  // Upsert cost report (idempotent — safe to re-run)
  await CostReport.findOneAndUpdate(
    { teamId, month },
    {
      $set: {
        teamSlug: team.slug,
        month,
        year: parseInt(month.split('-')[0], 10),
        totalCentsMtd: totalCents,
        totalRequestsMtd: totalRequests,
        apiBreakdown: Object.values(apiBreakdown),
        budgetCents: team.monthlyBudgetCents,
        budgetUtilizationPct: parseFloat(budgetUtilizationPct.toFixed(2)),
        lastAggregatedAt: new Date(),
      },
    },
    { upsert: true, new: true }
  );

  // Check budget thresholds and create alerts
  await checkBudgetAlerts(team, totalCents, budgetUtilizationPct, month);

  console.info(`[CostAggregator] Team ${team.slug}: ${totalRequests} requests, ${totalCents} cents (${budgetUtilizationPct.toFixed(1)}% of budget)`);
}

async function checkBudgetAlerts(team, totalCents, utilizationPct, month) {
  if (team.monthlyBudgetCents === 0) return; // No budget set

  const threshold = team.budgetAlertThresholdPct || 80;
  const isPreBreach = utilizationPct >= threshold && utilizationPct < 100;
  const isBreach = utilizationPct >= 100;

  if (!isPreBreach && !isBreach) return;

  const alertType = isBreach ? 'BUDGET_BREACH' : 'BUDGET_PRE_BREACH';
  const dedupKey = `${alertType}:${team._id}:${month}`;

  // Deduplication: don't create a new alert if one already exists for this month
  const existingAlert = await Alert.findOne({ dedupKey, status: { $in: ['open', 'acknowledged'] } });
  if (existingAlert) return;

  await Alert.create({
    type: alertType,
    severity: isBreach ? 'critical' : 'warning',
    teamId: team._id,
    message: isBreach
      ? `Team ${team.name} has exceeded their monthly budget (${utilizationPct.toFixed(1)}%)`
      : `Team ${team.name} has reached ${utilizationPct.toFixed(1)}% of their monthly budget`,
    details: {
      totalCents,
      budgetCents: team.monthlyBudgetCents,
      utilizationPct,
      month,
    },
    dedupKey,
  });

  console.warn(`[CostAggregator] 🚨 Alert created: ${alertType} for team ${team.slug}`);
}

/**
 * Schedule the nightly cost aggregation cron job.
 */
function scheduleCostAggregator() {
  // Run at midnight UTC every day
  cron.schedule('0 0 * * *', async () => {
    try {
      await runCostAggregation();
    } catch (err) {
      console.error('[CostAggregator] Cron run failed:', err.message);
    }
  }, {
    timezone: 'UTC',
  });

  console.info('[CostAggregator] ✅ Nightly cron scheduled (00:00 UTC)');
}

module.exports = { scheduleCostAggregator, runCostAggregation };
