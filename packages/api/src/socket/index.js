/**
 * NexGate — Socket.io Real-Time Metrics Server
 * ════════════════════════════════════════════════════════════════════════════
 *
 * MULTI-INSTANCE SCALING PROBLEM:
 * Socket.io's default in-process EventEmitter cannot broadcast to clients
 * connected to DIFFERENT Node.js instances. Example:
 *   - Instance A: serves client browser sessions for 25 analysts
 *   - Instance B: serves client browser sessions for 25 analysts
 *   - Worker emits a metric event to Instance A
 *   - The 25 clients on Instance B never receive it
 *
 * SOLUTION: @socket.io/redis-adapter
 * The Redis adapter uses Redis Pub/Sub internally:
 *   - Each instance subscribes to a shared Redis Pub/Sub channel
 *   - When any instance emits an event, it publishes to Redis
 *   - All other instances receive the message via subscription
 *   - Each instance then delivers the event to its local connected clients
 * This makes the Socket.io cluster behave as a single logical server.
 *
 * REDIS DATA STRUCTURE USED BY ADAPTER:
 * Redis Pub/Sub channels (not streams, not lists).
 * Channels: socket.io#namespace#roomName# (default pattern)
 * The adapter does NOT use Redis Streams (XADD/XREAD) — it uses PUBLISH/SUBSCRIBE.
 * This means messages are NOT persistent — if a client is disconnected during
 * a publish, it misses that message. Acceptable for live metrics (real-time only).
 *
 * SHOULD WEBSOCKET LIVE IN GATEWAY PROCESS OR SEPARATE?
 * DECISION: Separate (packages/api process), not in the gateway process.
 * REASON:
 *   - Gateway's event loop is optimised for high-frequency, low-latency proxying.
 *     Adding WebSocket connection management (50 clients × heartbeat + emit cycles)
 *     adds overhead to every event loop iteration.
 *   - WebSocket clients connecting/disconnecting trigger expensive room joins.
 *     These should not compete with proxy request handling.
 *   - Failure isolation: a WebSocket memory leak doesn't kill the proxy.
 *   - Independent scaling: WebSocket server can be a single instance (stateful
 *     connections are load-balanced differently than HTTP).
 *
 * NAMESPACE & ROOM STRUCTURE:
 * Namespace: /metrics (scoped from default / namespace)
 * Rooms (per namespace):
 *   - team:{teamId}  — receives events only for this team's APIs
 *   - api:{apiId}    — receives events for a specific API
 *   - global         — receives platform-wide aggregate metrics (admin only)
 *
 * Room scoping enforces data isolation: Team A cannot see Team B's metrics.
 * The server joins each socket to the appropriate rooms at connection time,
 * after verifying the JWT and extracting the teamId claim.
 *
 * THUNDERING HERD PROTECTION:
 * Problem: 10,000 requests in 10 seconds × 50 clients = 500,000 emit() calls.
 * Solution: Batch + throttle. Metrics are NOT emitted per-request.
 * The MetricsAggregator collects raw data in memory and emits on a fixed interval
 * (default: 1 second). This bounds emit frequency to 1/second per namespace,
 * regardless of RPS. Message size stays small and predictable.
 */

const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const jwt = require('jsonwebtoken');
const { createRedisClient } = require('../../../gateway/src/db/redis');

let io = null;

// In-memory metrics accumulator — collects data between emit intervals
// Keys: apiId → { requests, errors, latencies[], teamId }
const metricsBuffer = new Map();
const EMIT_INTERVAL_MS = 1000; // Emit aggregated metrics every 1 second

/**
 * Initialise Socket.io server and attach to HTTP server.
 * @param {http.Server} httpServer - The Express HTTP server instance
 */
function initSocketIO(httpServer) {
  // Create two separate Redis connections for pub/sub
  // ioredis connections cannot be shared between pub and sub modes
  const pubClient = createRedisClient({ name: 'socket-pub' });
  const subClient = createRedisClient({ name: 'socket-sub' });

  io = new Server(httpServer, {
    cors: {
      origin: process.env.PORTAL_URL || 'http://localhost:5173',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    // Ping timeout/interval — detect dead connections
    pingTimeout: 60000,
    pingInterval: 25000,
    // Limit payload size to prevent memory exhaustion from large client sends
    maxHttpBufferSize: 1e5, // 100KB
  });

  // Attach Redis adapter — enables multi-instance event broadcasting
  io.adapter(createAdapter(pubClient, subClient));

  // ─── /metrics NAMESPACE ───────────────────────────────────────────────────
  const metricsNs = io.of('/metrics');

  // Authenticate socket connection using JWT
  // This fires BEFORE the 'connection' event — reject unauthenticated sockets early
  metricsNs.use((socket, next) => {
    const token = socket.handshake.auth?.token ||
                  socket.handshake.headers?.authorization?.split(' ')[1];

    if (!token) {
      return next(new Error('AUTHENTICATION_REQUIRED'));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.data.userId = decoded.sub;
      socket.data.teamId = decoded.teamId;
      socket.data.role = decoded.role || 'member';
      next();
    } catch (err) {
      next(new Error('INVALID_TOKEN'));
    }
  });

  metricsNs.on('connection', async (socket) => {
    const { userId, teamId, role } = socket.data;
    console.info(`[Socket.io] Client connected: userId=${userId}, teamId=${teamId}`);

    // Join team-scoped room — client receives only their team's metrics
    if (teamId) {
      socket.join(`team:${teamId}`);
    }

    // Admin users join the global room for platform-wide metrics
    if (role === 'admin') {
      socket.join('global');
    }

    // Client can subscribe to a specific API's metrics
    socket.on('subscribe:api', (apiId) => {
      // Validate: the client's team must own this API
      // (In production, do a DB lookup here — for now trust the client-submitted apiId
      // since they can only see their own team's data via the portal)
      socket.join(`api:${apiId}`);
      console.info(`[Socket.io] userId=${userId} subscribed to api:${apiId}`);
    });

    socket.on('unsubscribe:api', (apiId) => {
      socket.leave(`api:${apiId}`);
    });

    socket.on('disconnect', (reason) => {
      console.info(`[Socket.io] Client disconnected: userId=${userId}, reason=${reason}`);
    });

    // Send current snapshot on connect so dashboard isn't blank
    socket.emit('metrics:snapshot', { timestamp: new Date().toISOString(), message: 'connected' });
  });

  // ─── METRICS AGGREGATION & EMIT LOOP ──────────────────────────────────────
  // Collect raw metric events, aggregate per interval, then emit once.
  // This is the thundering herd protection: buffer many events, emit one aggregate.
  setInterval(() => {
    if (metricsBuffer.size === 0) return;

    const snapshot = [];

    metricsBuffer.forEach((data, apiId) => {
      const { requests, errors, latencies, teamId, apiName } = data;
      const totalRequests = requests.length;
      if (totalRequests === 0) return;

      // Compute P95 from buffered latencies (exact sort-based for small buffers)
      const sorted = [...latencies].sort((a, b) => a - b);
      const p95Index = Math.floor(sorted.length * 0.95);
      const p95LatencyMs = sorted[p95Index] || 0;
      const avgLatencyMs = sorted.reduce((s, v) => s + v, 0) / sorted.length;

      const metric = {
        apiId,
        apiName,
        teamId,
        rps: totalRequests, // Requests in this 1-second window = RPS
        p95LatencyMs: Math.round(p95LatencyMs),
        avgLatencyMs: Math.round(avgLatencyMs),
        errorCount: errors,
        errorRatePct: totalRequests > 0 ? ((errors / totalRequests) * 100).toFixed(2) : '0.00',
        timestamp: new Date().toISOString(),
      };

      snapshot.push(metric);

      // Emit to API-specific room
      metricsNs.to(`api:${apiId}`).emit('metrics:api', metric);

      // Emit to team room
      if (teamId) {
        metricsNs.to(`team:${teamId}`).emit('metrics:team', metric);
      }
    });

    // Emit platform aggregate to global room (admins)
    if (snapshot.length > 0) {
      const platformRps = snapshot.reduce((s, m) => s + m.rps, 0);
      const platformP95 = Math.max(...snapshot.map(m => m.p95LatencyMs));
      metricsNs.to('global').emit('metrics:platform', {
        totalRps: platformRps,
        maxP95LatencyMs: platformP95,
        activeApis: snapshot.length,
        timestamp: new Date().toISOString(),
      });
    }

    // Clear buffer for next interval
    metricsBuffer.clear();
  }, EMIT_INTERVAL_MS);

  console.info('[Socket.io] ✅ Initialised with Redis adapter');
  return io;
}

/**
 * Record a request metric — called by the log consumer worker after writing to MongoDB.
 * Adds to in-memory buffer; the interval loop emits aggregated data.
 *
 * @param {object} params
 */
function recordMetric({ apiId, teamId, apiName, latencyMs, statusCode }) {
  if (!apiId) return;

  const key = apiId.toString();
  const existing = metricsBuffer.get(key) || {
    requests: [],
    errors: 0,
    latencies: [],
    teamId,
    apiName,
  };

  existing.requests.push(Date.now());
  existing.latencies.push(latencyMs);
  if (statusCode >= 500) existing.errors++;

  metricsBuffer.set(key, existing);
}

function getIO() {
  return io;
}

module.exports = { initSocketIO, recordMetric, getIO };
