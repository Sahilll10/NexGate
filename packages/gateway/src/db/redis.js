const Redis = require('ioredis');
const env = require('../config/env');

let redisClient = null;
let redisSubscriber = null;

function createRedisClient(options = {}) {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    tls: env.REDIS_TLS ? {} : undefined,
    retryStrategy: (times) => {
      if (times > 10) {
        console.error('[Redis] Max retry attempts reached. Giving up.');
        return null;
      }
      const delay = Math.min(times * 200, 5000);
      console.warn(`[Redis] Retrying connection in ${delay}ms (attempt ${times})`);
      return delay;
    },
    enableOfflineQueue: true,
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