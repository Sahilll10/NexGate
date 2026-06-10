/**
 * NexGate Gateway — Middleware Stack
 * ════════════════════════════════════════════════════════════════════════════
 *
 * REQUEST LIFECYCLE (order matters — each middleware transforms state):
 *
 *   1. requestId        — Attach UUID to request for tracing
 *   2. startTimer       — Record high-resolution start time
 *   3. extractApiKey    — Extract raw key from header; hash it
 *   4. validateApiKey   — Resolve key doc from cache/DB; validate status
 *   5. checkRateLimit   — Resolve rule; run algorithm; attach headers
 *   6. checkScope       — Verify key has permission for this API + method
 *   7. resolveTarget    — Resolve downstream URL from cache
 *   8. circuitBreaker   — Check if circuit is open for this API
 *   9. proxyRequest     — Forward to downstream; capture upstream response
 *   10. captureMetrics  — Enqueue log (in res.on('finish') — after response)
 */

const { createProxyMiddleware } = require('http-proxy-middleware');
const { v4: uuidv4 } = require('uuid');
const { hashApiKey } = require('../utils/crypto');
const { resolveApiKey, resolveApiConfig, resolveRateLimitRule } = require('../services/cache');
const { checkSlidingWindowLog } = require('../algorithms/slidingWindowLog');
const { checkTokenBucket } = require('../algorithms/tokenBucket');
const { checkFixedWindow } = require('../algorithms/fixedWindow');
const { checkCircuit, recordSuccess, recordFailure } = require('../services/circuitBreaker');
const { enqueueLog, buildLogPayload } = require('../queues/logQueue');
const env = require('../config/env');

// ─── 1. REQUEST ID ────────────────────────────────────────────────────────────
function requestId(req, res, next) {
  req.requestId = uuidv4();
  req._startTime = Date.now();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

// ─── 2. EXTRACT & HASH API KEY ────────────────────────────────────────────────
// WHY THIS HEADER?
// x-nexgate-key is a custom header (not Authorization) because:
// 1. Authorization header is sometimes stripped or rewritten by proxies and load balancers
// 2. A dedicated header makes NexGate keys visually distinct from JWT/Bearer tokens
// 3. Consistent with industry pattern (Stripe uses x-api-key, Twilio uses Authorization
//    but with custom scheme — both are valid; we choose explicit custom header)
//
// ALTERNATIVE CONSIDERED: query param (?api_key=...)
// REJECTED because: query params appear in server logs, CDN access logs, browser history.
//    A secret in a URL is a security antipattern (OWASP API Security Top 10).
//
// The hash happens HERE (not in validateApiKey) because:
// We want to work with hashes exclusively after this point — the raw key string
// should have zero surface area in memory or logs.
function extractApiKey(req, res, next) {
  const rawKey = req.headers[env.API_KEY_HEADER];

  if (!rawKey) {
    return res.status(401).json({
      error: 'MISSING_API_KEY',
      message: `API key required in '${env.API_KEY_HEADER}' header`,
      requestId: req.requestId,
    });
  }

  // Validate format: must start with the prefix
  if (!rawKey.startsWith('nxg_')) {
    return res.status(401).json({
      error: 'INVALID_KEY_FORMAT',
      message: 'API key format is invalid',
      requestId: req.requestId,
    });
  }

  // Hash immediately — never store rawKey on req object
  req._keyHash = hashApiKey(rawKey);
  next();
}

// ─── 3. VALIDATE API KEY ──────────────────────────────────────────────────────
// FIVE FAILURE MODES:
// 1. NOT_FOUND (404→401): Hash not in DB/cache — invalid key
// 2. KEY_REVOKED (401): Key exists but status='revoked'
// 3. KEY_EXPIRED (401): expiresAt has passed
// 4. ROTATION_EXPIRED (401): Key in 'rotating' state, rotationExpiresAt passed
// 5. API_NOT_ALLOWED (403): Key exists but this API is not in allowedApiIds
//    (This 5th check happens in checkScope — both are validation stages)
//
// STATUS CODE DECISION:
// 401 Unauthorized (technically: unauthenticated) = key identity problem
// 403 Forbidden = identity confirmed but not authorized for this resource
async function validateApiKey(req, res, next) {
  try {
    const keyDoc = await resolveApiKey(req._keyHash);

    // Failure 1: key not found
    if (!keyDoc) {
      return res.status(401).json({
        error: 'INVALID_API_KEY',
        message: 'The provided API key is not valid',
        requestId: req.requestId,
      });
    }

    // Failure 2: key revoked
    if (keyDoc.status === 'revoked') {
      return res.status(401).json({
        error: 'KEY_REVOKED',
        message: 'This API key has been revoked',
        requestId: req.requestId,
      });
    }

    // Failure 3: key expired (hard expiry)
    if (keyDoc.expiresAt && new Date(keyDoc.expiresAt) < new Date()) {
      return res.status(401).json({
        error: 'KEY_EXPIRED',
        message: 'This API key has expired',
        requestId: req.requestId,
      });
    }

    // Failure 4: rotation window expired
    if (keyDoc.status === 'rotating') {
      if (!keyDoc.rotationExpiresAt || new Date(keyDoc.rotationExpiresAt) < new Date()) {
        return res.status(401).json({
          error: 'ROTATION_EXPIRED',
          message: 'This key was being rotated, but the rotation window has closed. Please use the new key.',
          requestId: req.requestId,
        });
      }
      // Rotation still in window — allow but flag it
      req._keyIsRotating = true;
    }

    req._keyDoc = keyDoc;
    next();
  } catch (err) {
    console.error('[validateApiKey] Error:', err.message);
    // If both Redis and MongoDB fail — fail-closed (reject the request)
    // A gateway that allows unvalidated requests is a security hole.
    return res.status(503).json({
      error: 'AUTH_SERVICE_UNAVAILABLE',
      message: 'Authentication service temporarily unavailable',
      requestId: req.requestId,
    });
  }
}

// ─── 4. RATE LIMIT CHECK ──────────────────────────────────────────────────────
async function checkRateLimit(req, res, next) {
  const { _keyDoc } = req;
  const apiId = req._resolvedApiId || req.params.apiId;

  try {
    const rule = await resolveRateLimitRule(apiId, _keyDoc.teamId.toString());
    req._rateLimitAlgorithm = rule.algorithm;

    let result;
    const params = {
      apiId: apiId.toString(),
      teamId: _keyDoc.teamId.toString(),
      maxRequests: rule.maxRequests,
      windowMs: rule.windowMs,
    };

    switch (rule.algorithm) {
      case 'sliding_window_log':
        result = await checkSlidingWindowLog(params);
        break;
      case 'token_bucket':
        result = await checkTokenBucket({
          ...params,
          burstCapacity: rule.burstCapacity || rule.maxRequests,
          refillRate: rule.refillRate || (rule.maxRequests / (rule.windowMs / 1000)),
        });
        break;
      case 'fixed_window':
        result = await checkFixedWindow(params);
        break;
      default:
        result = await checkSlidingWindowLog(params);
    }

    // Always set rate limit headers (informational)
    res.setHeader('X-RateLimit-Limit', rule.maxRequests);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Algorithm', result.algorithm);
    res.setHeader('X-RateLimit-Window-Ms', rule.windowMs);

    if (!result.allowed) {
      const retryAfterSeconds = Math.ceil(result.retryAfterMs / 1000);
      res.setHeader('Retry-After', retryAfterSeconds);
      res.setHeader('X-RateLimit-Reset', Date.now() + result.retryAfterMs);

      return res.status(429).json({
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please slow down.',
        retryAfterSeconds,
        algorithm: result.algorithm,
        requestId: req.requestId,
      });
    }

    next();
  } catch (err) {
    // Redis failure — rate limit fail-open policy:
    // ARGUMENT FOR FAIL-OPEN: Redis is statistically more reliable than the upstream APIs.
    //   A Redis blip should not deny legitimate requests.
    //   Temporarily exceeding rate limits is less bad than a full outage.
    // ARGUMENT FOR FAIL-CLOSED: A Redis failure could be caused by an attack that overwhelmed
    //   the rate limiter. Fail-open gives attackers a window.
    //
    // DECISION: FAIL-OPEN with monitoring. Log the Redis failure, alert operations,
    //   proceed with the request. The alternative (complete outage during Redis blip) is worse.
    console.warn('[RateLimit] Redis unavailable — failing open:', err.message);
    req._rateLimitSkipped = true;
    next();
  }
}

// ─── 5. SCOPE & PERMISSION CHECK ──────────────────────────────────────────────
// The allowedApiIds list is stored ON the key document (resolved in Step 3 from cache).
// NOT fetched fresh: the cache TTL (120s) is acceptable for permission changes.
// Administrators are expected to rotate keys when permissions change significantly.
// This avoids a MongoDB round-trip on every request for scope checking.
function checkScope(req, res, next) {
  const { _keyDoc } = req;
  const apiId = req._resolvedApiId;

  // Check API access (key must be authorized to call this API)
  if (_keyDoc.allowedApiIds && _keyDoc.allowedApiIds.length > 0) {
    const allowed = _keyDoc.allowedApiIds.some(
      id => id.toString() === apiId.toString()
    );
    if (!allowed) {
      return res.status(403).json({
        error: 'API_ACCESS_DENIED',
        message: 'This API key is not authorized to access this API',
        requestId: req.requestId,
      });
    }
  }

  // Check HTTP method scope
  const method = req.method.toUpperCase();
  const scopes = _keyDoc.scopes || ['read'];
  const hasAdminScope = scopes.includes('admin');
  const hasWriteScope = scopes.includes('write') || hasAdminScope;
  const hasReadScope = scopes.includes('read') || hasWriteScope;

  const methodRequirements = {
    GET: hasReadScope,
    HEAD: hasReadScope,
    OPTIONS: hasReadScope,
    POST: hasWriteScope,
    PUT: hasWriteScope,
    PATCH: hasWriteScope,
    DELETE: hasAdminScope,
  };

  if (!methodRequirements[method]) {
    return res.status(403).json({
      error: 'INSUFFICIENT_SCOPE',
      message: `Your API key scope does not permit ${method} requests`,
      requiredScope: ['POST', 'PUT', 'PATCH'].includes(method) ? 'write' : 'admin',
      requestId: req.requestId,
    });
  }

  next();
}

// ─── 6. RESOLVE TARGET & CIRCUIT BREAKER ──────────────────────────────────────
async function resolveAndCheck(req, res, next) {
  const apiId = req._resolvedApiId;

  try {
    const apiDoc = await resolveApiConfig(apiId);
    if (!apiDoc || !apiDoc.isActive) {
      return res.status(404).json({ error: 'API_NOT_FOUND', requestId: req.requestId });
    }

    req._apiDoc = apiDoc;
    req._proxyTargetUrl = apiDoc.targetBaseUrl;

    // Circuit breaker check
    const circuit = await checkCircuit(apiId);
    if (!circuit.allowed) {
      req._isCircuitBreakerTrip = true;
      const retryAfterSeconds = Math.ceil((circuit.retryAfterMs || 30000) / 1000);
      res.setHeader('Retry-After', retryAfterSeconds);
      return res.status(503).json({
        error: 'CIRCUIT_OPEN',
        message: 'Upstream service is temporarily unavailable. Circuit breaker is open.',
        retryAfterSeconds,
        requestId: req.requestId,
      });
    }

    next();
  } catch (err) {
    console.error('[resolveAndCheck]', err.message);
    next(err);
  }
}

// ─── 7. CAPTURE METRICS (POST-RESPONSE) ──────────────────────────────────────
// Uses res.on('finish') — fires AFTER the response has been completely flushed.
// This is NOT a middleware in the traditional sense — it hooks the response lifecycle.
// The actual BullMQ enqueue happens here, AFTER res.send() completes.
// Node.js guarantees: 'finish' fires in the Check/Close callback phase, after
// the response bytes are handed to the OS TCP stack.
function captureMetrics(req, res, next) {
  const startTime = req._startTime;

  res.on('finish', () => {
    // Skip logging for health checks (avoid polluting logs)
    if (req.path === '/health' || req.path === '/_healthz') return;

    const logPayload = buildLogPayload(req, res, {
      apiDoc: req._apiDoc,
      keyDoc: req._keyDoc,
      startTime,
    });

    // Fire-and-forget — never await in a 'finish' callback
    enqueueLog(logPayload).catch(err => {
      console.error('[captureMetrics] enqueue failed:', err.message);
    });
  });

  next();
}

// ─── 8. PROXY FACTORY ─────────────────────────────────────────────────────────
// Creates a dynamic proxy middleware that reads the target URL from req._apiDoc.
// http-proxy-middleware handles:
//   - 500 errors: upstream responds with 5xx — proxied as-is, recordFailure called
//   - Timeout: connection established but no response within timeoutMs — 504 returned
//   - Connection refused: no connection to upstream — 502 returned
// Each failure mode is distinct — they indicate different problems:
//   500: upstream is running but broken internally
//   timeout: upstream is running but slow (backpressure, GC pause, etc.)
//   connection refused: upstream is down completely
function createProxyHandler() {
  return (req, res, next) => {
    const target = req._proxyTargetUrl;
    const apiId = req._resolvedApiId;
    const timeoutMs = req._apiDoc?.timeoutMs || 30000;

    if (!target) {
      return res.status(502).json({ error: 'NO_TARGET_CONFIGURED', requestId: req.requestId });
    }

    const proxy = createProxyMiddleware({
      target,
      changeOrigin: true,
      timeout: timeoutMs,
      proxyTimeout: timeoutMs,
      // Remove the gateway's API key header before forwarding to upstream
      // (upstream should not receive NexGate keys — they have their own auth)
      on: {
        proxyReq: (proxyReq, req) => {
          if (req._apiDoc?.stripApiKeyHeader) {
            proxyReq.removeHeader(env.API_KEY_HEADER);
          }
          // Forward tracing header
          proxyReq.setHeader('X-Gateway-Request-Id', req.requestId);
          proxyReq.setHeader('X-Gateway-Team', req._keyDoc?.teamId?.toString() || '');
        },
        proxyRes: (proxyRes, req) => {
          const statusCode = proxyRes.statusCode;
          if (statusCode >= 500) {
            recordFailure(apiId).catch(() => {});
          } else {
            recordSuccess(apiId).catch(() => {});
          }
        },
        error: (err, req, res) => {
          recordFailure(apiId).catch(() => {});

          let statusCode = 502;
          let errorCode = 'UPSTREAM_ERROR';

          if (err.code === 'ECONNREFUSED') {
            statusCode = 502;
            errorCode = 'UPSTREAM_CONNECTION_REFUSED';
          } else if (err.code === 'ETIMEDOUT' || err.message?.includes('timeout')) {
            statusCode = 504;
            errorCode = 'UPSTREAM_TIMEOUT';
            req._isUpstreamTimeout = true;
          }

          if (!res.headersSent) {
            res.status(statusCode).json({
              error: errorCode,
              message: 'Upstream service error',
              requestId: req.requestId,
            });
          }
        },
      },
    });

    proxy(req, res, next);
  };
}

module.exports = {
  requestId,
  extractApiKey,
  validateApiKey,
  checkRateLimit,
  checkScope,
  resolveAndCheck,
  captureMetrics,
  createProxyHandler,
};
