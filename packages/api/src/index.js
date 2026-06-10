/**
 * NexGate — Control Plane Entry Point (Management API + WebSocket)
 */

require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');

const { connectMongoDB, isMongoHealthy } = require('../../gateway/src/db/mongodb');
const { getRedisClient, isRedisHealthy } = require('../../gateway/src/db/redis');
const { initSocketIO } = require('./socket/index');
const { router: authRouter } = require('./routes/auth');
const {
  teamsRouter,
  apisRouter,
  apiKeysRouter,
  rateLimitRulesRouter,
  slaRouter,
  costsRouter,
  alertsRouter,
  analyticsRouter,
} = require('./routes/index');

const app = express();
const httpServer = http.createServer(app);

// ─── SECURITY MIDDLEWARE ─────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'", 'wss:', 'ws:'],
    },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin: process.env.PORTAL_URL || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Rate limiting on the management API itself (separate from gateway rate limiting)
// This prevents brute-force attacks on the admin portal login
const mgmtRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'MANAGEMENT_API_RATE_LIMIT', message: 'Too many requests to management API' },
});

const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // Strict limit on auth endpoints
  skipSuccessfulRequests: true,
  message: { error: 'LOGIN_RATE_LIMIT', message: 'Too many login attempts. Try again in 15 minutes.' },
});

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(mgmtRateLimiter);

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const mongoOk = isMongoHealthy();
  let redisPing = false;
  try {
    const pong = await Promise.race([
      getRedisClient().ping(),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 3000)),
    ]);
    redisPing = pong === 'PONG';
  } catch (_) {}

  const healthy = mongoOk && redisPing;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    service: 'nexgate-api',
    checks: {
      mongodb: mongoOk ? 'connected' : 'disconnected',
      redis: redisPing ? 'connected' : 'disconnected',
    },
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.use('/api/auth', loginRateLimiter, authRouter);
app.use('/api/teams', teamsRouter);
app.use('/api/apis', apisRouter);
app.use('/api/keys', apiKeysRouter);
app.use('/api/rate-limit-rules', rateLimitRulesRouter);
app.use('/api/sla', slaRouter);
app.use('/api/costs', costsRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/analytics', analyticsRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', path: req.path });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[API] Unhandled error:', err);
  res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
});

// ─── STARTUP ──────────────────────────────────────────────────────────────────
async function start() {
  try {
    console.info('[API] Starting NexGate Control Plane...');

    await connectMongoDB();

    const redis = getRedisClient();
    await new Promise((resolve, reject) => {
      if (redis.status === 'ready') return resolve();
      redis.once('ready', resolve);
      redis.once('error', reject);
      setTimeout(() => reject(new Error('Redis timeout')), 10000);
    });

    // Initialise Socket.io after Redis is confirmed ready
    initSocketIO(httpServer);

    const PORT = process.env.API_PORT || 4000;
    const HOST = process.env.API_HOST || '0.0.0.0';

    httpServer.listen(PORT, HOST, () => {
      console.info(`[API] 🚀 Management API listening on http://${HOST}:${PORT}`);
      console.info(`[API] WebSocket: ws://${HOST}:${PORT}/metrics`);
    });

    const shutdown = async (signal) => {
      console.info(`\n[API] ${signal} — shutting down...`);
      httpServer.close(async () => {
        await mongoose.disconnect();
        const { closeRedis } = require('../../gateway/src/db/redis');
        await closeRedis();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 30000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (err) {
    console.error('[API] ❌ Startup failed:', err.message);
    process.exit(1);
  }
}

start();
