/**
 * NexGate Gateway — Environment Validation
 * Uses Zod to validate all required env vars at startup.
 * If any required variable is missing or malformed, the process exits immediately.
 * This is a Phase 0 concern: a wrong env var discovered at runtime (not startup)
 * is far more expensive than failing fast before accepting any traffic.
 */

const { z } = require('zod');
require('dotenv').config();

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  GATEWAY_PORT: z.string().regex(/^\d+$/).transform(Number).default('3000'),
  GATEWAY_HOST: z.string().default('0.0.0.0'),

  // MongoDB
  MONGODB_URI: z.string().min(10, 'MONGODB_URI is required'),
  MONGODB_MAX_POOL_SIZE: z.string().regex(/^\d+$/).transform(Number).default('10'),
  MONGODB_MIN_POOL_SIZE: z.string().regex(/^\d+$/).transform(Number).default('2'),

  // Redis
  REDIS_URL: z.string().min(5, 'REDIS_URL is required'),
  REDIS_TLS: z.string().transform(v => v === 'true').default('false'),

  // Cache TTLs
  API_CONFIG_CACHE_TTL: z.string().transform(Number).default('300'),
  API_KEY_CACHE_TTL: z.string().transform(Number).default('120'),

  // Circuit Breaker
  CIRCUIT_BREAKER_THRESHOLD: z.string().transform(Number).default('5'),
  CIRCUIT_BREAKER_TIMEOUT: z.string().transform(Number).default('30000'),
  CIRCUIT_BREAKER_HALF_OPEN_REQUESTS: z.string().transform(Number).default('3'),

  // BullMQ
  LOG_QUEUE_NAME: z.string().default('nexgate:logs'),
  LOG_QUEUE_CONCURRENCY: z.string().transform(Number).default('10'),
  LOG_QUEUE_MAX_JOBS: z.string().transform(Number).default('50000'),

  // Rate Limiting
  DEFAULT_RATE_LIMIT_ALGORITHM: z
    .enum(['sliding_window_log', 'token_bucket', 'fixed_window'])
    .default('sliding_window_log'),
  DEFAULT_RATE_LIMIT_WINDOW_MS: z.string().transform(Number).default('60000'),
  DEFAULT_RATE_LIMIT_MAX_REQUESTS: z.string().transform(Number).default('100'),

  // Security
  API_KEY_HEADER: z.string().default('x-nexgate-key'),
  HASH_ALGORITHM: z.string().default('sha256'),

  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

let env;
try {
  env = envSchema.parse(process.env);
} catch (err) {
  console.error('❌ [NexGate] Invalid environment configuration:');
  if (err.errors) {
    err.errors.forEach(e => {
      console.error(`   ${e.path.join('.')}: ${e.message}`);
    });
  }
  process.exit(1);
}

module.exports = env;
