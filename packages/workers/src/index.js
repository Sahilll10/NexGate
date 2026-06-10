/**
 * NexGate — Workers Entry Point
 * Starts all background workers in a single process:
 *   1. Log Consumer (BullMQ worker — continuous)
 *   2. Cost Aggregator (cron — nightly)
 *   3. SLA Monitor (cron — every 5 minutes)
 *
 * Separation from the gateway process means worker slowdowns never affect
 * gateway response times. Workers share MongoDB + Redis but not the event loop.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../gateway/.env') });

const mongoose = require('mongoose');
const { connectMongoDB } = require('../../gateway/src/db/mongodb');
const { getRedisClient } = require('../../gateway/src/db/redis');
const { createLogConsumer } = require('./workers/logConsumer');
const { scheduleCostAggregator, runCostAggregation } = require('./workers/costAggregator');
const { scheduleSlaMonitor, runSlaEvaluation } = require('./workers/slaMonitor');

// Allow running specific workers manually for testing
const RUN_COST_NOW = process.argv.includes('--run-cost-now');
const RUN_SLA_NOW = process.argv.includes('--run-sla-now');

async function start() {
  try {
    console.info('[Workers] Starting NexGate Background Workers...');

    await connectMongoDB();

    const redis = getRedisClient();
    await new Promise((resolve, reject) => {
      if (redis.status === 'ready') return resolve();
      redis.once('ready', resolve);
      redis.once('error', reject);
      setTimeout(() => reject(new Error('Redis timeout')), 10000);
    });

    console.info('[Workers] ✅ Dependencies connected');

    // Start BullMQ log consumer (runs continuously)
    const logWorker = createLogConsumer();

    // Schedule cron workers
    scheduleCostAggregator();
    scheduleSlaMonitor();

    // Manual triggers for testing (--run-cost-now, --run-sla-now)
    if (RUN_COST_NOW) {
      console.info('[Workers] Running cost aggregation NOW (--run-cost-now flag)');
      await runCostAggregation();
    }
    if (RUN_SLA_NOW) {
      console.info('[Workers] Running SLA evaluation NOW (--run-sla-now flag)');
      await runSlaEvaluation();
    }

    console.info('[Workers] 🚀 All workers running');

    // Graceful shutdown
    const shutdown = async (signal) => {
      console.info(`\n[Workers] ${signal} — shutting down...`);
      await logWorker.close();
      await mongoose.disconnect();
      const { closeRedis } = require('../../gateway/src/db/redis');
      await closeRedis();
      console.info('[Workers] Shutdown complete');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (err) {
    console.error('[Workers] ❌ Startup failed:', err.message);
    process.exit(1);
  }
}

start();
