# 🚀 SEVN Pulse Server

Ultra-low latency position streaming for live racing. The backend powering SEVN's "Spotify-grade" instant race experience.

## 🏗️ Architecture

- **Node.js + Express**: HTTP API for snapshots
- **WebSocket**: Real-time position streaming
- **Redis**: Hot data cache + leaderboard
- **In-Memory Spatial Grid**: Fast nearby queries (no Redis GEORADIUS spam)
- **Tier Manager**: Multi-fidelity interest management (the core innovation)

## 📦 Installation

```bash
npm install
```

## 🚀 Running Locally

### 1. Start Redis (required)

```bash
# macOS with Homebrew
brew services start redis

# Or with Docker
docker run -d -p 6379:6379 redis:latest
```

### 2. Start server

```bash
npm start
```

Server will run on `http://localhost:3000`

## 📡 API Endpoints

### HTTP

- **GET /race/:raceId/snapshot** - Get instant race snapshot (binary)
- **GET /race/:raceId/leaderboard** - Get top 10 leaders (JSON)
- **GET /health** - Health check

### WebSocket

Connect to `ws://localhost:3000?raceId=XXX&userId=YYY&role=runner`

**Query params:**
- `raceId`: Race identifier
- `userId`: User identifier
- `role`: `runner` or `spectator`

## 📊 Performance Targets

| Metric | Target |
|--------|--------|
| Snapshot load time | <200ms |
| Position delta size | 24 bytes |
| Concurrent runners | 500-1000 |
| Update rate (Tier 1) | 5Hz (200ms) |
| Server memory | <512MB per 500 runners |

## 🔥 The SEVN Pulse Protocol

### Message Types

- `0x10` SET_INTEREST - Client sets viewing preferences
- `0x11` RUNNER_UPDATE - Runner sends position (28 bytes)
- `0x20` SNAPSHOT - Server sends full state (instant fill)
- `0x21` POSITION_DELTA - Server sends position update (24 bytes)
- `0x22` LEADERBOARD - Server sends top 10 (61 bytes)

### Tier System (Multi-Fidelity)

- **Tier 1 (Ultra-High)**: 5Hz - Leaders, pinned runners
- **Tier 2 (High)**: 2Hz - Nearby pack
- **Tier 3 (Medium)**: 1Hz - Mid-distance
- **Tier 4 (Low)**: 0.5Hz - Distant field

## 🧪 Testing

```bash
# TODO: Add test scripts
npm test
```

## 🚀 Deployment

For production, deploy to:
- **Heroku** (easy, $7/month dyno)
- **Railway** (modern, $5/month)
- **AWS ECS** (scalable, ~$20/month)
- **Render** (simple, $7/month)

Redis options:
- **Redis Cloud** (free 30MB tier)
- **Upstash** (serverless, pay-per-request)
- **AWS ElastiCache** ($15/month minimum)

## 📝 Environment Variables

```bash
PORT=3000
REDIS_URL=redis://localhost:6379
```

## 🎯 Miami Ready

This server is optimized for the Miami Half Marathon test (250-500 concurrent runners).

**Expected load:**
- 500 runners × 2 updates/sec = 1000 writes/sec
- 5000 spectators × 50 reads/sec = 250K reads/sec
- Total bandwidth: ~200KB/sec out

**Estimated cost:** <$2 per race

---

Built with 🔥 for SEVN Pulse
