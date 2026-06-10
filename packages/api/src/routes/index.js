/**
 * NexGate Management API — All Resource Routes
 * ════════════════════════════════════════════════════════════════════════════
 */

const express = require('express');
const { authenticate } = require('../middleware/authenticate');
const { generateApiKey } = require('../../../gateway/src/utils/crypto');

// Import models (shared between packages via monorepo)
// In production, extract models to @nexgate/models shared package
const {
  Team,
  Api,
  ApiKey,
  RateLimitRule,
  SlaDefinition,
  CostReport,
  Alert,
  CostModel,
} = require('../../../gateway/src/db/models/index');

// ─── TEAMS ───────────────────────────────────────────────────────────────────
const teamsRouter = express.Router();
teamsRouter.use(authenticate);

teamsRouter.get('/', async (req, res) => {
  try {
    const teams = await Team.find({ isActive: true }).sort({ name: 1 });
    res.json({ teams });
  } catch (err) {
    res.status(500).json({ error: 'FETCH_FAILED', details: err.message });
  }
});

teamsRouter.post('/', async (req, res) => {
  try {
    const { name, slug, description, email, monthlyBudgetCents, budgetAlertThresholdPct } = req.body;
    const team = await Team.create({ name, slug, description, email, monthlyBudgetCents, budgetAlertThresholdPct });
    res.status(201).json({ team });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'TEAM_ALREADY_EXISTS' });
    res.status(400).json({ error: 'CREATE_FAILED', details: err.message });
  }
});

teamsRouter.get('/:teamId', async (req, res) => {
  try {
    const team = await Team.findById(req.params.teamId);
    if (!team) return res.status(404).json({ error: 'TEAM_NOT_FOUND' });
    res.json({ team });
  } catch (err) {
    res.status(500).json({ error: 'FETCH_FAILED' });
  }
});

teamsRouter.put('/:teamId', async (req, res) => {
  try {
    const team = await Team.findByIdAndUpdate(
      req.params.teamId,
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!team) return res.status(404).json({ error: 'TEAM_NOT_FOUND' });
    res.json({ team });
  } catch (err) {
    res.status(400).json({ error: 'UPDATE_FAILED', details: err.message });
  }
});

teamsRouter.delete('/:teamId', async (req, res) => {
  try {
    await Team.findByIdAndUpdate(req.params.teamId, { isActive: false });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'DELETE_FAILED' });
  }
});

// ─── APIS ─────────────────────────────────────────────────────────────────────
const apisRouter = express.Router();
apisRouter.use(authenticate);

apisRouter.get('/', async (req, res) => {
  try {
    const { search, teamId, page = 1, limit = 20 } = req.query;
    const query = { isActive: true };

    if (teamId) query.ownerTeamId = teamId;

    if (search) {
      // Full-text search using MongoDB $text index
      // Limitation: no fuzzy match; searches name, description, tags with weights
      query.$text = { $search: search };
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [apis, total] = await Promise.all([
      Api.find(query)
        .populate('ownerTeamId', 'name slug')
        .sort(search ? { score: { $meta: 'textScore' } } : { name: 1 })
        .skip(skip)
        .limit(Number(limit)),
      Api.countDocuments(query),
    ]);

    res.json({ apis, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    res.status(500).json({ error: 'FETCH_FAILED', details: err.message });
  }
});

apisRouter.post('/', async (req, res) => {
  try {
    const api = await Api.create(req.body);

    // Invalidate API config cache on any API change
    const { getRedisClient } = require('../../../gateway/src/db/redis');
    try {
      await getRedisClient().del(`nexgate:api:${api._id}`);
    } catch (_) {}

    res.status(201).json({ api });
  } catch (err) {
    res.status(400).json({ error: 'CREATE_FAILED', details: err.message });
  }
});

apisRouter.get('/:apiId', async (req, res) => {
  try {
    const api = await Api.findById(req.params.apiId).populate('ownerTeamId', 'name slug');
    if (!api) return res.status(404).json({ error: 'API_NOT_FOUND' });
    res.json({ api });
  } catch (err) {
    res.status(500).json({ error: 'FETCH_FAILED' });
  }
});

apisRouter.put('/:apiId', async (req, res) => {
  try {
    const api = await Api.findByIdAndUpdate(
      req.params.apiId,
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!api) return res.status(404).json({ error: 'API_NOT_FOUND' });

    // Invalidate cache
    const { getRedisClient } = require('../../../gateway/src/db/redis');
    try {
      await getRedisClient().del(`nexgate:api:${api._id}`);
      await getRedisClient().del(`nexgate:rl-rule:${api._id}:*`);
    } catch (_) {}

    res.json({ api });
  } catch (err) {
    res.status(400).json({ error: 'UPDATE_FAILED', details: err.message });
  }
});

apisRouter.delete('/:apiId', async (req, res) => {
  try {
    await Api.findByIdAndUpdate(req.params.apiId, { isActive: false });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'DELETE_FAILED' });
  }
});

// ─── API KEYS ─────────────────────────────────────────────────────────────────
const apiKeysRouter = express.Router();
apiKeysRouter.use(authenticate);

// Generate a new API key
apiKeysRouter.post('/', async (req, res) => {
  try {
    const { name, teamId, allowedApiIds, scopes, expiresAt, metadata } = req.body;

    // Generate cryptographically secure key
    const { rawKey, keyHash, keyPrefix } = generateApiKey();

    // Store ONLY the hash — rawKey is returned ONCE and never stored
    const apiKey = await ApiKey.create({
      name,
      keyPrefix,
      keyHash,
      teamId,
      createdBy: req.userId,
      allowedApiIds: allowedApiIds || [],
      scopes: scopes || ['read'],
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      metadata: metadata || {},
    });

    // Return rawKey ONLY in this response — it cannot be retrieved later
    res.status(201).json({
      apiKey: {
        id: apiKey._id,
        name: apiKey.name,
        teamId: apiKey.teamId,
        scopes: apiKey.scopes,
        expiresAt: apiKey.expiresAt,
        createdAt: apiKey.createdAt,
      },
      // The raw key shown to user EXACTLY ONCE
      rawKey,
      warning: 'STORE_THIS_KEY_NOW: This key will never be shown again.',
    });
  } catch (err) {
    res.status(400).json({ error: 'KEY_GENERATION_FAILED', details: err.message });
  }
});

// List keys for a team (never returns keyHash)
apiKeysRouter.get('/', async (req, res) => {
  try {
    const { teamId, status } = req.query;
    const query = {};
    if (teamId) query.teamId = teamId;
    if (status) query.status = status;

    const keys = await ApiKey.find(query)
      .select('-keyHash') // NEVER expose the hash
      .populate('teamId', 'name slug')
      .sort({ createdAt: -1 });

    res.json({ keys });
  } catch (err) {
    res.status(500).json({ error: 'FETCH_FAILED' });
  }
});

// Revoke a key
apiKeysRouter.post('/:keyId/revoke', async (req, res) => {
  try {
    const key = await ApiKey.findByIdAndUpdate(
      req.params.keyId,
      { status: 'revoked' },
      { new: true }
    );
    if (!key) return res.status(404).json({ error: 'KEY_NOT_FOUND' });

    // Immediately invalidate cache — don't wait for TTL expiry
    const { getRedisClient } = require('../../../gateway/src/db/redis');
    try {
      await getRedisClient().del(`nexgate:key:${key.keyHash}`);
    } catch (_) {}

    res.json({ success: true, keyId: key._id });
  } catch (err) {
    res.status(500).json({ error: 'REVOKE_FAILED' });
  }
});

// Rotate a key (generates new key, puts old in 'rotating' state with expiry)
apiKeysRouter.post('/:keyId/rotate', async (req, res) => {
  try {
    const oldKey = await ApiKey.findById(req.params.keyId);
    if (!oldKey) return res.status(404).json({ error: 'KEY_NOT_FOUND' });

    const rotationWindowMs = req.body.rotationWindowMs || 24 * 60 * 60 * 1000; // 24 hours default

    // Mark old key as rotating (still valid for rotationWindowMs)
    await ApiKey.findByIdAndUpdate(req.params.keyId, {
      status: 'rotating',
      rotationExpiresAt: new Date(Date.now() + rotationWindowMs),
    });

    // Generate new key with same permissions
    const { rawKey, keyHash, keyPrefix } = generateApiKey();
    const newKey = await ApiKey.create({
      name: `${oldKey.name} (rotated)`,
      keyPrefix,
      keyHash,
      teamId: oldKey.teamId,
      createdBy: req.userId,
      allowedApiIds: oldKey.allowedApiIds,
      scopes: oldKey.scopes,
      expiresAt: oldKey.expiresAt,
    });

    res.status(201).json({
      newKeyId: newKey._id,
      rawKey,
      rotationWindowMs,
      oldKeyExpiresAt: new Date(Date.now() + rotationWindowMs),
      warning: 'STORE_THIS_KEY_NOW: The new key will never be shown again.',
    });
  } catch (err) {
    res.status(500).json({ error: 'ROTATION_FAILED', details: err.message });
  }
});

// ─── RATE LIMIT RULES ─────────────────────────────────────────────────────────
const rateLimitRulesRouter = express.Router();
rateLimitRulesRouter.use(authenticate);

rateLimitRulesRouter.get('/', async (req, res) => {
  try {
    const { apiId, teamId } = req.query;
    const query = { isActive: true };
    if (apiId) query.apiId = apiId;
    if (teamId) query.teamId = teamId;

    const rules = await RateLimitRule.find(query)
      .populate('apiId', 'name')
      .populate('teamId', 'name slug')
      .sort({ scope: 1, createdAt: -1 });

    res.json({ rules });
  } catch (err) {
    res.status(500).json({ error: 'FETCH_FAILED' });
  }
});

rateLimitRulesRouter.post('/', async (req, res) => {
  try {
    const rule = await RateLimitRule.create(req.body);

    // Invalidate rate limit rule cache
    const { getRedisClient } = require('../../../gateway/src/db/redis');
    try {
      const apiId = req.body.apiId;
      const teamId = req.body.teamId || '*';
      await getRedisClient().del(`nexgate:rl-rule:${apiId}:${teamId}`);
    } catch (_) {}

    res.status(201).json({ rule });
  } catch (err) {
    res.status(400).json({ error: 'CREATE_FAILED', details: err.message });
  }
});

rateLimitRulesRouter.put('/:ruleId', async (req, res) => {
  try {
    const rule = await RateLimitRule.findByIdAndUpdate(
      req.params.ruleId,
      { $set: req.body },
      { new: true }
    );
    if (!rule) return res.status(404).json({ error: 'RULE_NOT_FOUND' });
    res.json({ rule });
  } catch (err) {
    res.status(400).json({ error: 'UPDATE_FAILED', details: err.message });
  }
});

rateLimitRulesRouter.delete('/:ruleId', async (req, res) => {
  try {
    await RateLimitRule.findByIdAndUpdate(req.params.ruleId, { isActive: false });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'DELETE_FAILED' });
  }
});

// ─── SLA DEFINITIONS ──────────────────────────────────────────────────────────
const slaRouter = express.Router();
slaRouter.use(authenticate);

slaRouter.get('/', async (req, res) => {
  try {
    const { apiId, teamId } = req.query;
    const query = { isActive: true };
    if (apiId) query.apiId = apiId;
    if (teamId) query.teamId = teamId;

    const slas = await SlaDefinition.find(query)
      .populate('apiId', 'name')
      .populate('teamId', 'name slug')
      .sort({ createdAt: -1 });

    res.json({ slas });
  } catch (err) {
    res.status(500).json({ error: 'FETCH_FAILED' });
  }
});

slaRouter.post('/', async (req, res) => {
  try {
    const sla = await SlaDefinition.create(req.body);
    res.status(201).json({ sla });
  } catch (err) {
    res.status(400).json({ error: 'CREATE_FAILED', details: err.message });
  }
});

slaRouter.put('/:slaId', async (req, res) => {
  try {
    const sla = await SlaDefinition.findByIdAndUpdate(
      req.params.slaId,
      { $set: req.body },
      { new: true }
    );
    if (!sla) return res.status(404).json({ error: 'SLA_NOT_FOUND' });
    res.json({ sla });
  } catch (err) {
    res.status(400).json({ error: 'UPDATE_FAILED' });
  }
});

// ─── COST REPORTS ─────────────────────────────────────────────────────────────
const costsRouter = express.Router();
costsRouter.use(authenticate);

costsRouter.get('/', async (req, res) => {
  try {
    const { teamId, month } = req.query;
    const query = {};
    if (teamId) query.teamId = teamId;
    if (month) query.month = month;

    const reports = await CostReport.find(query)
      .populate('teamId', 'name slug')
      .sort({ month: -1, createdAt: -1 });

    res.json({ reports });
  } catch (err) {
    res.status(500).json({ error: 'FETCH_FAILED' });
  }
});

costsRouter.get('/summary', async (req, res) => {
  try {
    const currentMonth = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
    const reports = await CostReport.find({ month: currentMonth }).populate('teamId', 'name slug');

    const totalCents = reports.reduce((sum, r) => sum + r.totalCentsMtd, 0);
    const totalRequests = reports.reduce((sum, r) => sum + r.totalRequestsMtd, 0);

    res.json({
      month: currentMonth,
      totalCostCents: totalCents,
      totalCostUsd: (totalCents / 100).toFixed(2),
      totalRequests,
      teamBreakdown: reports.map(r => ({
        team: r.teamId,
        costCents: r.totalCentsMtd,
        requests: r.totalRequestsMtd,
        budgetUtilizationPct: r.budgetUtilizationPct,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'FETCH_FAILED' });
  }
});

// ─── ALERTS ───────────────────────────────────────────────────────────────────
const alertsRouter = express.Router();
alertsRouter.use(authenticate);

alertsRouter.get('/', async (req, res) => {
  try {
    const { teamId, status, type, page = 1, limit = 50 } = req.query;
    const query = {};
    if (teamId) query.teamId = teamId;
    if (status) query.status = status;
    if (type) query.type = type;

    const skip = (Number(page) - 1) * Number(limit);
    const [alerts, total] = await Promise.all([
      Alert.find(query)
        .populate('teamId', 'name slug')
        .populate('apiId', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      Alert.countDocuments(query),
    ]);

    res.json({ alerts, total });
  } catch (err) {
    res.status(500).json({ error: 'FETCH_FAILED' });
  }
});

alertsRouter.post('/:alertId/acknowledge', async (req, res) => {
  try {
    const alert = await Alert.findByIdAndUpdate(
      req.params.alertId,
      { status: 'acknowledged', acknowledgedAt: new Date() },
      { new: true }
    );
    if (!alert) return res.status(404).json({ error: 'ALERT_NOT_FOUND' });
    res.json({ alert });
  } catch (err) {
    res.status(500).json({ error: 'UPDATE_FAILED' });
  }
});

alertsRouter.post('/:alertId/resolve', async (req, res) => {
  try {
    const alert = await Alert.findByIdAndUpdate(
      req.params.alertId,
      { status: 'resolved', resolvedAt: new Date(), resolvedBy: req.userId },
      { new: true }
    );
    if (!alert) return res.status(404).json({ error: 'ALERT_NOT_FOUND' });
    res.json({ alert });
  } catch (err) {
    res.status(500).json({ error: 'UPDATE_FAILED' });
  }
});

// ─── ANALYTICS ────────────────────────────────────────────────────────────────
const analyticsRouter = express.Router();
analyticsRouter.use(authenticate);

analyticsRouter.get('/overview', async (req, res) => {
  try {
    const { RequestLog } = require('../../../gateway/src/db/models/index');
    const now = new Date();
    const last24h = new Date(now - 24 * 60 * 60 * 1000);
    const last1h = new Date(now - 60 * 60 * 1000);

    const [last24hStats, last1hStats, topApis] = await Promise.all([
      RequestLog.aggregate([
        { $match: { timestamp: { $gte: last24h } } },
        {
          $group: {
            _id: null,
            totalRequests: { $sum: 1 },
            avgLatencyMs: { $avg: '$latencyMs' },
            errorCount: { $sum: { $cond: [{ $gte: ['$statusCode', 500] }, 1, 0] } },
            rateLimitedCount: { $sum: { $cond: ['$wasRateLimited', 1, 0] } },
          },
        },
      ]),
      RequestLog.aggregate([
        { $match: { timestamp: { $gte: last1h } } },
        { $group: { _id: null, totalRequests: { $sum: 1 } } },
      ]),
      RequestLog.aggregate([
        { $match: { timestamp: { $gte: last24h } } },
        { $group: { _id: '$meta.apiId', requestCount: { $sum: 1 }, apiName: { $first: '$apiName' } } },
        { $sort: { requestCount: -1 } },
        { $limit: 5 },
      ]),
    ]);

    const stats24h = last24hStats[0] || {};
    const stats1h = last1hStats[0] || {};

    res.json({
      last24h: {
        totalRequests: stats24h.totalRequests || 0,
        avgLatencyMs: Math.round(stats24h.avgLatencyMs || 0),
        errorRatePct: stats24h.totalRequests
          ? ((stats24h.errorCount / stats24h.totalRequests) * 100).toFixed(2)
          : 0,
        rateLimitRatePct: stats24h.totalRequests
          ? ((stats24h.rateLimitedCount / stats24h.totalRequests) * 100).toFixed(2)
          : 0,
      },
      rpsLast1h: Math.round((stats1h.totalRequests || 0) / 3600),
      topApis,
    });
  } catch (err) {
    res.status(500).json({ error: 'ANALYTICS_FAILED', details: err.message });
  }
});

analyticsRouter.get('/timeseries', async (req, res) => {
  try {
    const { RequestLog } = require('../../../gateway/src/db/models/index');
    const { apiId, teamId, interval = '5m', hours = 24 } = req.query;

    const since = new Date(Date.now() - Number(hours) * 60 * 60 * 1000);
    const match = { timestamp: { $gte: since } };
    if (apiId) match['meta.apiId'] = new require('mongoose').Types.ObjectId(apiId);
    if (teamId) match['meta.teamId'] = new require('mongoose').Types.ObjectId(teamId);

    // Bucket size in minutes
    const bucketMinutes = interval === '1m' ? 1 : interval === '5m' ? 5 : 60;
    const bucketMs = bucketMinutes * 60 * 1000;

    const series = await RequestLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            bucket: {
              $subtract: [
                { $toLong: '$timestamp' },
                { $mod: [{ $toLong: '$timestamp' }, bucketMs] },
              ],
            },
          },
          requestCount: { $sum: 1 },
          avgLatencyMs: { $avg: '$latencyMs' },
          errorCount: { $sum: { $cond: [{ $gte: ['$statusCode', 500] }, 1, 0] } },
          // $percentile operator (MongoDB 7.0+) for exact P95
          // Falls back to approximate for older versions
          latencies: { $push: '$latencyMs' },
        },
      },
      { $sort: { '_id.bucket': 1 } },
    ]);

    // Compute P95 from the latencies array (sort-based — exact)
    const result = series.map(bucket => {
      const sorted = [...bucket.latencies].sort((a, b) => a - b);
      const p95Index = Math.floor(sorted.length * 0.95);
      return {
        timestamp: new Date(bucket._id.bucket).toISOString(),
        requestCount: bucket.requestCount,
        avgLatencyMs: Math.round(bucket.avgLatencyMs),
        p95LatencyMs: sorted[p95Index] || 0,
        errorCount: bucket.errorCount,
        rps: Math.round(bucket.requestCount / (bucketMinutes * 60)),
      };
    });

    res.json({ series: result, interval, hours: Number(hours) });
  } catch (err) {
    res.status(500).json({ error: 'ANALYTICS_FAILED', details: err.message });
  }
});

module.exports = {
  teamsRouter,
  apisRouter,
  apiKeysRouter,
  rateLimitRulesRouter,
  slaRouter,
  costsRouter,
  alertsRouter,
  analyticsRouter,
};
