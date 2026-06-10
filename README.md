# ⚡ NexGate — Enterprise Internal API Gateway & Observability Platform

**Author:** Sahil Kumar (Roll: 3252)  
**Stack:** MongoDB · Express · React · Node.js · Redis · BullMQ · Socket.io

---

## 📐 Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                         DATA PLANE                               │
│  Consumer → Express Gateway → Redis (Rate Limit) → Upstream API │
│                   ↓ (async, post-response)                       │
│             BullMQ Log Queue (Redis-backed)                      │
└──────────────────────────────────────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────────┐
│                       CONTROL PLANE                              │
│  Log Consumer Worker → MongoDB (request_logs time-series)        │
│  Cost Aggregator (nightly cron) → MongoDB (cost_reports)         │
│  SLA Monitor (5-min cron) → MongoDB (sla_definitions)            │
│  Socket.io (Redis pub/sub adapter) → React Dashboard             │
│  Management API (Express) → React Portal                         │
└──────────────────────────────────────────────────────────────────┘
```

### Two Processes, Clear Separation

| Process | Role | Writes to DB? | Reads Redis? |
|---------|------|--------------|-------------|
| `gateway` | Proxy + Auth + Rate Limit | ❌ Never directly | ✅ Rate limits, cache |
| `api` | Management REST + Socket.io | ✅ Via Mongoose | ✅ Pub/sub adapter |
| `workers` | Log consumer, Cost, SLA | ✅ MongoDB only | ✅ BullMQ queues |

---

## 🗂 Monorepo Structure

```
nexgate/
├── packages/
│   ├── gateway/          # Express API Gateway (Data Plane)
│   │   └── src/
│   │       ├── algorithms/   # slidingWindowLog, tokenBucket, fixedWindow
│   │       ├── db/           # MongoDB + Redis connections, all 8 models
│   │       ├── middleware/   # auth, rateLimit, scope, proxy, metrics
│   │       ├── queues/       # BullMQ log queue producer
│   │       └── services/     # cache, circuitBreaker
│   ├── api/              # Management API + Socket.io (Control Plane)
│   │   └── src/
│   │       ├── routes/       # teams, apis, keys, sla, costs, alerts, analytics
│   │       └── socket/       # Socket.io + Redis adapter + metrics aggregation
│   ├── workers/          # BullMQ Workers
│   │   └── src/workers/
│   │       ├── logConsumer.js     # Batched MongoDB writes from queue
│   │       ├── costAggregator.js  # Nightly cost attribution with dist. lock
│   │       └── slaMonitor.js      # 5-min P95 evaluation + alert deduplication
│   └── portal/           # React Dashboard (Vite + Tailwind + Recharts)
│       └── src/
│           ├── components/   # Dashboard, APIs, Keys, SLA, Costs, Alerts
│           ├── hooks/        # useSocket (Socket.io client)
│           └── store/        # Zustand (auth, live metrics, UI)
├── scripts/
│   ├── init-db.js        # Creates all collections + indexes (run before first start)
│   └── seed.js           # Demo data: 3 teams, 6 APIs, keys, rules
├── .github/workflows/
│   └── ci-cd.yml         # GitHub Actions: lint → test → build → deploy
└── docker-compose.yml    # Local MongoDB + Redis (no cloud account needed)
```

---

## 🔑 Key Technical Decisions

### Rate Limiting Algorithms

| Algorithm | Use Case | Redis Memory | Precision |
|-----------|----------|-------------|-----------|
| Sliding Window Log | Financial APIs, high-security | High — O(maxRequests) per key | Exact |
| Token Bucket | Batch APIs, burst-tolerant | O(1) per key (~16 bytes) | Exact |
| Fixed Window | High-volume reads, analytics | O(1) per key (~8 bytes) | ±2× at boundaries |

### API Key Security (SHA-256 not bcrypt)
- Keys are 256-bit random tokens (not passwords) → brute force requires 2²⁵⁶ attempts
- SHA-256: ~1µs per hash → negligible on hot path; deterministic → O(1) lookup
- bcrypt at cost=12: ~100ms per hash → **100,000× slower** → unacceptable for gateway auth
- Prefix `nxg_` enables secret scanning and log triage (same pattern as GitHub, Stripe)

### Why BullMQ (not direct MongoDB writes)
- P99 MongoDB write: ~200ms under load. BullMQ.add() (Redis XADD): ~0.5ms P99
- Gateway response latency is completely decoupled from log write latency
- Workers absorb MongoDB slowdowns; queue depth increases, response time doesn't

---

## 🚀 Quick Start (Local Development)

### Prerequisites
- Node.js 18+
- Docker Desktop

### 1. Clone and install

```bash
git clone <repo-url> nexgate
cd nexgate
npm install
```

### 2. Start local infrastructure

```bash
docker compose up -d
# MongoDB: mongodb://nexgate:nexgate_dev_password@localhost:27017/nexgate?authSource=admin
# Redis:   redis://localhost:6379
```

### 3. Configure environment

```bash
# Gateway
cp packages/gateway/.env.example packages/gateway/.env
# Edit: MONGODB_URI and REDIS_URL (use docker-compose values above)

# Management API
cp packages/api/.env.example packages/api/.env
# Edit: same MongoDB + Redis, plus JWT_SECRET (any random 32-char string)

# Portal
echo "VITE_API_URL=http://localhost:4000/api" > packages/portal/.env
```

### 4. Initialise database

```bash
node scripts/init-db.js
```

### 5. Seed demo data

```bash
node scripts/seed.js
# ⚠ COPY the printed API keys — they won't be shown again
```

### 6. Start all services

```bash
npm run dev
# Gateway:    http://localhost:3000
# Mgmt API:   http://localhost:4000
# Portal:     http://localhost:5173

# Login: admin@nexgate.io / Admin123!
```

---

## 🧪 Testing Rate Limiting

```bash
# Test the gateway with a seeded API key
# Replace <your-nxg-key> with the key printed by seed.js
# Replace <api-id> with an API ObjectId from the portal

# Test Fixed Window (should allow first 5, deny 6th)
for i in {1..7}; do
  curl -s -o /dev/null -w "Request $i: HTTP %{http_code}\n" \
    -H "x-nexgate-key: <your-nxg-key>" \
    http://localhost:3000/proxy/<api-id>/health
done

# Run SLA monitor now (don't wait 5 minutes)
node packages/workers/src/index.js --run-sla-now

# Run cost aggregation now
node packages/workers/src/index.js --run-cost-now
```

---

## ☁️ Production Deployment (Zero Cost)

### Platform Map

| Service | Platform | Tier |
|---------|----------|------|
| React Portal | Vercel | Free (Hobby) |
| Express Gateway | Render | Free Web Service |
| Management API | Render | Free Web Service |
| BullMQ Workers | Render | Free Background Worker |
| MongoDB | Atlas | M0 Free (512 MB) |
| Redis | Upstash | Free (10K commands/day) |

### ⚠️ Upstash Free Tier Math

Upstash free tier: **10,000 commands/day**

Rate limiting uses 2 Redis commands per request (Lua script counts as 1):
- 10,000 ÷ 2 = **5,000 proxied requests/day** before hitting the limit

For production beyond 5K req/day: upgrade to Upstash Pay-As-You-Go (~$0.20 per 100K commands).

### ⚠️ Render Cold Start Mitigation

Render free tier spins down after 15 minutes of inactivity. Cold start adds 10-30 seconds to the first request.

**Mitigation options (cheapest → most robust):**

1. **External ping (free):** Use UptimeRobot (free plan, 5-minute interval) to ping `GET /health` every 5 minutes. Prevents spindown entirely.

2. **Self-ping (free, architectural):** Add a `setInterval` in the gateway that calls its own `/health` endpoint every 10 minutes. Works without external services.

3. **Render paid tier ($7/month):** No spindown. Dedicated CPU. Recommended for production traffic.

### MongoDB Atlas M0 Capacity

M0 storage limit: **512 MB**

At 1000 RPS with 30-day TTL on request_logs:
- Each log document: ~500 bytes
- 1000 req/s × 86,400 s/day × 500 bytes = **43 GB/day** ← exceeds M0!
- **Practical M0 limit: ~500 requests/day sustained, OR reduce TTL to 1 day**

For production volume: MongoDB Atlas M2 ($9/month) → 2GB, M5 ($25/month) → 5GB.

---

## 📊 MongoDB Collections

| Collection | Type | TTL | Write Volume |
|------------|------|-----|-------------|
| `teams` | Regular | None | Very low |
| `apis` | Regular | None | Low |
| `apikeys` | Regular | On `expiresAt` | Low |
| `ratelimitrules` | Regular | None | Very low |
| `requestlogs` | **Time-Series** | 30 days | **Very high** |
| `sladefinitions` | Regular | None | Low |
| `costmodels` | Regular | None | Very low |
| `costreports` | Regular | None | Low |
| `alerts` | Regular | 90 days | Medium |

---

## 🔐 Security Checklist

- [x] API keys hashed with SHA-256 (never stored in plaintext)
- [x] Raw key shown exactly once, never stored
- [x] JWT with 1-day expiry + 7-day refresh token
- [x] Rate limiting on management API (500/15min global, 20/15min for login)
- [x] Helmet.js security headers on management API
- [x] CORS configured to allow only portal origin
- [x] Circuit breaker prevents cascading failures
- [x] Scope-based access control (read/write/admin)
- [x] API key header stripped before proxying to upstream
- [x] MongoDB connection uses TLS (Atlas default)
- [x] Redis TLS for Upstash connections
- [x] Environment variable validation at startup (Zod)
- [x] Secrets in GitHub Secrets / Render environment (never in code)

---

## 📡 WebSocket Events

| Event | Direction | Payload | Frequency |
|-------|-----------|---------|-----------|
| `metrics:api` | Server → Client | `{ apiId, rps, p95LatencyMs, errorRatePct }` | 1/sec |
| `metrics:team` | Server → Client | Team aggregate | 1/sec |
| `metrics:platform` | Server → Client (admin) | Platform aggregate | 1/sec |
| `subscribe:api` | Client → Server | `apiId` | On demand |
| `alert:new` | Server → Client | Alert document | On alert |

---

## 🛠 Environment Variables Reference

### Gateway (`packages/gateway/.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MONGODB_URI` | ✅ | — | Atlas connection string |
| `REDIS_URL` | ✅ | — | Redis connection URL |
| `REDIS_TLS` | | `false` | Enable TLS (set `true` for Upstash) |
| `GATEWAY_PORT` | | `3000` | Gateway HTTP port |
| `API_KEY_HEADER` | | `x-nexgate-key` | Header name for API keys |
| `DEFAULT_RATE_LIMIT_ALGORITHM` | | `sliding_window_log` | Fallback algorithm |
| `LOG_QUEUE_NAME` | | `nexgate:logs` | BullMQ queue name |

### Management API (`packages/api/.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MONGODB_URI` | ✅ | — | Same Atlas connection string |
| `REDIS_URL` | ✅ | — | Same Redis URL |
| `JWT_SECRET` | ✅ | — | Min 32 chars, random |
| `PORTAL_URL` | | `http://localhost:5173` | CORS origin |
| `API_PORT` | | `4000` | Management API port |

---

*Built with ❤️ by Sahil Kumar (Roll: 3252) — NexGate v1.0.0*
