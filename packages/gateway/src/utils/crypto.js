/**
 * NexGate — Cryptographic Utilities
 *
 * API KEY DESIGN PHILOSOPHY:
 * ─────────────────────────────────────────────────────────────────────────────
 * Raw key format: nxg_<32-bytes-hex>
 *   - "nxg_" prefix: 4 chars, operationally useful (grep logs, identify source)
 *   - 32 random bytes = 256 bits of entropy from crypto.randomBytes()
 *   - crypto.randomBytes() uses the OS CSPRNG (e.g., /dev/urandom on Linux)
 *   - 2^256 possible keys — brute force is computationally infeasible
 *
 * WHY SHA-256 NOT bcrypt?
 * ─────────────────────────────────────────────────────────────────────────────
 * bcrypt is designed for low-entropy secrets (human passwords: ~40 bits entropy).
 * Its cost factor (rounds) is intentionally slow to defeat offline brute-force
 * dictionary attacks. But bcrypt is:
 *   1. Non-deterministic (salt is random) — output changes per hash. A deterministic
 *      lookup (hash → DB record) is impossible without storing the hash as the key.
 *      Actually bcrypt IS deterministic given the same salt, but the point is:
 *      we need to hash the incoming key and look it up in O(1). bcrypt hashes
 *      include the salt in the output string — so we'd store the bcrypt hash and
 *      compare with bcrypt.compare(). This adds ~100-300ms per request on the hot path.
 *   2. Slow by design (~100ms at cost=12) — this latency on every gateway request
 *      is unacceptable.
 *
 * SHA-256 for API keys (high-entropy tokens):
 *   - Fast: ~1 microsecond per hash — negligible on the hot path
 *   - Deterministic: hash(key) always produces the same digest → direct lookup
 *   - No salt needed: 256-bit random key has 2^256 search space. A rainbow table
 *     attack is computationally impossible (universe has ~10^80 atoms; 2^256 ≈ 10^77).
 *     Salt only matters when the secret is low-entropy (like a password).
 *
 * REAL-WORLD PRECEDENT:
 * GitHub uses HMAC-SHA256 to hash personal access tokens before storage.
 * Stripe uses SHA-256 for API key hashing.
 * Both expose a prefix for identification (gh_, sk_live_) — same as our "nxg_" prefix.
 *
 * WHY A PREFIX MATTERS:
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Secret scanning: GitHub's secret scanning partner program scans all public repos
 *    for patterns like "sk_live_", "nxg_". A prefix makes accidental exposure detectable.
 * 2. Grep / log analysis: "which logs contain this leaked key?" → grep for "nxg_"
 *    in logs (redacted logs should never log full keys — but the prefix aids triage).
 * 3. User recognition: Users know "nxg_abc..." is a NexGate key. Reduces support tickets.
 */

const crypto = require('crypto');

const KEY_PREFIX = 'nxg_';
const KEY_BYTES = 32; // 256 bits

/**
 * Generate a new cryptographically secure API key.
 * Returns the raw key (shown to user ONCE) and its SHA-256 hash (stored in DB).
 *
 * @returns {{ rawKey: string, keyHash: string, keyPrefix: string }}
 */
function generateApiKey() {
  const randomBytes = crypto.randomBytes(KEY_BYTES);
  const rawKey = `${KEY_PREFIX}${randomBytes.toString('hex')}`;
  const keyHash = hashApiKey(rawKey);
  return { rawKey, keyHash, keyPrefix: KEY_PREFIX };
}

/**
 * Hash an API key using SHA-256.
 * This is the only hash function used — bcrypt is NOT used for keys (see above).
 *
 * @param {string} rawKey - The raw API key (e.g., "nxg_abc123...")
 * @returns {string} - Hex-encoded SHA-256 digest
 */
function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Generate a cryptographically secure random token.
 * Used for: JWT secrets, refresh tokens, rotation tokens.
 *
 * @param {number} bytes - Number of random bytes (default 32)
 * @returns {string} - Hex-encoded token
 */
function generateSecureToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Regular string comparison (===) leaks information via timing:
 * it exits early on the first mismatch. An attacker can measure response time
 * to determine how many leading characters of their guess match the secret.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still do a comparison to avoid short-circuit timing leak on length
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { generateApiKey, hashApiKey, generateSecureToken, timingSafeEqual };
