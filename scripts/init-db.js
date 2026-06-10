/**
 * NexGate — Database Initialisation Script
 * ════════════════════════════════════════════════════════════════════════════
 * Run: node scripts/init-db.js
 *
 * Creates all collections with correct indexes and time-series configuration.
 * WHY PROGRAMMATIC (not Atlas UI)?
 *   1. Reproducibility: running this script in a new environment produces
 *      an identical schema. UI-created indexes are not tracked in source control.
 *   2. CI/CD integration: this script runs in the deployment pipeline before
 *      the gateway starts accepting traffic.
 *   3. Index changes require explicit migration — forces intentional schema evolution.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../packages/gateway/.env') });

const mongoose = require('mongoose');

async function initDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('❌ MONGODB_URI not set. Copy packages/gateway/.env.example to .env and fill it in.');
    process.exit(1);
  }

  console.info('🔗 Connecting to MongoDB Atlas...');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.info('✅ Connected\n');

  const db = mongoose.connection.db;
  const existingCollections = (await db.listCollections().toArray()).map(c => c.name);

  async function ensureCollection(name) {
    if (!existingCollections.includes(name)) {
      await db.createCollection(name);
      console.info(`  📁 Created collection: ${name}`);
    } else {
      console.info(`  ✓  Collection exists: ${name}`);
    }
  }

  console.info('── Creating standard collections ──────────────────────────');
  for (const name of ['teams', 'apis', 'apikeys', 'ratelimitrules', 'sladefinitions', 'costmodels', 'costreports', 'alerts', 'adminusers']) {
    await ensureCollection(name);
  }

  // ─── TIME-SERIES COLLECTION (request_logs) ────────────────────────────────
  // Time-series collections have different creation semantics — they must be
  // created with createCollection() using options, not just via a schema.
  // MongoDB automatically optimises storage and queries for time-series data.
  //
  // timeField:  'timestamp' — the field containing the time of each measurement
  // metaField:  'meta' — identifies the time series (apiId, teamId, keyId)
  //              MongoDB co-locates documents with the same meta values for compression.
  // granularity: 'seconds' — optimises internal bucket sizes for second-granularity data
  //
  // NOTE: Atlas M0 free tier DOES support time-series collections.
  if (!existingCollections.includes('requestlogs')) {
    try {
      await db.createCollection('requestlogs', {
        timeseries: {
          timeField: 'timestamp',
          metaField: 'meta',
          granularity: 'seconds',
        },
        expireAfterSeconds: 30 * 24 * 60 * 60, // 30 days TTL
      });
      console.info('  📁 Created time-series collection: requestlogs (30-day TTL)');
    } catch (err) {
      if (err.codeName === 'NamespaceExists') {
        console.info('  ✓  Time-series collection exists: requestlogs');
      } else {
        // Atlas M0 may not support time-series — fall back to regular collection
        console.warn(`  ⚠️  Time-series creation failed: ${err.message}`);
        console.warn('  ↳  Falling back to regular collection with TTL index');
        await db.createCollection('requestlogs');
        await db.collection('requestlogs').createIndex(
          { timestamp: 1 },
          { expireAfterSeconds: 30 * 24 * 60 * 60, name: 'ttl_30d' }
        );
      }
    }
  } else {
    console.info('  ✓  Collection exists: requestlogs');
  }

  // ─── INDEXES ──────────────────────────────────────────────────────────────
  console.info('\n── Creating indexes ───────────────────────────────────────');

  const indexOps = [
    // teams
    { col: 'teams', index: { slug: 1 },      opts: { unique: true, name: 'slug_unique' } },
    { col: 'teams', index: { isActive: 1 },  opts: { name: 'isActive' } },

    // apis
    { col: 'apis', index: { name: 'text', description: 'text', tags: 'text' },
      opts: { name: 'fulltext_search', weights: { name: 10, tags: 5, description: 1 } } },
    { col: 'apis', index: { ownerTeamId: 1, isActive: 1 }, opts: { name: 'owner_active' } },

    // apikeys
    { col: 'apikeys', index: { keyHash: 1 },             opts: { unique: true, name: 'keyHash_unique' } },
    { col: 'apikeys', index: { teamId: 1, status: 1 },   opts: { name: 'team_status' } },
    { col: 'apikeys', index: { expiresAt: 1 },           opts: { expireAfterSeconds: 0, name: 'ttl_expiry', sparse: true } },

    // ratelimitrules
    { col: 'ratelimitrules', index: { apiId: 1, teamId: 1, scope: 1, isActive: 1 }, opts: { name: 'rule_lookup' } },

    // requestlogs (additional indexes on top of time-series built-ins)
    { col: 'requestlogs', index: { 'meta.teamId': 1, timestamp: -1 }, opts: { name: 'team_time' } },
    { col: 'requestlogs', index: { 'meta.apiId': 1, timestamp: -1 },  opts: { name: 'api_time' } },
    { col: 'requestlogs', index: { statusCode: 1, timestamp: -1 },    opts: { name: 'status_time' } },

    // sladefinitions
    { col: 'sladefinitions', index: { apiId: 1, teamId: 1 }, opts: { name: 'api_team' } },

    // costmodels
    { col: 'costmodels', index: { apiId: 1, effectiveFrom: -1, isActive: 1 }, opts: { name: 'api_pricing' } },

    // costreports
    { col: 'costreports', index: { teamId: 1, month: 1 }, opts: { unique: true, name: 'team_month_unique' } },

    // alerts
    { col: 'alerts', index: { dedupKey: 1, status: 1 }, opts: { name: 'dedup_status' } },
    { col: 'alerts', index: { teamId: 1, status: 1, createdAt: -1 }, opts: { name: 'team_status_time' } },
    { col: 'alerts', index: { createdAt: 1 }, opts: { expireAfterSeconds: 90 * 24 * 60 * 60, name: 'ttl_90d' } },

    // adminusers
    { col: 'adminusers', index: { email: 1 }, opts: { unique: true, name: 'email_unique' } },
  ];

  let created = 0, skipped = 0;
  for (const { col, index, opts } of indexOps) {
    try {
      await db.collection(col).createIndex(index, { background: true, ...opts });
      console.info(`  ✅ ${col}.${opts.name}`);
      created++;
    } catch (err) {
      if (err.codeName === 'IndexAlreadyExists' || err.code === 85 || err.code === 86) {
        console.info(`  ✓  ${col}.${opts.name} (exists)`);
        skipped++;
      } else {
        console.warn(`  ⚠️  ${col}.${opts.name}: ${err.message}`);
      }
    }
  }

  console.info(`\n── Summary ────────────────────────────────────────────────`);
  console.info(`  Indexes created: ${created}   Indexes skipped (existing): ${skipped}`);
  console.info('\n✅ Database initialisation complete!\n');

  await mongoose.disconnect();
  process.exit(0);
}

initDB().catch(err => {
  console.error('❌ Init failed:', err.message);
  process.exit(1);
});
