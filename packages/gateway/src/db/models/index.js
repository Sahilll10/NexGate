/**
 * NexGate — All MongoDB Models (8 Collections)
 * =============================================
 * Each collection is separate (not embedded) for these reasons:
 *  - teams: root aggregate, never embedded — other collections reference it
 *  - apis: queried independently, many-to-many with teams via ownership
 *  - api_keys: high-cardinality, independently revocable, separate TTL concerns
 *  - rate_limit_rules: separately updatable without touching api or key documents
 *  - request_logs: write-optimised, time-series, cannot be embedded anywhere
 *  - sla_definitions: config-like, updated rarely, independently versioned
 *  - cost_models: pricing data, independently updatable (effectiveFrom matters)
 *  - alerts: event log, append-only, needs independent querying and TTL
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

// ─── 1. TEAMS ────────────────────────────────────────────────────────────────
const teamSchema = new Schema({
  name: { type: String, required: true, unique: true, trim: true },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  description: { type: String, default: '' },
  email: { type: String, required: true },
  // Monthly budget in USD cents (integer avoids floating point issues)
  monthlyBudgetCents: { type: Number, default: 0 },
  // Alert threshold as a percentage (0–100). Alert fires at this % of budget.
  budgetAlertThresholdPct: { type: Number, default: 80 },
  isActive: { type: Boolean, default: true },
  metadata: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true });

// Compound index: slug lookup is the primary key for team identification
teamSchema.index({ slug: 1 }, { unique: true });
teamSchema.index({ isActive: 1 });

// ─── 2. APIS ─────────────────────────────────────────────────────────────────
const apiSchema = new Schema({
  // Human-readable identity
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  version: { type: String, required: true, default: 'v1' },
  tags: [{ type: String, lowercase: true, trim: true }],

  // Ownership
  ownerTeamId: { type: Schema.Types.ObjectId, ref: 'Team', required: true, index: true },

  // Routing — the downstream target. This is cached in Redis on the hot path.
  targetBaseUrl: { type: String, required: true },
  // Path rewrite rules: { from: '/api/v1', to: '' }
  pathRewrite: { type: Schema.Types.Mixed, default: {} },

  // Gateway config
  isActive: { type: Boolean, default: true },
  isPublic: { type: Boolean, default: false }, // Whether it appears in public catalogue
  timeoutMs: { type: Number, default: 30000 },
  stripApiKeyHeader: { type: Boolean, default: true },

  // Default rate limit (can be overridden per team in rate_limit_rules)
  defaultRateLimitRuleId: { type: Schema.Types.ObjectId, ref: 'RateLimitRule' },
}, { timestamps: true });

// Full-text search index on name, description, and tags
// MongoDB $text index — supports stemming and stop-word removal
// Limitation vs Elasticsearch: no fuzzy matching, no relevance scoring, English-only stemming
// Acceptable for internal catalogue with ~100–1000 APIs
apiSchema.index({ name: 'text', description: 'text', tags: 'text' }, { weights: { name: 10, tags: 5, description: 1 } });
apiSchema.index({ ownerTeamId: 1, isActive: 1 });
apiSchema.index({ isPublic: 1, isActive: 1 });

// ─── 3. API KEYS ──────────────────────────────────────────────────────────────
const apiKeySchema = new Schema({
  // Display name (never the actual key — that is never stored)
  name: { type: String, required: true, trim: true },
  keyPrefix: { type: String, required: true }, // e.g. "nxg_" — for operational identification

  // The SHA-256 hash of the raw key. The raw key is NEVER stored.
  // SHA-256 is used (not bcrypt) because: API keys are 256-bit random tokens (high entropy).
  // bcrypt is for low-entropy human passwords (adds salt+cost to defeat brute force).
  // A 256-bit random key has 2^256 possibilities — brute force is computationally impossible.
  // SHA-256 is deterministic (critical for O(1) lookup) and orders of magnitude faster.
  keyHash: { type: String, required: true, unique: true, index: true },

  // Ownership
  teamId: { type: Schema.Types.ObjectId, ref: 'Team', required: true, index: true },
  createdBy: { type: String, required: true }, // User who created it

  // Permissions — list of API IDs this key is allowed to call
  allowedApiIds: [{ type: Schema.Types.ObjectId, ref: 'Api' }],

  // Scopes: granular permissions per key
  // 'read': GET-only access
  // 'write': GET + POST + PUT + PATCH
  // 'admin': full access including DELETE
  scopes: [{ type: String, enum: ['read', 'write', 'admin'] }],

  // Lifecycle
  status: {
    type: String,
    enum: ['active', 'rotating', 'revoked'],
    default: 'active',
    index: true
  },
  // During rotation, both old and new key are valid until rotationExpiresAt
  rotationExpiresAt: { type: Date },
  // Hard expiry — key stops working regardless of status
  expiresAt: { type: Date, index: true },

  // Metadata for audit
  lastUsedAt: { type: Date },
  requestCount: { type: Number, default: 0 },
  metadata: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true });

apiKeySchema.index({ keyHash: 1 }, { unique: true });
apiKeySchema.index({ teamId: 1, status: 1 });
apiKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL: auto-delete expired keys

// ─── 4. RATE LIMIT RULES ─────────────────────────────────────────────────────
const rateLimitRuleSchema = new Schema({
  name: { type: String, required: true },
  description: { type: String, default: '' },

  // Scope: 'global' applies to all teams calling this API.
  // 'team' is a team-specific override (higher priority than global).
  scope: { type: String, enum: ['global', 'team'], default: 'global' },
  apiId: { type: Schema.Types.ObjectId, ref: 'Api', index: true },
  teamId: { type: Schema.Types.ObjectId, ref: 'Team', index: true }, // null for global rules

  // Algorithm selection
  algorithm: {
    type: String,
    enum: ['sliding_window_log', 'token_bucket', 'fixed_window'],
    required: true
  },

  // Common parameters
  windowMs: { type: Number, required: true }, // Time window in milliseconds
  maxRequests: { type: Number, required: true }, // Max requests per window

  // Token Bucket specific — refill rate (tokens per second)
  refillRate: { type: Number },
  // Token Bucket burst capacity (max tokens bucket can hold)
  burstCapacity: { type: Number },

  isActive: { type: Boolean, default: true },
}, { timestamps: true });

// Rule resolution: for a given (apiId, teamId) pair, find the most specific rule.
// Team-specific rules take priority over global rules.
rateLimitRuleSchema.index({ apiId: 1, teamId: 1, scope: 1, isActive: 1 });

// ─── 5. REQUEST LOGS ─────────────────────────────────────────────────────────
// CRITICAL DESIGN DECISIONS:
// 1. Use MongoDB time-series collection (see init-db.js) — not a regular collection.
//    Time-series collections compress time-series data significantly (5–10x compression)
//    and are optimised for time-range queries.
// 2. teamId is DENORMALIZED here. At 1000 RPS, a $lookup against api_keys on every
//    analytics query would require joining 86.4M docs/day. Denormalisation makes
//    team-level aggregations a single-collection scan (uses teamId index).
// 3. All billing-relevant fields are captured at request time (denormalized cost per request)
//    so the cost aggregator does not need to join with cost_models on every row.
const requestLogSchema = new Schema({
  // Time field — required for time-series collection (the "timeField")
  timestamp: { type: Date, required: true, default: Date.now },

  // Meta field — required for time-series collection (the "metaField")
  // Groups related time-series data for compression
  meta: {
    apiId: { type: Schema.Types.ObjectId, required: true },
    teamId: { type: Schema.Types.ObjectId, required: true },
    keyId: { type: Schema.Types.ObjectId, required: true },
  },

  // Request identity
  requestId: { type: String, required: true }, // UUID — idempotency for log consumers
  method: { type: String, required: true },
  path: { type: String, required: true },
  targetUrl: { type: String },

  // Response data
  statusCode: { type: Number, required: true },
  latencyMs: { type: Number, required: true },
  requestSizeBytes: { type: Number, default: 0 },
  responseSizeBytes: { type: Number, default: 0 },

  // Denormalized for analytics without joins
  teamSlug: { type: String, required: true },
  apiName: { type: String, required: true },

  // Rate limiting outcome
  rateLimitAlgorithm: { type: String },
  wasRateLimited: { type: Boolean, default: false },

  // Cost: denormalized from cost_models at request time (cents per 1000 requests)
  // This is the cost unit charge for this specific request
  costCentsPerRequest: { type: Number, default: 0 },

  // Error information
  errorCode: { type: String },
  isCircuitBreakerTrip: { type: Boolean, default: false },
  isUpstreamTimeout: { type: Boolean, default: false },
}, {
  // Do NOT use mongoose schema timestamps — we manage `timestamp` ourselves
  // because it is the time-series timeField
  timestamps: false,
});

// TTL index: auto-delete logs older than 30 days
// This keeps the time-series collection from unboundedly growing on M0 free tier
// (512 MB storage limit — 30-day TTL at 1000 RPS is still ~260GB theoretical,
// so the TTL must be combined with Atlas tier selection or reduced volume)
requestLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
requestLogSchema.index({ 'meta.teamId': 1, timestamp: -1 });
requestLogSchema.index({ 'meta.apiId': 1, timestamp: -1 });
requestLogSchema.index({ statusCode: 1, timestamp: -1 });

// ─── 6. SLA DEFINITIONS ──────────────────────────────────────────────────────
const slaDefinitionSchema = new Schema({
  name: { type: String, required: true },
  apiId: { type: Schema.Types.ObjectId, ref: 'Api', required: true, index: true },
  teamId: { type: Schema.Types.ObjectId, ref: 'Team', index: true }, // null = applies to all teams

  // SLA targets
  maxP95LatencyMs: { type: Number, required: true, default: 500 },
  maxErrorRatePct: { type: Number, required: true, default: 1 }, // % of 5xx responses
  minUptimePct: { type: Number, required: true, default: 99.9 },

  // Alert thresholds: alert fires when metric reaches this % of the SLA limit
  // e.g., alertThresholdPct=90 + maxP95LatencyMs=500 → pre-breach alert at 450ms
  alertThresholdPct: { type: Number, default: 90 },

  isActive: { type: Boolean, default: true },

  // Current SLA status (updated by SLA monitor worker every 5 minutes)
  currentStatus: {
    type: String,
    enum: ['ok', 'pre_breach', 'breach', 'unknown'],
    default: 'unknown'
  },
  lastEvaluatedAt: { type: Date },
  lastP95LatencyMs: { type: Number },
  lastErrorRatePct: { type: Number },
}, { timestamps: true });

slaDefinitionSchema.index({ apiId: 1, teamId: 1 });

// ─── 7. COST MODELS ──────────────────────────────────────────────────────────
const costModelSchema = new Schema({
  name: { type: String, required: true },
  apiId: { type: Schema.Types.ObjectId, ref: 'Api', index: true }, // null = default model

  // Pricing in cents per 1000 requests (integer avoids float errors)
  centsPerThousandRequests: { type: Number, required: true, default: 0 },

  // When this pricing model took effect — critical for mid-month pricing changes.
  // The cost aggregator applies one rate for days before this date,
  // and this rate for days on or after this date.
  effectiveFrom: { type: Date, required: true },
  effectiveTo: { type: Date }, // null = currently active

  isActive: { type: Boolean, default: true },
}, { timestamps: true });

// Query pattern: find the active cost model for an API at a given date
costModelSchema.index({ apiId: 1, effectiveFrom: -1, isActive: 1 });

// ─── 8. ALERTS ───────────────────────────────────────────────────────────────
const alertSchema = new Schema({
  type: {
    type: String,
    enum: ['RATE_LIMIT_BREACH', 'SLA_PRE_BREACH', 'SLA_BREACH', 'BUDGET_PRE_BREACH', 'BUDGET_BREACH', 'CIRCUIT_OPEN'],
    required: true,
    index: true
  },
  severity: { type: String, enum: ['info', 'warning', 'critical'], required: true },
  status: { type: String, enum: ['open', 'acknowledged', 'resolved'], default: 'open', index: true },

  // Context
  teamId: { type: Schema.Types.ObjectId, ref: 'Team', index: true },
  apiId: { type: Schema.Types.ObjectId, ref: 'Api', index: true },

  message: { type: String, required: true },
  details: { type: Schema.Types.Mixed, default: {} },

  // Deduplication: prevents alert flooding.
  // If an alert with the same dedupKey already exists and is 'open', no new alert is created.
  dedupKey: { type: String, index: true },

  // Resolution tracking
  acknowledgedAt: { type: Date },
  resolvedAt: { type: Date },
  resolvedBy: { type: String },
}, { timestamps: true });

// TTL: auto-delete resolved alerts after 90 days
alertSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
alertSchema.index({ dedupKey: 1, status: 1 });
alertSchema.index({ teamId: 1, status: 1, createdAt: -1 });

// ─── COST REPORTS ─────────────────────────────────────────────────────────────
const costReportSchema = new Schema({
  teamId: { type: Schema.Types.ObjectId, ref: 'Team', required: true, index: true },
  teamSlug: { type: String, required: true }, // Denormalized for display
  month: { type: String, required: true }, // 'YYYY-MM' format
  year: { type: Number, required: true },

  // Aggregated cost breakdown
  totalCentsMtd: { type: Number, default: 0 }, // Month-to-date total
  totalRequestsMtd: { type: Number, default: 0 },
  apiBreakdown: [{
    apiId: { type: Schema.Types.ObjectId, ref: 'Api' },
    apiName: { type: String },
    requestCount: { type: Number },
    totalCents: { type: Number },
  }],

  // Budget comparison
  budgetCents: { type: Number, default: 0 },
  budgetUtilizationPct: { type: Number, default: 0 },

  // Distributed lock key — used to prevent duplicate aggregation runs
  aggregationLockKey: { type: String },
  lastAggregatedAt: { type: Date },
}, { timestamps: true });

costReportSchema.index({ teamId: 1, month: 1 }, { unique: true });

// ─── MODEL EXPORTS ────────────────────────────────────────────────────────────
const Team = mongoose.model('Team', teamSchema);
const Api = mongoose.model('Api', apiSchema);
const ApiKey = mongoose.model('ApiKey', apiKeySchema);
const RateLimitRule = mongoose.model('RateLimitRule', rateLimitRuleSchema);
const RequestLog = mongoose.model('RequestLog', requestLogSchema);
const SlaDefinition = mongoose.model('SlaDefinition', slaDefinitionSchema);
const CostModel = mongoose.model('CostModel', costModelSchema);
const Alert = mongoose.model('Alert', alertSchema);
const CostReport = mongoose.model('CostReport', costReportSchema);

module.exports = {
  Team,
  Api,
  ApiKey,
  RateLimitRule,
  RequestLog,
  SlaDefinition,
  CostModel,
  Alert,
  CostReport,
};
