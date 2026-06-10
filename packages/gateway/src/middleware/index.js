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

const proxyInstances = new Map();

function requestId(req, res, next) {
  req.requestId = uuidv4();
  req._startTime = Date.now();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

function extractApiKey(req, res, next) {
  const rawKey = req.headers[env.API_KEY_HEADER];
  if (!rawKey) return res.status(401).json({ error: 'MISSING_API_KEY', message: `API key required in '${env.API_KEY_HEADER}' header`, requestId: req.requestId });
  if (!rawKey.startsWith('nxg_')) return res.status(401).json({ error: 'INVALID_KEY_FORMAT', message: 'API key format is invalid', requestId: req.requestId });
  req._keyHash = hashApiKey(rawKey);
  next();
}

async function validateApiKey(req, res, next) {
  try {
    const keyDoc = await resolveApiKey(req._keyHash);
    if (!keyDoc) return res.status(401).json({ error: 'INVALID_API_KEY', message: 'The provided API key is not valid', requestId: req.requestId });
    if (keyDoc.status === 'revoked') return res.status(401).json({ error: 'KEY_REVOKED', message: 'This API key has been revoked', requestId: req.requestId });
    if (keyDoc.expiresAt && new Date(keyDoc.expiresAt) < new Date()) return res.status(401).json({ error: 'KEY_EXPIRED', message: 'This API key has expired', requestId: req.requestId });
    req._keyDoc = keyDoc;
    next();
  } catch (err) {
    return res.status(503).json({ error: 'AUTH_SERVICE_UNAVAILABLE', message: 'Authentication service temporarily unavailable', requestId: req.requestId });
  }
}

async function checkRateLimit(req, res, next) {
  const { _keyDoc } = req;
  const apiId = req._resolvedApiId || req.params.apiId;

  try {
    const rule = await resolveRateLimitRule(apiId, _keyDoc.teamId.toString());
    req._rateLimitAlgorithm = rule.algorithm;

    console.log(`\n[RateLimit Debug] Loaded Rule for API ${apiId}:`, JSON.stringify(rule));

    let result;
    const params = { apiId: apiId.toString(), teamId: _keyDoc.teamId.toString(), maxRequests: rule.maxRequests, windowMs: rule.windowMs };

    switch (rule.algorithm) {
      case 'sliding_window_log': result = await checkSlidingWindowLog(params); break;
      case 'token_bucket': result = await checkTokenBucket({ ...params, burstCapacity: rule.burstCapacity || rule.maxRequests, refillRate: rule.refillRate || (rule.maxRequests / (rule.windowMs / 1000)) }); break;
      case 'fixed_window': result = await checkFixedWindow(params); break;
      default: result = await checkSlidingWindowLog(params);
    }

    console.log(`[RateLimit Debug] Algorithm Result:`, JSON.stringify(result));

    if (!result.allowed) {
      return res.status(429).json({ error: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests.', requestId: req.requestId });
    }
    next();
  } catch (err) {
    console.error('[RateLimit] CRITICAL ERROR:', err.message);
    return res.status(503).json({ error: 'RATE_LIMIT_SERVICE_UNAVAILABLE', message: 'Rate limiter unreachable', requestId: req.requestId });
  }
}

function checkScope(req, res, next) {
  const { _keyDoc } = req;
  const apiId = req._resolvedApiId;
  if (_keyDoc.allowedApiIds && _keyDoc.allowedApiIds.length > 0) {
    if (!_keyDoc.allowedApiIds.some(id => id.toString() === apiId.toString())) {
      return res.status(403).json({ error: 'API_ACCESS_DENIED', requestId: req.requestId });
    }
  }
  next();
}

async function resolveAndCheck(req, res, next) {
  const apiId = req._resolvedApiId;
  try {
    const apiDoc = await resolveApiConfig(apiId);
    if (!apiDoc || !apiDoc.isActive) return res.status(404).json({ error: 'API_NOT_FOUND', requestId: req.requestId });
    req._apiDoc = apiDoc;
    req._proxyTargetUrl = apiDoc.targetUrl || apiDoc.targetBaseUrl; 
    const circuit = await checkCircuit(apiId);
    if (!circuit.allowed) return res.status(503).json({ error: 'CIRCUIT_OPEN', message: 'Circuit breaker is open.', requestId: req.requestId });
    next();
  } catch (err) { next(err); }
}

function captureMetrics(req, res, next) {
  const startTime = req._startTime;
  res.on('finish', () => {
    if (req.path === '/health') return;
    enqueueLog(buildLogPayload(req, res, { apiDoc: req._apiDoc, keyDoc: req._keyDoc, startTime })).catch(console.error);
  });
  next();
}

function createProxyHandler() {
  return (req, res, next) => {
    const apiId = req._resolvedApiId;
    if (!proxyInstances.has(apiId)) {
      proxyInstances.set(apiId, createProxyMiddleware({
        target: req._proxyTargetUrl,
        changeOrigin: true,
        on: {
          proxyRes: (proxyRes) => (proxyRes.statusCode >= 500 ? recordFailure(apiId) : recordSuccess(apiId)),
          error: (err, req, res) => { recordFailure(apiId); res.status(502).json({ error: 'UPSTREAM_ERROR' }); }
        }
      }));
    }
    proxyInstances.get(apiId)(req, res, next);
  };
}

module.exports = { requestId, extractApiKey, validateApiKey, checkRateLimit, checkScope, resolveAndCheck, captureMetrics, createProxyHandler };