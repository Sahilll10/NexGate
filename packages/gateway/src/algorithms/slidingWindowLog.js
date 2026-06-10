/**
 * NexGate — Sliding Window Log Algorithm
 * ════════════════════════════════════════════════════════════════════════════
 *
 * MECHANISM:
 * Every request's timestamp is stored in a Redis Sorted Set (ZSET).
 * The score = timestamp in milliseconds. The member = requestId (unique).
 * On each request:
 *   1. ZREMRANGEBYSCORE: remove all members with score < (now - windowMs)
 *      — these are outside the window
 *   2. ZCARD: count remaining members — this is the current request count
 *   3. If count < maxRequests: ZADD the new request; set TTL; ALLOW
 *   4. If count >= maxRequests: REJECT with 429
 *
 * WHY ATOMICITY IS CRITICAL:
 * Without atomicity, two concurrent requests can both read ZCARD=99 (limit=100),
 * both pass the check, both ZADD — resulting in 101 requests in the window.
 * We use a Lua script (executed with EVAL) for atomicity. Redis guarantees that
 * Lua scripts are executed as a single, uninterruptible unit.
 *
 * REDIS KEY NAMING:
 * Pattern: nexgate:rl:swl:{apiId}:{teamId}
 * Encodes: algorithm (swl), API, team — debuggable without external context.
 * TTL: windowMs/1000 + 1 second buffer. Without TTL, keys persist forever,
 * causing unbounded Redis memory growth. A stale key (team stops calling API)
 * will auto-expire after windowMs.
 *
 * MEMORY COST:
 * Each ZSET member stores: member (UUID, ~36 bytes) + score (8 bytes) = ~44 bytes
 * Per consumer: up to maxRequests members × 44 bytes
 * At 10,000 unique (api, team) pairs × 100 req/min limit:
 *   10,000 × 100 × 44 = 44,000,000 bytes = ~44 MB
 * This is significant — Token Bucket uses O(1) memory per pair (see tokenBucket.js).
 * Sliding Window Log is the most memory-intensive algorithm.
 *
 * RETRY-AFTER CALCULATION:
 * We need the oldest request in the current window. Its timestamp + windowMs = when
 * the window will have room again. ZRANGE with BYSCORE gives the oldest member's score.
 *
 * WHEN TO USE:
 * Sliding Window Log provides the most accurate rate limiting — no boundary burst.
 * Use for APIs where precision is critical (payment APIs, high-value operations).
 * Avoid for high-frequency low-value APIs (analytics) where memory cost is prohibitive.
 */

const { getRedisClient } = require('../db/redis');
const { v4: uuidv4 } = require('uuid');

// Lua script for atomic sliding window log check-and-record
// Arguments: KEYS[1] = redisKey, ARGV[1] = now (ms), ARGV[2] = windowStart (ms),
//            ARGV[3] = maxRequests, ARGV[4] = requestId, ARGV[5] = windowMs (seconds TTL)
const SLIDING_WINDOW_LOG_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowStart = tonumber(ARGV[2])
local maxRequests = tonumber(ARGV[3])
local requestId = ARGV[4]
local ttl = tonumber(ARGV[5])

-- Step 1: Remove expired entries (outside the window)
redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)

-- Step 2: Count current requests in window
local count = redis.call('ZCARD', key)

-- Step 3: Check if allowed
if count < maxRequests then
  -- Step 4: Add this request to the window
  redis.call('ZADD', key, now, requestId)
  -- Step 5: Refresh TTL
  redis.call('EXPIRE', key, ttl)
  return {1, count + 1, 0}  -- {allowed, currentCount, oldestTimestamp}
else
  -- Get the oldest request timestamp (for Retry-After calculation)
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local oldestScore = 0
  if #oldest > 0 then
    oldestScore = tonumber(oldest[2])
  end
  return {0, count, oldestScore}  -- {denied, currentCount, oldestTimestamp}
end
`;

/**
 * Check and record a request against the Sliding Window Log algorithm.
 *
 * @param {object} params
 * @param {string} params.apiId
 * @param {string} params.teamId
 * @param {number} params.maxRequests - Maximum requests per window
 * @param {number} params.windowMs - Window duration in milliseconds
 * @returns {Promise<{allowed: boolean, currentCount: number, retryAfterMs: number, remaining: number}>}
 */
async function checkSlidingWindowLog({ apiId, teamId, maxRequests, windowMs }) {
  const redis = getRedisClient();
  const now = Date.now();
  const windowStart = now - windowMs;
  const requestId = uuidv4();
  const ttlSeconds = Math.ceil(windowMs / 1000) + 1;
  const key = `nexgate:rl:swl:${apiId}:${teamId}`;

  const result = await redis.eval(
    SLIDING_WINDOW_LOG_SCRIPT,
    1, // numkeys
    key,
    now.toString(),
    windowStart.toString(),
    maxRequests.toString(),
    requestId,
    ttlSeconds.toString()
  );

  const [allowed, currentCount, oldestTimestamp] = result.map(Number);

  if (allowed === 1) {
    return {
      allowed: true,
      currentCount,
      remaining: maxRequests - currentCount,
      retryAfterMs: 0,
      algorithm: 'sliding_window_log',
    };
  } else {
    // Retry-After = time until oldest request exits the window
    // When oldestTimestamp + windowMs passes, there will be one free slot.
    const retryAfterMs = oldestTimestamp > 0
      ? Math.max(0, (oldestTimestamp + windowMs) - now)
      : windowMs;

    return {
      allowed: false,
      currentCount,
      remaining: 0,
      retryAfterMs,
      algorithm: 'sliding_window_log',
    };
  }
}

module.exports = { checkSlidingWindowLog };
