/**
 * NexGate — Seed Script
 * ════════════════════════════════════════════════════════════════════════════
 * Populates the database with realistic demo data for development/testing.
 * Run: node scripts/seed.js
 *
 * Creates:
 *  - 3 teams (Payments, Analytics, Platform)
 *  - 6 APIs (2 per team)
 *  - Rate limit rules for each API (mixed algorithms)
 *  - SLA definitions
 *  - Cost models
 *  - API keys (returns raw keys to console — save them!)
 *  - 1 admin user  (admin@nexgate.io / Admin123!)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../packages/gateway/.env') });

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { generateApiKey } = require('../packages/gateway/src/utils/crypto');

async function seed() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI not set'); process.exit(1); }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.info('✅ Connected to MongoDB\n');

  const db = mongoose.connection.db;

  // ─── CLEAR EXISTING DATA ──────────────────────────────────────────────────
  console.info('🗑️  Clearing existing seed data...');
  await Promise.all([
    db.collection('teams').deleteMany({ _isSeed: true }),
    db.collection('apis').deleteMany({ _isSeed: true }),
    db.collection('apikeys').deleteMany({ _isSeed: true }),
    db.collection('ratelimitrules').deleteMany({ _isSeed: true }),
    db.collection('sladefinitions').deleteMany({ _isSeed: true }),
    db.collection('costmodels').deleteMany({ _isSeed: true }),
    db.collection('adminusers').deleteMany({ email: 'admin@nexgate.io' }),
  ]);

  // ─── TEAMS ────────────────────────────────────────────────────────────────
  console.info('👥 Seeding teams...');
  const teamDocs = await db.collection('teams').insertMany([
    {
      name: 'Payments Team',
      slug: 'payments',
      description: 'Handles all payment processing and reconciliation APIs',
      email: 'payments@nexgate.io',
      monthlyBudgetCents: 50000, // $500/month
      budgetAlertThresholdPct: 80,
      isActive: true,
      _isSeed: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      name: 'Analytics Team',
      slug: 'analytics',
      description: 'Data platform and business intelligence APIs',
      email: 'analytics@nexgate.io',
      monthlyBudgetCents: 20000, // $200/month
      budgetAlertThresholdPct: 90,
      isActive: true,
      _isSeed: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      name: 'Platform Team',
      slug: 'platform',
      description: 'Core infrastructure and developer tooling APIs',
      email: 'platform@nexgate.io',
      monthlyBudgetCents: 100000, // $1000/month
      budgetAlertThresholdPct: 75,
      isActive: true,
      _isSeed: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
  const [paymentsTeam, analyticsTeam, platformTeam] = Object.values(teamDocs.insertedIds);
  console.info(`  ✅ 3 teams created`);

  // ─── APIS ─────────────────────────────────────────────────────────────────
  console.info('🌐 Seeding APIs...');
  const apiDocs = await db.collection('apis').insertMany([
    {
      name: 'Payment Gateway',
      description: 'Core payment processing — charges, refunds, disputes',
      version: 'v2',
      tags: ['payments', 'financial', 'critical'],
      ownerTeamId: paymentsTeam,
      targetBaseUrl: 'http://payment-service.internal:8080',
      timeoutMs: 15000,
      isActive: true,
      isPublic: false,
      stripApiKeyHeader: true,
      _isSeed: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      name: 'Reconciliation API',
      description: 'End-of-day settlement and transaction reconciliation',
      version: 'v1',
      tags: ['payments', 'batch', 'finance'],
      ownerTeamId: paymentsTeam,
      targetBaseUrl: 'http://reconciliation-service.internal:8081',
      timeoutMs: 60000,
      isActive: true,
      isPublic: false,
      stripApiKeyHeader: true,
      _isSeed: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      name: 'Events Stream API',
      description: 'Real-time event ingestion for analytics pipeline',
      version: 'v3',
      tags: ['analytics', 'streaming', 'events'],
      ownerTeamId: analyticsTeam,
      targetBaseUrl: 'http://events-service.internal:9000',
      timeoutMs: 5000,
      isActive: true,
      isPublic: true,
      stripApiKeyHeader: true,
      _isSeed: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      name: 'Reporting API',
      description: 'Ad-hoc business reports and dashboard data',
      version: 'v2',
      tags: ['analytics', 'reporting', 'bi'],
      ownerTeamId: analyticsTeam,
      targetBaseUrl: 'http://reporting-service.internal:9001',
      timeoutMs: 30000,
      isActive: true,
      isPublic: true,
      stripApiKeyHeader: true,
      _isSeed: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      name: 'Auth Service',
      description: 'JWT issuance, token validation, SSO integration',
      version: 'v1',
      tags: ['auth', 'security', 'platform'],
      ownerTeamId: platformTeam,
      targetBaseUrl: 'http://auth-service.internal:7000',
      timeoutMs: 10000,
      isActive: true,
      isPublic: false,
      stripApiKeyHeader: true,
      _isSeed: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      name: 'Config Service',
      description: 'Centralised feature flags and application configuration',
      version: 'v1',
      tags: ['platform', 'config', 'feature-flags'],
      ownerTeamId: platformTeam,
      targetBaseUrl: 'http://config-service.internal:7001',
      timeoutMs: 5000,
      isActive: true,
      isPublic: false,
      stripApiKeyHeader: true,
      _isSeed: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);
  const apiIds = Object.values(apiDocs.insertedIds);
  const [paymentGwId, reconId, eventsId, reportingId, authId, configId] = apiIds;
  console.info(`  ✅ 6 APIs created`);

  // ─── RATE LIMIT RULES (mixed algorithms) ─────────────────────────────────
  console.info('⚡ Seeding rate limit rules...');
  await db.collection('ratelimitrules').insertMany([
    // Payment Gateway — Sliding Window Log (most accurate for financial APIs)
    {
      name: 'Payment Gateway — Global Limit',
      description: 'Conservative limit for financial API. Sliding Window for precision.',
      scope: 'global', apiId: paymentGwId, teamId: null,
      algorithm: 'sliding_window_log',
      windowMs: 60000, maxRequests: 60,
      isActive: true, _isSeed: true, createdAt: new Date(), updatedAt: new Date(),
    },
    // Events Stream — Token Bucket (absorbs bursts from batch event senders)
    {
      name: 'Events Stream — Global Limit',
      description: 'Token Bucket allows burst ingestion from batch pipelines.',
      scope: 'global', apiId: eventsId, teamId: null,
      algorithm: 'token_bucket',
      windowMs: 60000, maxRequests: 1000,
      burstCapacity: 200, refillRate: 16.67, // 1000 req/min = 16.67/sec refill
      isActive: true, _isSeed: true, createdAt: new Date(), updatedAt: new Date(),
    },
    // Reporting API — Fixed Window (cheap reads are fine; boundary burst acceptable)
    {
      name: 'Reporting API — Global Limit',
      description: 'Fixed Window for read-heavy reporting API. Cheaper Redis ops.',
      scope: 'global', apiId: reportingId, teamId: null,
      algorithm: 'fixed_window',
      windowMs: 60000, maxRequests: 120,
      isActive: true, _isSeed: true, createdAt: new Date(), updatedAt: new Date(),
    },
    // Auth Service — Platform Team override (higher limit for platform's own use)
    {
      name: 'Auth Service — Platform Team Override',
      description: 'Platform team gets a higher rate limit on their own Auth service.',
      scope: 'team', apiId: authId, teamId: platformTeam,
      algorithm: 'token_bucket',
      windowMs: 60000, maxRequests: 5000,
      burstCapacity: 500, refillRate: 83.33,
      isActive: true, _isSeed: true, createdAt: new Date(), updatedAt: new Date(),
    },
    {
      name: 'Auth Service — Global Limit',
      scope: 'global', apiId: authId, teamId: null,
      algorithm: 'sliding_window_log',
      windowMs: 60000, maxRequests: 300,
      isActive: true, _isSeed: true, createdAt: new Date(), updatedAt: new Date(),
    },
    {
      name: 'Config Service — Global Limit',
      scope: 'global', apiId: configId, teamId: null,
      algorithm: 'fixed_window',
      windowMs: 60000, maxRequests: 500,
      isActive: true, _isSeed: true, createdAt: new Date(), updatedAt: new Date(),
    },
  ]);
  console.info(`  ✅ Rate limit rules created`);

  // ─── SLA DEFINITIONS ─────────────────────────────────────────────────────
  console.info('🛡️  Seeding SLA definitions...');
  await db.collection('sladefinitions').insertMany([
    {
      name: 'Payment Gateway — Gold SLA',
      apiId: paymentGwId, teamId: null,
      maxP95LatencyMs: 300, maxErrorRatePct: 0.1, minUptimePct: 99.99,
      alertThresholdPct: 80,
      isActive: true, currentStatus: 'unknown',
      _isSeed: true, createdAt: new Date(), updatedAt: new Date(),
    },
    {
      name: 'Events Stream — Standard SLA',
      apiId: eventsId, teamId: null,
      maxP95LatencyMs: 500, maxErrorRatePct: 1.0, minUptimePct: 99.9,
      alertThresholdPct: 90,
      isActive: true, currentStatus: 'unknown',
      _isSeed: true, createdAt: new Date(), updatedAt: new Date(),
    },
    {
      name: 'Auth Service — Platinum SLA',
      apiId: authId, teamId: null,
      maxP95LatencyMs: 200, maxErrorRatePct: 0.01, minUptimePct: 99.999,
      alertThresholdPct: 85,
      isActive: true, currentStatus: 'unknown',
      _isSeed: true, createdAt: new Date(), updatedAt: new Date(),
    },
  ]);
  console.info(`  ✅ SLA definitions created`);

  // ─── COST MODELS ─────────────────────────────────────────────────────────
  console.info('💰 Seeding cost models...');
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  await db.collection('costmodels').insertMany([
    {
      name: 'Default Cost Model',
      apiId: null, // Applies to all APIs without a specific model
      centsPerThousandRequests: 5, // $0.05 per 1000 requests
      effectiveFrom: new Date('2024-01-01'),
      isActive: true,
      _isSeed: true, createdAt: new Date(), updatedAt: new Date(),
    },
    {
      name: 'Payment Gateway — Premium Pricing',
      apiId: paymentGwId,
      centsPerThousandRequests: 50, // $0.50 per 1000 (financial API premium)
      effectiveFrom: new Date('2024-01-01'),
      isActive: true,
      _isSeed: true, createdAt: new Date(), updatedAt: new Date(),
    },
  ]);
  console.info(`  ✅ Cost models created`);

  // ─── API KEYS ─────────────────────────────────────────────────────────────
  console.info('🔑 Seeding API keys...');
  const keyResults = [];

  const keySeeds = [
    {
      name: 'Payments Team — Production Key',
      teamId: paymentsTeam,
      allowedApiIds: [paymentGwId, reconId],
      scopes: ['write'],
    },
    {
      name: 'Analytics Team — Read-Only Key',
      teamId: analyticsTeam,
      allowedApiIds: [eventsId, reportingId],
      scopes: ['read'],
    },
    {
      name: 'Platform Team — Admin Key',
      teamId: platformTeam,
      allowedApiIds: [authId, configId],
      scopes: ['admin'],
    },
  ];

  const keyDocs = [];
  for (const ks of keySeeds) {
    const { rawKey, keyHash, keyPrefix } = generateApiKey();
    keyResults.push({ name: ks.name, rawKey });
    keyDocs.push({
      name: ks.name,
      keyPrefix,
      keyHash,
      teamId: ks.teamId,
      createdBy: 'seed-script',
      allowedApiIds: ks.allowedApiIds,
      scopes: ks.scopes,
      status: 'active',
      requestCount: 0,
      _isSeed: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  await db.collection('apikeys').insertMany(keyDocs);
  console.info(`  ✅ ${keyDocs.length} API keys created`);

  // ─── ADMIN USER ───────────────────────────────────────────────────────────
  console.info('👤 Seeding admin user...');
  const passwordHash = await bcrypt.hash('Admin123!', 12);
  await db.collection('adminusers').insertOne({
    email: 'admin@nexgate.io',
    passwordHash,
    role: 'admin',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  console.info(`  ✅ Admin user created`);

  // ─── SUMMARY ──────────────────────────────────────────────────────────────
  console.info('\n' + '═'.repeat(60));
  console.info('🚀 NexGate seed complete! Save these credentials:\n');
  console.info('  Portal Login:');
  console.info('    Email:    admin@nexgate.io');
  console.info('    Password: Admin123!\n');
  console.info('  API Keys (COPY NOW — not stored in plaintext):');
  keyResults.forEach(k => {
    console.info(`    ${k.name}:`);
    console.info(`      ${k.rawKey}`);
  });
  console.info('\n' + '═'.repeat(60));

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch(err => {
  console.error('❌ Seed failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
