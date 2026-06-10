/**
 * NexGate — Fixed Window Algorithm
 * ════════════════════════════════════════════════════════════════════════════
 *
 * MECHANISM:
 * The time axis is divided into fixed, non-overlapping windows (e.g., each minute).
 * Each (api, team) pair has one counter per window. The counter is incremented
 * atomically (INCR) on each request. If counter > maxRequests, reject.
 *
 * The window key includes the window start time (e.g., floor(now / windowMs) * windowMs).
 * Key: nexgate:rl:fw:{apiId}:{teamId}:{windowStart}
 *
 * WHY IT'S THE CHEAPEST:
 * Operations per request: 2 (INCR + EXPIRE on first request, INCR only on subsequent)
 * INCR is an O(1) operation on a simple string key.
 * No ZADD, no Lua script, no HMGET/HMSET — just INCR.
 *
 * MEMORY COST:
 * One integer per (api, team, window) = ~8 bytes
 * Vastly cheaper than Sliding Window Log (~44 × maxRequests bytes)
 * Comparable to Token Bucket (~16 bytes) — both are O(1) per pair.
 *
 * THE BOUNDARY BURST PROBLEM (with exact numbers):
 * ─────────────────────────────────────────────────────────────────────────
 * Limit: 100 requests per 60-second window.
 * Window 1: 00:00:00 – 00:01:00
 * Window 2: 00:01:00 – 00:02:00
 *
 * Scenario: A client sends requests at the window boundary:
 *   - 00:00:59 — sends 100 requests → all allowed (fills Window 1's counter)
 *   - 00:01:00 — new window starts, counter resets to 0
 *   - 00:01:01 — sends 100 more requests → all allowed (fills Window 2's counter)
 *
 * In the 2-second span 00:00:59 – 00:01:01, 200 requests passed through.
 * The theoretical maximum in any 2-second window = 200 requests (2 × limit).
 * For a 60-second window: max burst = 200 requests in 2 seconds = 2× the intended rate.
 *
 * This is the boundary burst problem. The client can double the effective rate
 * by timing requests around window boundaries.
 *
 * WHEN FIXED WINDOW IS ACCEPTABLE:
 * 1. Internal analytics or logging APIs where a brief burst doesn't cause harm
 * 2. Very high request rates (10,000+ RPS) where INCR's speed is essential
 * 3. Resource-constrained Redis (Upstash free tier with limited commands/day):
 *    Fixed Window uses fewest commands — critical for free tier budget
 * 4. APIs consumed by internal services on predictable schedules (not adversarial)
 *
 * RETRY-AFTER CALCULATION:
 * Time remaining until the current window ends:
 * windowEnd = (floor(now / windowMs) + 1) × windowMs
 * retryAfterMs = windowEnd - now
 * This is exact and simple — unlike Sliding Window which requires querying the oldest entry.
 */

const { getRedisClient } = require('../db/redis');

/**
 * Check and increment the Fixed Window counter.
 *
 * @param {object} params
 * @param {string} params.apiId
 * @param {string} params.teamId
 * @param {number} params.maxRequests
 * @param {number} params.windowMs
 * @returns {Promise<{allowed: boolean, currentCount: number, retryAfterMs: number, remaining: number}>}
 */
async function checkFixedWindow({ apiId, teamId, maxRequests, windowMs }) {
  const redis = getRedisClient();
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const windowEnd = windowStart + windowMs;
  const key = `nexgate:rl:fw:${apiId}:${teamId}:${windowStart}`;
  const ttlSeconds = Math.ceil(windowMs / 1000) + 1;

  // INCR is atomic — no Lua script needed for the check.
  // However, we must set TTL on first request only. Use a pipeline:
  // INCR + EXPIRE in one round trip.
  // EXPIRE is idempotent — calling it again on subsequent requests resets TTL,
  // which is fine (window end time is the correct TTL anyway).
  const pipeline = redis.pipeline();
  pipeline.incr(key);
  pipeline.pexpire(key, windowMs + 1000); // +1s buffer
  const [[, currentCount]] = await pipeline.exec();

  const remaining = Math.max(0, maxRequests - currentCount);

  if (currentCount <= maxRequests) {
    return {
      allowed: true,
      currentCount,
      remaining,
      retryAfterMs: 0,
      algorithm: 'fixed_window',
    };
  } else {
    const retryAfterMs = windowEnd - now;
    return {
      allowed: false,
      currentCount,
      remaining: 0,
      retryAfterMs: Math.max(0, retryAfterMs),
      algorithm: 'fixed_window',
    };
  }
}

module.exports = { checkFixedWindow };
