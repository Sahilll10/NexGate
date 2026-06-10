/**
 * NexGate Gateway — MongoDB Connection
 * The gateway reads from MongoDB for:
 *   1. API key validation (api_keys collection — primary on cache miss)
 *   2. API config lookup (apis collection — primary on cache miss)
 *   3. Rate limit rule resolution (rate_limit_rules collection)
 *
 * The gateway NEVER writes directly to MongoDB.
 * All writes go through BullMQ → Worker → MongoDB.
 * This enforces the strict Data Plane / Control Plane boundary.
 */

const mongoose = require('mongoose');
const env = require('../config/env');

let isConnected = false;

async function connectMongoDB() {
  if (isConnected) return mongoose.connection;

  try {
    await mongoose.connect(env.MONGODB_URI, {
      maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
      minPoolSize: env.MONGODB_MIN_POOL_SIZE,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      // Heartbeat to detect stale connections early
      heartbeatFrequencyMS: 10000,
    });

    isConnected = true;
    console.info('[Gateway] ✅ MongoDB connected');

    mongoose.connection.on('error', err => {
      console.error('[Gateway] MongoDB error:', err.message);
      isConnected = false;
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('[Gateway] MongoDB disconnected — will attempt reconnect');
      isConnected = false;
    });

    mongoose.connection.on('reconnected', () => {
      console.info('[Gateway] MongoDB reconnected');
      isConnected = true;
    });

    return mongoose.connection;
  } catch (err) {
    console.error('[Gateway] ❌ MongoDB connection failed:', err.message);
    throw err;
  }
}

function isMongoHealthy() {
  return mongoose.connection.readyState === 1;
}

module.exports = { connectMongoDB, isMongoHealthy };
