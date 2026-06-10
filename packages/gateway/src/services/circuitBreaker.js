/**
 * NexGate — Circuit Breaker
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The circuit breaker prevents the gateway from hammering a failing upstream
 * service, giving it time to recover. Without a circuit breaker:
 *   - A failing upstream returns 5xx or timeouts
 *   - The gateway keeps forwarding requests to it
 *   - Gateway threads (connection pool) fill up waiting for timeouts
 *   - Gateway itself becomes slow or unresponsive (cascading failure)
 *
 * STATE MACHINE (per upstream):
 *   CLOSED (normal) → OPEN (failing) → HALF-OPEN (testing recovery) → CLOSED
 *
 *   CLOSED: All requests forwarded. Failure counter increments on 5xx/timeout.
 *     Transition to OPEN: when failureCount >= threshold in last windowMs.
 *
 *   OPEN: All requests immediately rejected with 503. No requests forwarded.
 *     Transition to HALF-OPEN: after timeoutMs (e.g., 30 seconds).
 *
 *   HALF-OPEN: Allow a limited number of probe requests through.
 *     If probe succeeds → CLOSED (reset failure counter).
 *     If probe fails → back to OPEN (reset timer).
 *
 * STORAGE: Redis Hash per API (apiId)
 *   nexgate:cb:{apiId} → { state, failureCount, lastFailureAt, halfOpenRequests }
 *
 * WHY REDIS (not in-memory)?
 * Same multi-instance problem as rate limiting. If one gateway instance opens
 * the circuit but others don't know, they continue forwarding to the dead upstream.
 * Redis ensures all instances share circuit state.
 *
 * TTL: 24 hours (circuit state auto-resets if API is not called for a long time)
 */

const { getRedisClient } = require('../db/redis');
const env = require('../config/env');

const STATES = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' };

async function getCircuitState(apiId) {
  const redis = getRedisClient();
  const data = await redis.hgetall(`nexgate:cb:${apiId}`);
  if (!data || !data.state) {
    return { state: STATES.CLOSED, failureCount: 0, lastFailureAt: null, halfOpenRequests: 0 };
  }
  return {
    state: data.state,
    failureCount: parseInt(data.failureCount || '0', 10),
    lastFailureAt: data.lastFailureAt ? parseInt(data.lastFailureAt, 10) : null,
    halfOpenRequests: parseInt(data.halfOpenRequests || '0', 10),
  };
}

async function setCircuitState(apiId, stateData) {
  const redis = getRedisClient();
  const key = `nexgate:cb:${apiId}`;
  await redis.hmset(key, {
    state: stateData.state,
    failureCount: stateData.failureCount.toString(),
    lastFailureAt: stateData.lastFailureAt ? stateData.lastFailureAt.toString() : '',
    halfOpenRequests: (stateData.halfOpenRequests || 0).toString(),
  });
  await redis.expire(key, 86400); // 24hr TTL
}

/**
 * Check if a request should be allowed through the circuit breaker.
 * Returns: { allowed: boolean, state: string }
 */
async function checkCircuit(apiId) {
  const circuit = await getCircuitState(apiId);

  if (circuit.state === STATES.CLOSED) {
    return { allowed: true, state: STATES.CLOSED };
  }

  if (circuit.state === STATES.OPEN) {
    const now = Date.now();
    const elapsed = now - (circuit.lastFailureAt || 0);

    if (elapsed >= env.CIRCUIT_BREAKER_TIMEOUT) {
      // Transition to HALF_OPEN — allow limited probe requests
      await setCircuitState(apiId, { ...circuit, state: STATES.HALF_OPEN, halfOpenRequests: 0 });
      return { allowed: true, state: STATES.HALF_OPEN };
    }

    // Still open — reject immediately
    return { allowed: false, state: STATES.OPEN, retryAfterMs: env.CIRCUIT_BREAKER_TIMEOUT - elapsed };
  }

  if (circuit.state === STATES.HALF_OPEN) {
    if (circuit.halfOpenRequests < env.CIRCUIT_BREAKER_HALF_OPEN_REQUESTS) {
      await setCircuitState(apiId, { ...circuit, halfOpenRequests: circuit.halfOpenRequests + 1 });
      return { allowed: true, state: STATES.HALF_OPEN };
    }
    return { allowed: false, state: STATES.OPEN };
  }

  return { allowed: true, state: STATES.CLOSED };
}

/**
 * Record a successful upstream response.
 * Resets the circuit to CLOSED if it was HALF_OPEN.
 */
async function recordSuccess(apiId) {
  const circuit = await getCircuitState(apiId);
  if (circuit.state !== STATES.CLOSED) {
    await setCircuitState(apiId, {
      state: STATES.CLOSED,
      failureCount: 0,
      lastFailureAt: null,
      halfOpenRequests: 0,
    });
    console.info(`[CircuitBreaker] API ${apiId} circuit CLOSED (recovered)`);
  }
}

/**
 * Record a failed upstream response (5xx, timeout, connection refused).
 * May transition from CLOSED → OPEN.
 */
async function recordFailure(apiId) {
  const circuit = await getCircuitState(apiId);
  const now = Date.now();
  const newFailureCount = circuit.failureCount + 1;

  if (circuit.state === STATES.HALF_OPEN) {
    // Probe failed — reopen circuit
    await setCircuitState(apiId, {
      state: STATES.OPEN,
      failureCount: newFailureCount,
      lastFailureAt: now,
      halfOpenRequests: 0,
    });
    console.warn(`[CircuitBreaker] API ${apiId} circuit REOPENED (probe failed)`);
    return;
  }

  if (newFailureCount >= env.CIRCUIT_BREAKER_THRESHOLD) {
    await setCircuitState(apiId, {
      state: STATES.OPEN,
      failureCount: newFailureCount,
      lastFailureAt: now,
      halfOpenRequests: 0,
    });
    console.warn(`[CircuitBreaker] API ${apiId} circuit OPENED (${newFailureCount} failures)`);
  } else {
    await setCircuitState(apiId, { ...circuit, failureCount: newFailureCount, lastFailureAt: now });
  }
}

module.exports = { checkCircuit, recordSuccess, recordFailure, STATES };
