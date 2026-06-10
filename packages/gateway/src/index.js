/**
 * NexGate — Data Plane Entry Point
 * ════════════════════════════════════════════════════════════════════════════
 * This is the API Gateway process. It handles ONLY the live request path.
 * It does NOT handle: management API, WebSocket, background jobs.
 * Those run in separate processes (packages/api, packages/workers).
 *
 * PROCESS ISOLATION RATIONALE:
 * - A traffic spike on the gateway does not starve the management API
 * - A worker crash does not take down the gateway
 * - Independent scaling: gateway can have 3 instances, workers can have 1
 * - Independent deployment: update workers without touching gateway
 *
 * At what volume does combining become dangerous?
 * Rule of thumb: when the gateway handles >200 RPS sustained.
 * At 200 RPS, the event loop is processing 200 concurrent request chains.
 * Adding management API routes (with their DB queries) into the same loop
 * introduces contention: a slow management API query delays gateway responses.
 * Separate processes eliminate this contention via OS-level scheduling.
 */

require('dotenv').config();
const env = require('./config/env'); // Validated at startup — crashes if invalid

const express = require('express');
const morgan = require('morgan');
const { connectMongoDB, isMongoHealthy } = require('./db/mongodb');
const { getRedisClient, isRedisHealthy } = require('./db/redis');
const {
  requestId,
  extractApiKey,
  validateApiKey,
  checkRateLimit,
  checkScope,
  resolveAndCheck,
  captureMetrics,
  createProxyHandler,
} = require('./middleware/index');

const app = express();

// ─── GLOBAL MIDDLEWARE ────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Access log (dev: colored, prod: JSON for log aggregators)
if (env.NODE_ENV === 'production') {
  app.use(morgan('combined'));
} else {
  app.use(morgan('dev'));
}

// ─── HEALTH CHECK ENDPOINT ────────────────────────────────────────────────────
// Verifies BOTH MongoDB and Redis connectivity (not just HTTP).
// Render uses this to determine if the instance is healthy.
// A "healthy" response MUST check dependencies — a gateway that can't reach
// its databases is not healthy, even if it can serve HTTP.
app.get('/health', async (req, res) => {
  const mongoOk = isMongoHealthy();
  const redisOk = isRedisHealthy();

  // Quick Redis ping to verify actual connectivity (not just connection object state)
  let redisPing = false;
  try {
    const redis = getRedisClient();
    const pong = await Promise.race([
      redis.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    redisPing = pong === 'PONG';
  } catch (_) {
    redisPing = false;
  }

  const healthy = mongoOk && redisPing;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    checks: {
      mongodb: mongoOk ? 'connected' : 'disconnected',
      redis: redisPing ? 'connected' : 'disconnected',
    },
    uptime: process.uptime(),
  });
});

// ─── GATEWAY PROXY ROUTES ──────────────────────────────────────────────────────
// Route pattern: /proxy/:apiId/* — all requests include the API ID in the path.
// The API ID is how the gateway resolves the downstream target URL.
// This is a design decision: the consumer includes the API ID, not a custom hostname.
// Alternative: subdomain routing (each API gets a subdomain). Rejected because:
// subdomains require wildcard TLS certificates and DNS management — more infrastructure.
// Path-based routing requires nothing beyond the gateway's Express config.

const router = express.Router({ mergeParams: true });

// Middleware applied to every proxied request (in order)
router.use(requestId);         // 1. Attach UUID, start timer
router.use(captureMetrics);    // 2. Hook response.finish for logging
router.use(extractApiKey);     // 3. Extract key from header, hash it
router.use(validateApiKey);    // 4. Validate key (cache → DB)

// Extract apiId from path and attach to req before rate limit / scope checks
router.use((req, res, next) => {
  req._resolvedApiId = req.params.apiId;
  next();
});

router.use(checkRateLimit);    // 5. Rate limit check (Redis)
router.use(checkScope);        // 6. Scope/permission check
router.use(resolveAndCheck);   // 7. Resolve target URL + circuit breaker
router.use(createProxyHandler()); // 8. Forward request to upstream

app.use('/proxy/:apiId', router);

// ─── CATCH-ALL ────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: 'NOT_FOUND',
    message: 'Gateway route not found. Use /proxy/:apiId/* for API calls.',
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[Gateway] Unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      requestId: req?.requestId,
    });
  }
});

// ─── STARTUP SEQUENCE ─────────────────────────────────────────────────────────
async function start() {
  try {
    console.info('[Gateway] Starting NexGate Data Plane...');
    console.info(`[Gateway] Environment: ${env.NODE_ENV}`);

    // Connect to dependencies BEFORE accepting traffic
    // If either fails, the process exits — a gateway that can't reach its
    // dependencies should not accept requests.
    await connectMongoDB();

    const redis = getRedisClient();
    await new Promise((resolve, reject) => {
      if (redis.status === 'ready') return resolve();
      redis.once('ready', resolve);
      redis.once('error', reject);
      setTimeout(() => reject(new Error('Redis connection timeout')), 10000);
    });

    console.info('[Gateway] ✅ Redis connected');

    const server = app.listen(env.GATEWAY_PORT, env.GATEWAY_HOST, () => {
      console.info(`[Gateway] 🚀 NexGate listening on http://${env.GATEWAY_HOST}:${env.GATEWAY_PORT}`);
      console.info(`[Gateway] Health: http://${env.GATEWAY_HOST}:${env.GATEWAY_PORT}/health`);
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
      console.info(`\n[Gateway] ${signal} received — shutting down gracefully...`);
      server.close(async () => {
        const { closeRedis } = require('./db/redis');
        const mongoose = require('mongoose');
        await closeRedis();
        await mongoose.disconnect();
        console.info('[Gateway] Shutdown complete.');
        process.exit(0);
      });
      // Force exit after 30s if graceful shutdown hangs
      setTimeout(() => process.exit(1), 30000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (err) {
    console.error('[Gateway] ❌ Startup failed:', err.message);
    process.exit(1);
  }
}

start();
