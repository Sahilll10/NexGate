/**
 * NexGate — Cache Services
 * ════════════════════════════════════════════════════════════════════════════
 *
 * TWO SEPARATE CACHES:
 *
 * 1. API Key Cache (apiKeyCache)
 *    Redis namespace: nexgate:key:{keyHash}
 *    TTL: 120 seconds (configurable)
 *    Stores: validated key document (teamId, status, allowedApiIds, scopes, expiresAt)
 *    Invalidation: explicit DEL when key is revoked, rotated, or permissions change
 *    Strategy: LAZY (populate on first miss, then serve from cache)
 *
 *    WHY NOT ALWAYS HIT MONGODB?
 *    At 1000 RPS, a MongoDB lookup per request = 1000 queries/second.
 *    MongoDB Atlas M0 free tier handles ~100 IOPS. This would exhaust the tier immediately.
 *    Redis lookup = ~0.2ms (in-datacenter) vs MongoDB = ~5-20ms.
 *    Cache hit rate for API keys is very high (keys are reused millions of times).
 *
 *    CONSISTENCY TRADE-OFF:
 *    If a key is revoked, it remains "valid" in cache for up to TTL seconds.
 *    120-second TTL means a revoked key can make up to 120 seconds of requests.
 *    MITIGATION: The management API sends an explicit DEL to Redis on revocation.
 *    The 120s TTL is a safety net if the DEL message is lost.
 *
 * 2. API Config Cache (apiConfigCache)
 *    Redis namespace: nexgate:api:{apiId}
 *    TTL: 300 seconds (configurable)
 *    Stores: API config document (targetBaseUrl, pathRewrite, timeoutMs, etc.)
 *    Invalidation: explicit DEL when API config changes in management portal
 *    Strategy: LAZY
 *
 *    This is critical: the proxy needs the target URL for EVERY request.
 *    Without caching, every request needs a MongoDB read for the API document.
 *    API configs change rarely (minutes to hours between changes).
 *    Cache hit rate approaches 99.99%.
 *
 * 3. Rate Limit Rule Cache (rateLimitRuleCache)
 *    Redis namespace: nexgate:rl-rule:{apiId}:{teamId}
 *    TTL: 60 seconds
 *    Stores: the resolved rate limit rule (algorithm, maxRequests, windowMs, etc.)
 *    Rule resolution order: team-specific override > global API rule > system default
 */

const { getRedisClient } = require('../db/redis');
const { ApiKey, Api, RateLimitRule } = require('../db/models/index');
const env = require('../config/env');

// ─── API KEY CACHE ────────────────────────────────────────────────────────────

async function getApiKeyFromCache(keyHash) {
  const redis = getRedisClient();
  const key = `nexgate:key:${keyHash}`;
  const cached = await redis.get(key);
  if (!cached) return null;
  return JSON.parse(cached);
}

async function setApiKeyInCache(keyHash, keyDoc) {
  const redis = getRedisClient();
  const key = `nexgate:key:${keyHash}`;
  await redis.set(key, JSON.stringify(keyDoc), 'EX', env.API_KEY_CACHE_TTL);
}

async function invalidateApiKeyCache(keyHash) {
  const redis = getRedisClient();
  await redis.del(`nexgate:key:${keyHash}`);
}

/**
 * Get API key document — tries cache first, falls back to MongoDB.
 * On cache miss, populates the cache (lazy caching strategy).
 *
 * @param {string} keyHash - SHA-256 hash of the raw API key
 * @returns {object|null} - Key document or null if not found
 */
async function resolveApiKey(keyHash) {
  // Step 1: Try Redis cache (fast path)
  let keyDoc = await getApiKeyFromCache(keyHash);
  if (keyDoc) {
    keyDoc._cacheHit = true;
    return keyDoc;
  }

  // Step 2: Redis miss — fall back to MongoDB
  keyDoc = await ApiKey.findOne({ keyHash })
    .select('teamId name status scopes allowedApiIds expiresAt rotationExpiresAt keyPrefix')
    .lean();

  if (!keyDoc) return null;

  // Step 3: Populate cache for future requests
  // If Redis is unavailable, this will throw — caller must handle.
  // We still return the doc from MongoDB (fail-open for validation, fail-closed for rate limiting).
  try {
    await setApiKeyInCache(keyHash, keyDoc);
  } catch (cacheErr) {
    // Non-fatal: log and continue. Key is valid, we just won't cache it.
    console.warn('[KeyCache] Failed to populate cache:', cacheErr.message);
  }

  keyDoc._cacheHit = false;
  return keyDoc;
}

// ─── API CONFIG CACHE ─────────────────────────────────────────────────────────

async function getApiConfigFromCache(apiId) {
  const redis = getRedisClient();
  const cached = await redis.get(`nexgate:api:${apiId}`);
  if (!cached) return null;
  return JSON.parse(cached);
}

async function setApiConfigInCache(apiId, apiDoc) {
  const redis = getRedisClient();
  await redis.set(`nexgate:api:${apiId}`, JSON.stringify(apiDoc), 'EX', env.API_CONFIG_CACHE_TTL);
}

async function invalidateApiConfigCache(apiId) {
  const redis = getRedisClient();
  await redis.del(`nexgate:api:${apiId}`);
}

async function resolveApiConfig(apiId) {
  let apiDoc = await getApiConfigFromCache(apiId);
  if (apiDoc) return { ...apiDoc, _cacheHit: true };

  apiDoc = await Api.findById(apiId)
    .select('name targetBaseUrl pathRewrite timeoutMs isActive stripApiKeyHeader ownerTeamId')
    .lean();

  if (!apiDoc) return null;

  try {
    await setApiConfigInCache(apiId, apiDoc);
  } catch (cacheErr) {
    console.warn('[ApiConfigCache] Failed to populate cache:', cacheErr.message);
  }

  return { ...apiDoc, _cacheHit: false };
}

// ─── RATE LIMIT RULE RESOLUTION ───────────────────────────────────────────────

async function resolveRateLimitRule(apiId, teamId) {
  const redis = getRedisClient();
  const cacheKey = `nexgate:rl-rule:${apiId}:${teamId}`;

  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // Rule resolution priority:
  // 1. Team-specific override for this API (scope=team, apiId matches, teamId matches)
  // 2. Global rule for this API (scope=global, apiId matches)
  // 3. System defaults from env

  // Try team-specific override first
  let rule = await RateLimitRule.findOne({
    apiId,
    teamId,
    scope: 'team',
    isActive: true,
  }).lean();

  // Fall back to global API rule
  if (!rule) {
    rule = await RateLimitRule.findOne({
      apiId,
      scope: 'global',
      isActive: true,
    }).lean();
  }

  // Fall back to system defaults
  if (!rule) {
    rule = {
      algorithm: env.DEFAULT_RATE_LIMIT_ALGORITHM,
      maxRequests: env.DEFAULT_RATE_LIMIT_MAX_REQUESTS,
      windowMs: env.DEFAULT_RATE_LIMIT_WINDOW_MS,
      burstCapacity: env.DEFAULT_RATE_LIMIT_MAX_REQUESTS,
      refillRate: env.DEFAULT_RATE_LIMIT_MAX_REQUESTS / 60,
      _isDefault: true,
    };
  }

  try {
    await redis.set(cacheKey, JSON.stringify(rule), 'EX', 60);
  } catch (err) {
    console.warn('[RuleCache] Failed to cache rule:', err.message);
  }

  return rule;
}

module.exports = {
  resolveApiKey,
  resolveApiConfig,
  resolveRateLimitRule,
  invalidateApiKeyCache,
  invalidateApiConfigCache,
};
