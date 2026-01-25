/**
 * SEVN PULSE SERVER
 * Ultra-low latency position streaming for live racing
 */

const express = require('express');
const WebSocket = require('ws');
const Redis = require('ioredis');
const cors = require('cors');
const http = require('http');

const {
  MessageType,
  Tier,
  encodePositionDelta,
  decodeRunnerUpdate,
  encodeSnapshot,
  decodeSetInterest,
  encodeLeaderboard,
  encodeTierChange
} = require('./protocol/messages');

const SpatialGrid = require('./spatial/SpatialGrid');
const TierManager = require('./services/TierManager');
const GPSSmoother = require('./services/GPSSmoother');

// ═══════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Redis connection (OPTIONAL - will work without it for MVP)
let redis = null;

try {
  redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  
  redis.on('connect', () => {
    console.log('✅ Redis connected');
  });
  
  redis.on('error', (err) => {
    console.warn('⚠️  Redis unavailable (non-critical):', err.message);
    redis = null; // Disable Redis if connection fails
  });
} catch (err) {
  console.warn('⚠️  Redis disabled - running without cache (degraded performance)');
  redis = null;
}

// Middleware
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════

// Active races
const races = new Map(); // raceId → RaceState

class RaceState {
  constructor(raceId, config = {}) {
    this.raceId = raceId;
    this.runners = new Map(); // runnerId → RunnerState
    this.clients = new Map(); // clientId → ClientState
    this.spatialGrid = new SpatialGrid();
    this.tierManager = new TierManager();
    this.gpsSmoother = new GPSSmoother(); // GPS smoothing
    this.totalDistance = config.totalDistance || 0;
    this.startTime = config.startTime || Date.now();
    this.leaderboard = [];
    this.sequenceCounter = 0;
    
    // Set route for GPS snapping if provided
    if (config.routeCoordinates && config.routeCoordinates.length > 0) {
      this.gpsSmoother.setRoute(raceId, config.routeCoordinates);
    }
  }
}

class RunnerState {
  constructor(data) {
    this.uid = data.uid;
    this.lat = data.lat;
    this.lng = data.lng;
    this.distance = data.distance || 0;
    this.pace = data.pace || 0;
    this.heading = data.heading || 0;
    this.status = data.status || 1; // 1 = racing
    this.position = data.position || null;
    this.colorIndex = data.colorIndex || 0;
    this.lastUpdate = Date.now();
  }
}

class ClientState {
  constructor(ws, userId, raceId, role) {
    this.ws = ws;
    this.userId = userId;
    this.raceId = raceId;
    this.role = role; // 'runner' or 'spectator'
    this.lastSentTimes = new Map(); // runnerId → timestamp
    this.isAlive = true;
  }
}

// ═══════════════════════════════════════════════════════════
// HTTP ENDPOINTS
// ═══════════════════════════════════════════════════════════

/**
 * GET /race/:raceId/snapshot
 * Instant race snapshot for "Spotify-grade" instant fill
 */
app.get('/race/:raceId/snapshot', async (req, res) => {
  const { raceId } = req.params;
  
  console.log(`📸 Snapshot request for race: ${raceId}`);
  
  try {
    // Check cache first (only if Redis is available)
    if (redis) {
      const cached = await redis.get(`race:${raceId}:snapshot`);
      
      if (cached) {
        console.log(`✅ Serving cached snapshot`);
        res.type('application/octet-stream');
        return res.send(Buffer.from(cached, 'base64'));
      }
    }
    
    // Build from Redis or in-memory state
    let race = races.get(raceId);
    
    // ✅ AUTO-CREATE race if it doesn't exist (on-demand creation)
    if (!race) {
      console.log(`📦 Race ${raceId} doesn't exist - creating on-demand...`);
      race = new RaceState(raceId);
      races.set(raceId, race);
      console.log(`✅ Race ${raceId} created! (0 runners)`);
    }
    
    console.log(`📊 Race ${raceId} has ${race.runners.size} runners in memory`);
    console.log(`📊 Runner IDs: ${Array.from(race.runners.keys()).join(', ')}`);
    
    const runners = Array.from(race.runners.values()).map(r => ({
      uid: r.uid,
      lat: r.lat,
      lng: r.lng,
      dist: r.distance,
      pace: r.pace,
      hdg: r.heading,
      status: r.status,
      colorIndex: r.colorIndex,
      position: r.position || 0
    }));
    
    const snapshot = encodeSnapshot({
      serverTime: Date.now(),
      runners
    });
    
    // Cache for 5 seconds (only if Redis is available)
    if (redis) {
      await redis.setex(`race:${raceId}:snapshot`, 5, snapshot.toString('base64'));
    }
    
    console.log(`✅ Snapshot built: ${runners.length} runners, ${snapshot.length} bytes`);
    
    res.type('application/octet-stream');
    res.send(snapshot);
    
  } catch (err) {
    console.error('❌ Snapshot error:', err);
    res.status(500).json({ error: 'Failed to generate snapshot' });
  }
});

/**
 * POST /race/:raceId/route
 * Set race route for GPS snapping
 */
app.post('/race/:raceId/route', express.json(), async (req, res) => {
  const { raceId } = req.params;
  const { routeCoordinates } = req.body;
  
  if (!routeCoordinates || !Array.isArray(routeCoordinates)) {
    return res.status(400).json({ error: 'routeCoordinates array required' });
  }
  
  const race = races.get(raceId);
  if (race) {
    race.gpsSmoother.setRoute(raceId, routeCoordinates);
  }
  
  // Store in Redis for persistence (if available)
  if (redis) {
    await redis.set(`race:${raceId}:route`, JSON.stringify(routeCoordinates));
  }
  
  console.log(`📍 Route set for ${raceId}: ${routeCoordinates.length} points`);
  
  res.json({ success: true, pointCount: routeCoordinates.length });
});

/**
 * GET /race/:raceId/leaderboard
 * Server-authoritative leaderboard
 */
app.get('/race/:raceId/leaderboard', async (req, res) => {
  const { raceId } = req.params;
  
  const race = races.get(raceId);
  if (!race) {
    return res.status(404).json({ error: 'Race not found' });
  }
  
  res.json(race.leaderboard);
});

/**
 * GET /health
 * Health check
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeRaces: races.size,
    timestamp: Date.now()
  });
});

/**
 * GET /
 * Welcome page
 */
app.get('/', (req, res) => {
  const activeRaces = Array.from(races.entries()).map(([id, race]) => ({
    raceId: id,
    runners: race.runners.size,
    clients: race.clients.size
  }));
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>SEVN Pulse Server</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          max-width: 800px;
          margin: 40px auto;
          padding: 20px;
          background: #1a1a1a;
          color: #ffffff;
        }
        h1 { color: #00ff88; }
        .status { 
          background: #2a2a2a; 
          padding: 20px; 
          border-radius: 8px; 
          margin: 20px 0;
        }
        .endpoint {
          background: #3a3a3a;
          padding: 10px;
          margin: 10px 0;
          border-radius: 4px;
          font-family: monospace;
        }
        .badge {
          display: inline-block;
          background: #00ff88;
          color: #000;
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: bold;
        }
      </style>
    </head>
    <body>
      <h1>🏁 SEVN Pulse Server</h1>
      <p>Ultra-low latency position streaming for live racing</p>
      
      <div class="status">
        <h3>Server Status: <span class="badge">ONLINE</span></h3>
        <p>Active Races: <strong>${races.size}</strong></p>
        <p>Total Connections: <strong>${Array.from(races.values()).reduce((sum, r) => sum + r.clients.size, 0)}</strong></p>
        <p>Timestamp: <strong>${new Date().toISOString()}</strong></p>
      </div>
      
      ${activeRaces.length > 0 ? `
        <div class="status">
          <h3>🏃 Active Races</h3>
          ${activeRaces.map(race => `
            <div class="endpoint">
              <strong>Race ID:</strong> ${race.raceId}<br>
              <strong>Runners:</strong> ${race.runners} | <strong>Clients:</strong> ${race.clients}
            </div>
          `).join('')}
        </div>
      ` : ''}
      
      <div class="status">
        <h3>📡 API Endpoints</h3>
        <div class="endpoint">GET /health</div>
        <div class="endpoint">GET /race/:raceId/snapshot</div>
        <div class="endpoint">GET /race/:raceId/leaderboard</div>
        <div class="endpoint">POST /race/:raceId/route</div>
        <div class="endpoint">WS ws://localhost:3000?raceId=X&userId=Y&role=runner</div>
      </div>
      
      <div class="status">
        <h3>🚀 Quick Test</h3>
        <p><a href="/health" style="color: #00ff88;">Check Health Endpoint →</a></p>
      </div>
    </body>
    </html>
  `);
});


// ═══════════════════════════════════════════════════════════
// WEBSOCKET SERVER
// ═══════════════════════════════════════════════════════════

wss.on('connection', (ws, req) => {
  console.log(`🔌 Connection handler triggered! URL: ${req.url}`);
  
  const url = new URL(req.url, 'ws://localhost');
  const raceId = url.searchParams.get('raceId');
  const userId = url.searchParams.get('userId');
  const role = url.searchParams.get('role') || 'spectator';
  
  console.log(`🔌 Parsed params: raceId=${raceId}, userId=${userId}, role=${role}`);
  
  if (!raceId || !userId) {
    console.log(`❌ Missing params! Closing connection...`);
    ws.close(4000, 'Missing raceId or userId');
    return;
  }
  
  const clientId = `${raceId}:${userId}`;
  
  // Create or get race state
  if (!races.has(raceId)) {
    races.set(raceId, new RaceState(raceId));
    console.log(`🏁 New race created: ${raceId}`);
  }
  
  const race = races.get(raceId);
  
  // Create client state
  const client = new ClientState(ws, userId, raceId, role);
  race.clients.set(clientId, client);
  
  // Initialize heartbeat flag on the WebSocket instance
  ws.isAlive = true;
  
  console.log(`✅ ${userId} joined ${raceId} as ${role} (${race.clients.size} total clients)`);
  
  // ─────────────────────────────────────────────────────────
  // MESSAGE HANDLER
  // ─────────────────────────────────────────────────────────
  
  ws.on('message', async (data) => {
    try {
      // Check message type
      const messageType = data[0];
      
      switch (messageType) {
        case MessageType.RUNNER_UPDATE:
          handleRunnerUpdate(race, client, data);
          break;
          
        case MessageType.SET_INTEREST:
          handleSetInterest(race, client, data);
          break;
          
        case MessageType.PIN_RUNNER:
          handlePinRunner(race, client, data);
          break;
          
        case MessageType.HEARTBEAT:
          client.isAlive = true;
          break;
          
        default:
          console.warn(`⚠️ Unknown message type: ${messageType}`);
      }
    } catch (err) {
      console.error('❌ Message handling error:', err);
    }
  });
  
  // ─────────────────────────────────────────────────────────
  // CONNECTION CLOSE
  // ─────────────────────────────────────────────────────────
  
  ws.on('close', () => {
    race.clients.delete(clientId);
    race.tierManager.removeClient(clientId);
    
    console.log(`❌ ${userId} left ${raceId} (${race.clients.size} remaining)`);
    
    // Cleanup empty races
    if (race.clients.size === 0) {
      races.delete(raceId);
      console.log(`🗑️ Race ${raceId} removed (no clients)`);
    }
  });
  
  // ─────────────────────────────────────────────────────────
  // ERROR HANDLER
  // ─────────────────────────────────────────────────────────
  
  ws.on('error', (err) => {
    console.error(`❌ WebSocket error for ${userId}:`, err);
  });
  
  // ─────────────────────────────────────────────────────────
  // PING/PONG HANDLER (Heartbeat)
  // ─────────────────────────────────────────────────────────
  
  ws.on('pong', () => {
    ws.isAlive = true;
  });
});

// ═══════════════════════════════════════════════════════════
// MESSAGE HANDLERS
// ═══════════════════════════════════════════════════════════

function handleRunnerUpdate(race, client, data) {
  if (client.role !== 'runner') {
    console.warn(`⚠️ Non-runner ${client.userId} tried to send position update`);
    return;
  }
  
  console.log(`📍 handleRunnerUpdate called for userId: ${client.userId}, race: ${race.raceId}`);
  
  const update = decodeRunnerUpdate(data);
  const now = Date.now();
  
  // ═══════════════════════════════════════════════════════
  // GPS SMOOTHING (The Magic!)
  // ═══════════════════════════════════════════════════════
  
  const smoothed = race.gpsSmoother.smooth(
    client.userId,
    race.raceId,
    update.lat,
    update.lng,
    update.heading,
    now
  );
  
  // Log if flagged or low confidence
  if (smoothed.flagged || smoothed.confidence < 0.3) {
    console.warn(`⚠️ Runner ${client.userId}: confidence=${smoothed.confidence.toFixed(2)}, flagged=${smoothed.flagged}, speed=${smoothed.speed?.toFixed(1)}m/s`);
  }
  
  // Use smoothed position (not raw)
  const finalLat = smoothed.lat;
  const finalLng = smoothed.lng;
  
  // Update runner state
  const runnerState = new RunnerState({
    uid: parseInt(client.userId),
    lat: finalLat,
    lng: finalLng,
    distance: update.distance,
    pace: update.pace,
    heading: update.heading,
    status: update.status
  });
  
  // Store confidence for client awareness (optional)
  runnerState.confidence = smoothed.confidence;
  
  // Assign unique colorIndex based on userId (rotate through 8 colors)
  runnerState.colorIndex = parseInt(client.userId) % 8;
  
  race.runners.set(client.userId, runnerState);
  console.log(`✅ Runner ${client.userId} added to race.runners (total: ${race.runners.size})`);
  
  // Update spatial grid (use smoothed position)
  race.spatialGrid.update(client.userId, finalLat, finalLng);
  
  // Store in Redis (with both raw and smoothed for debugging) - ONLY IF AVAILABLE
  if (redis) {
    redis.hset(`race:${race.raceId}:runner:${client.userId}`, {
      lat: finalLat,
      lng: finalLng,
      rawLat: smoothed.rawLat,
      rawLng: smoothed.rawLng,
      distance: update.distance,
      pace: update.pace,
      heading: update.heading,
      status: update.status,
      confidence: smoothed.confidence.toFixed(2),
      ts: now
    });
    
    // Update leaderboard
    redis.zadd(`race:${race.raceId}:leaderboard`, update.distance, client.userId);
  }
  
  // Broadcast to nearby/interested clients
  broadcastPositionUpdate(race, client.userId, runnerState);
}

function handleSetInterest(race, client, data) {
  const interest = decodeSetInterest(data.toString());
  if (!interest) return;
  
  console.log(`🎯 ${client.userId} set interest: ${interest.focus}`);
  
  race.tierManager.setInterest(client.clientId, interest);
  
  // Send initial tier assignments
  const { tiers } = race.tierManager.updateTiers(client.clientId, race);
  
  // TODO: Send tier assignment response
}

function handlePinRunner(race, client, data) {
  const runnerId = data.toString('utf8', 1);
  race.tierManager.pinRunner(client.clientId, runnerId);
  
  console.log(`📌 ${client.userId} pinned ${runnerId}`);
}

// ═══════════════════════════════════════════════════════════
// BROADCASTING
// ═══════════════════════════════════════════════════════════

function broadcastPositionUpdate(race, runnerId, runnerState) {
  const sequence = race.sequenceCounter++;
  
  // Create position delta packet
  const delta = encodePositionDelta({
    runnerId: runnerState.uid,
    lat: runnerState.lat,
    lng: runnerState.lng,
    distance: runnerState.distance,
    pace: runnerState.pace,
    heading: runnerState.heading,
    sequence,
    timestamp: Date.now() - race.startTime
  });
  
  console.log(`📡 Broadcasting update for runner ${runnerId} to ${race.clients.size} clients`);
  
  // Send to all interested clients (with tier-based throttling)
  let sentCount = 0;
  race.clients.forEach((client, clientId) => {
    if (client.role === 'runner' && client.userId === runnerId) {
      return; // Don't send runner their own position
    }
    
    // Check if should send based on tier throttling
    const lastSent = client.lastSentTimes.get(runnerId) || 0;
    const shouldSend = race.tierManager.shouldSendUpdate(runnerId, clientId, lastSent);
    
    console.log(`  Client ${client.userId} (${client.role}): shouldSend=${shouldSend}, readyState=${client.ws.readyState}`);
    
    if (shouldSend) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(delta);
        client.lastSentTimes.set(runnerId, Date.now());
        sentCount++;
      }
    }
  });
  
  console.log(`  ✅ Sent to ${sentCount} clients`);
}

// ═══════════════════════════════════════════════════════════
// PERIODIC TASKS
// ═══════════════════════════════════════════════════════════

// Update leaderboards every 5 seconds
setInterval(async () => {
  // Skip if Redis is unavailable
  if (!redis) return;
  
  for (const [raceId, race] of races.entries()) {
    try {
      // Get top 10 from Redis
      const top10 = await redis.zrevrange(`race:${raceId}:leaderboard`, 0, 9, 'WITHSCORES');
      
      const leaders = [];
      for (let i = 0; i < top10.length; i += 2) {
        leaders.push({
          uid: parseInt(top10[i]),
          distance: parseInt(top10[i + 1])
        });
      }
      
      race.leaderboard = leaders;
      
      // Broadcast to all clients
      if (leaders.length > 0) {
        const leaderboardPacket = encodeLeaderboard(leaders);
        
        race.clients.forEach(client => {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(leaderboardPacket);
          }
        });
      }
    } catch (err) {
      console.error(`❌ Leaderboard update error for ${raceId}:`, err);
    }
  }
}, 5000);

// Heartbeat check every 30 seconds
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ═══════════════════════════════════════════════════════════
// HTTP → WEBSOCKET UPGRADE
// ═══════════════════════════════════════════════════════════

server.on('upgrade', (request, socket, head) => {
  console.log(`🔌 Upgrade request received: ${request.url}`);
  
  wss.handleUpgrade(request, socket, head, ws => {
    console.log(`🔌 Upgrade successful! Emitting connection...`);
    wss.emit('connection', ws, request);
  });
});

// ═══════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`
🚀 SEVN PULSE SERVER RUNNING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HTTP:      http://localhost:${PORT}
WebSocket: ws://localhost:${PORT}
Redis:     ${process.env.REDIS_URL || 'localhost:6379'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Ready for Miami! 🔥
  `);
});

module.exports = { app, server };
