/**
 * NexGate — Token Bucket Algorithm
 * ════════════════════════════════════════════════════════════════════════════
 *
 * MECHANISM:
 * A "bucket" holds up to `burstCapacity` tokens. Tokens refill at `refillRate`
 * tokens per second continuously. On each request, one token is consumed.
 * If no tokens are available, the request is rejected with 429.
 *
 * REDIS STORAGE:
 * Two values per consumer key stored in a Redis Hash:
 *   nexgate:rl:tb:{apiId}:{teamId} → { tokens: float, lastRefill: timestamp_ms }
 *
 * WHY A HASH?
 * tokens and lastRefill must be read and written atomically together.
 * A Hash allows both fields to be updated in a single HMSET command,
 * reducing round trips. A Lua script handles the full read-compute-write atomically.
 *
 * MEMORY COST (vs Sliding Window Log):
 * Token Bucket: 2 fields × ~8 bytes each = ~16 bytes per (api, team) pair
 * Sliding Window Log: maxRequests × ~44 bytes per pair
 * At maxRequests=100: 100 × 44 = 4,400 bytes vs 16 bytes
 * Token Bucket uses ~275x less memory — critical for high-cardinality scenarios.
 *
 * BURST BEHAVIOUR:
 * This is Token Bucket's key advantage over Sliding Window.
 * Example: burstCapacity=100, refillRate=10 tokens/second (600/min limit effectively)
 *
 * Timeline:
 *   - 09:00:00 — Bucket is full (100 tokens)
 *   - 09:00:00 — Team sends 100 requests instantly → all allowed (burst absorbed)
 *   - 09:00:01 — 10 new tokens refilled → 10 more requests allowed
 *   - 09:00:10 — Bucket full again (100 tokens) → another burst possible
 *
 * With Sliding Window Log at 600/min limit:
 *   - 09:00:00 — 100 requests all arrive → 100 pass
 *   - 09:00:00 — 101st request → DENIED (hit limit for this second's window position)
 *   Wait, that's not right. With 600/min: 100 in first second is fine up to 600.
 *   The key difference: Token Bucket allows bursts up to burstCapacity regardless of
 *   time position; Sliding Window distributes more evenly.
 *
 * USE TOKEN BUCKET FOR:
 *   - Banking APIs that need to absorb genuine legitimate bursts (batch reconciliation)
 *   - APIs where a client legitimately needs to send many requests at startup
 *
 * USE SLIDING WINDOW FOR:
 *   - Internal analytics APIs where burst is a sign of a runaway process
 *   - High-security APIs where you want smooth distribution
 *
 * RETRY-AFTER CALCULATION:
 * Time until 1 token refills = (1 / refillRate) seconds
 * Exact: ((1 - currentTokens) / refillRate) seconds if currentTokens < 1
 */

const { getRedisClient } = require('../db/redis');

// Lua script for atomic token bucket check-and-update
// KEYS[1] = bucket key
// ARGV[1] = current time (ms), ARGV[2] = burstCapacity, ARGV[3] = refillRate (tokens/sec),
// ARGV[4] = ttl (seconds)
const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local burstCapacity = tonumber(ARGV[2])
local refillRate = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

-- Read current state
local data = redis.call('HMGET', key, 'tokens', 'lastRefill')
local tokens = tonumber(data[1])
local lastRefill = tonumber(data[2])

-- If key doesn't exist, start with full bucket
if tokens == nil then
  tokens = burstCapacity
  lastRefill = now
end

-- Compute elapsed time in seconds since last refill
local elapsed = (now - lastRefill) / 1000.0

-- Refill tokens based on elapsed time (cap at burstCapacity)
tokens = math.min(burstCapacity, tokens + elapsed * refillRate)

-- Check if request can be served
if tokens >= 1 then
  -- Consume one token
  tokens = tokens - 1
  -- Persist new state
  redis.call('HMSET', key, 'tokens', tokens, 'lastRefill', now)
  redis.call('EXPIRE', key, ttl)
  return {1, tokens, 0}  -- {allowed, tokensRemaining, retryAfterMs}
else
  -- Persist refreshed-but-insufficient state (update lastRefill so future requests recalculate correctly)
  redis.call('HMSET', key, 'tokens', tokens, 'lastRefill', now)
  redis.call('EXPIRE', key, ttl)
  -- Compute when the next token will be available
  local retryAfterMs = math.ceil((1 - tokens) / refillRate * 1000)
  return {0, tokens, retryAfterMs}  -- {denied, tokensRemaining, retryAfterMs}
end
`;

/**
 * Check and consume a token from the Token Bucket.
 *
 * @param {object} params
 * @param {string} params.apiId
 * @param {string} params.teamId
 * @param {number} params.burstCapacity - Maximum tokens the bucket can hold
 * @param {number} params.refillRate - Tokens added per second
 * @returns {Promise<{allowed: boolean, tokensRemaining: number, retryAfterMs: number}>}
 */
async function checkTokenBucket({ apiId, teamId, burstCapacity, refillRate }) {
  const redis = getRedisClient();
  const now = Date.now();
  const key = `nexgate:rl:tb:${apiId}:${teamId}`;
  // TTL: if no requests come in for 2x the time it takes to fill the bucket,
  // the key can safely expire. Full bucket time = burstCapacity / refillRate seconds.
  const ttlSeconds = Math.ceil((burstCapacity / refillRate) * 2) + 60;

  const result = await redis.eval(
    TOKEN_BUCKET_SCRIPT,
    1,
    key,
    now.toString(),
    burstCapacity.toString(),
    refillRate.toString(),
    ttlSeconds.toString()
  );

  const [allowed, tokensRemaining, retryAfterMs] = result.map(Number);

  return {
    allowed: allowed === 1,
    tokensRemaining: Math.floor(tokensRemaining),
    remaining: Math.floor(tokensRemaining),
    retryAfterMs,
    algorithm: 'token_bucket',
  };
}

module.exports = { checkTokenBucket };
