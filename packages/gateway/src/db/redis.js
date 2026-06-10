/**
 * NexGate Gateway — Redis Connection
 *
 * WHY REDIS (not in-memory counters)?
 * Three concrete failure scenarios where in-process counters break:
 *
 * 1. MULTI-INSTANCE DEPLOYMENT: Two gateway instances each have their own counter.
 *    Team A is allowed 100 req/min. Instance 1 sees 60 requests, Instance 2 sees 60.
 *    Both allow all 60 — team actually gets 120 req/min. Limit is silently bypassed.
 *
 * 2. PROCESS RESTART: A deployment or OOM-killer restarts the process at 11:59 PM.
 *    The in-memory counter resets to 0. A team that hit their 100 req/min limit
 *    can immediately fire another 100 requests in the same minute window.
 *
 * 3. SLIDING WINDOW ACCURACY: Sliding Window Log requires storing every request
 *    timestamp in the window. In-memory: multiple processes each maintain their own
 *    list — they cannot see each other's timestamps. The window log is incomplete,
 *    making the limit mathematically incorrect under concurrent load.
 *
 * Redis provides: single source of truth, persistence across restarts (with AOF),
 * and atomic operations (MULTI/EXEC, Lua scripts) that guarantee correctness.
 */

const Redis = require('ioredis');
const env = require('../config/env');

let redisClient = null;
let redisSubscriber = null; // Separate connection for pub/sub (ioredis requirement)

function createRedisClient(options = {}) {
  const client = new Redis(env.REDIS_URL, {
    // TLS for Upstash/Aiven production connections
    tls: env.REDIS_TLS ? {} : undefined,
    // Retry strategy: exponential back-off, cap at 5s, give up after 10 attempts
    retryStrategy: (times) => {
      if (times > 10) {
        console.error('[Redis] Max retry attempts reached. Giving up.');
        return null; // Stop retrying
      }
      const delay = Math.min(times * 200, 5000);
      console.warn(`[Redis] Retrying connection in ${delay}ms (attempt ${times})`);
      return delay;
    },
    // Don't reject commands while reconnecting — buffer them
    enableOfflineQueue: true,
    // Connection name for Redis CLIENT LIST debugging
    connectionName: options.name || 'nexgate-gateway',
    lazyConnect: false,
    ...options,
  });

  client.on('connect', () => console.info(`[Redis] ✅ Connected (${options.name || 'default'})`));
  client.on('error', err => console.error(`[Redis] Error: ${err.message}`));
  client.on('close', () => console.warn(`[Redis] Connection closed (${options.name || 'default'})`));

  return client;
}

function getRedisClient() {
  if (!redisClient) {
    redisClient = createRedisClient({ name: 'gateway-main' });
  }
  return redisClient;
}

function getRedisSubscriber() {
  if (!redisSubscriber) {
    redisSubscriber = createRedisClient({ name: 'gateway-sub' });
  }
  return redisSubscriber;
}

function isRedisHealthy() {
  return redisClient && redisClient.status === 'ready';
}

async function closeRedis() {
  if (redisClient) await redisClient.quit();
  if (redisSubscriber) await redisSubscriber.quit();
}

module.exports = {
  getRedisClient,
  getRedisSubscriber,
  createRedisClient,
  isRedisHealthy,
  closeRedis,
};
