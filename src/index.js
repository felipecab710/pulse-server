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
 * GET /watch/:raceId
 * SPECTATOR PAGE - Live race viewer (supports both Pulse WebSocket AND Firestore fallback)
 */
app.get('/watch/:raceId', (req, res) => {
  const { raceId } = req.params;
  const race = races.get(raceId);
  
  // Get server URL for WebSocket connection
  const wsProtocol = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
  const host = req.headers.host || 'localhost:3000';
  const wsUrl = `${wsProtocol}://${host}`;
  const httpUrl = `${req.headers['x-forwarded-proto'] || 'http'}://${host}`;
  
  // Firebase config for direct Firestore access
  const firebaseConfig = {
    apiKey: "AIzaSyB1gWjlZLUYQOz-1-6tZ2KBjxLlgTLwFvE",
    authDomain: "resz-dev.firebaseapp.com",
    projectId: "resz-dev",
    storageBucket: "resz-dev.firebasestorage.app",
    messagingSenderId: "934349498127",
    appId: "1:934349498127:ios:b34c16ab52ce37c0c4a5c2"
  };
  
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>🏃 Live Race - SEVN</title>
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
      <!-- Firebase for Firestore fallback -->
      <script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js"></script>
      <script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-compat.js"></script>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
          background: #0a0a0a;
          color: #ffffff;
          min-height: 100vh;
          overflow-x: hidden;
        }
        
        .header {
          background: linear-gradient(180deg, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0) 100%);
          padding: 20px;
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          z-index: 1000;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        
        .logo {
          font-size: 24px;
          font-weight: 700;
          color: #CCFF00;
        }
        
        .live-badge {
          background: #ff3b30;
          color: white;
          padding: 6px 12px;
          border-radius: 20px;
          font-size: 12px;
          font-weight: 600;
          animation: pulse 2s infinite;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        
        .live-badge::before {
          content: '';
          width: 8px;
          height: 8px;
          background: white;
          border-radius: 50%;
        }
        
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.7; }
        }
        
        #map {
          width: 100%;
          height: 60vh;
          background: #1a1a1a;
        }
        
        .runners-panel {
          padding: 20px;
          background: #0a0a0a;
        }
        
        .panel-title {
          font-size: 14px;
          color: #888;
          text-transform: uppercase;
          letter-spacing: 1px;
          margin-bottom: 16px;
        }
        
        .runners-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        
        .runner-card {
          background: #1a1a1a;
          border-radius: 16px;
          padding: 16px;
          display: flex;
          align-items: center;
          gap: 16px;
          border: 1px solid #2a2a2a;
          transition: all 0.3s ease;
        }
        
        .runner-card:hover {
          border-color: #CCFF00;
          transform: translateY(-2px);
        }
        
        .runner-position {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 700;
          font-size: 14px;
        }
        
        .runner-avatar {
          width: 48px;
          height: 48px;
          border-radius: 50%;
          background: linear-gradient(135deg, #CCFF00, #00ff88);
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 700;
          font-size: 18px;
          color: #000;
        }
        
        .runner-info {
          flex: 1;
        }
        
        .runner-name {
          font-weight: 600;
          font-size: 16px;
          margin-bottom: 4px;
        }
        
        .runner-stats {
          display: flex;
          gap: 16px;
          color: #888;
          font-size: 14px;
        }
        
        .stat {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        
        .stat-value {
          color: #fff;
          font-weight: 500;
        }
        
        .runner-pace {
          text-align: right;
        }
        
        .pace-value {
          font-size: 24px;
          font-weight: 700;
          color: #CCFF00;
        }
        
        .pace-label {
          font-size: 12px;
          color: #666;
        }
        
        .connection-status {
          position: fixed;
          bottom: 20px;
          right: 20px;
          padding: 10px 16px;
          border-radius: 20px;
          font-size: 12px;
          font-weight: 500;
          z-index: 1000;
        }
        
        .connected {
          background: rgba(0, 255, 136, 0.2);
          color: #00ff88;
          border: 1px solid rgba(0, 255, 136, 0.3);
        }
        
        .disconnected {
          background: rgba(255, 59, 48, 0.2);
          color: #ff3b30;
          border: 1px solid rgba(255, 59, 48, 0.3);
        }
        
        .connecting {
          background: rgba(255, 204, 0, 0.2);
          color: #ffcc00;
          border: 1px solid rgba(255, 204, 0, 0.3);
        }
        
        .no-runners {
          text-align: center;
          padding: 40px 20px;
          color: #666;
        }
        
        .no-runners h3 {
          font-size: 18px;
          margin-bottom: 8px;
          color: #888;
        }
        
        .timer {
          font-size: 32px;
          font-weight: 700;
          font-family: "SF Mono", Monaco, monospace;
          color: #CCFF00;
        }
        
        /* Leaflet customization */
        .leaflet-container {
          background: #1a1a1a;
        }
        
        .runner-marker {
          border-radius: 50%;
          border: 3px solid white;
          box-shadow: 0 2px 8px rgba(0,0,0,0.5);
        }
        
        .runner-label {
          background: rgba(0,0,0,0.8);
          border: none;
          border-radius: 4px;
          color: white;
          font-weight: 600;
          padding: 2px 6px;
          font-size: 11px;
          white-space: nowrap;
        }
        
        @media (max-width: 768px) {
          .header { padding: 12px 16px; }
          .logo { font-size: 20px; }
          #map { height: 50vh; }
          .runners-panel { padding: 16px; }
          .runner-card { padding: 12px; }
        }
      </style>
    </head>
    <body>
      <header class="header">
        <div class="logo">🏁 SEVN</div>
        <div class="live-badge">LIVE</div>
      </header>
      
      <div id="map"></div>
      
      <div class="runners-panel">
        <div class="panel-title">Runners</div>
        <div id="runners-list" class="runners-list">
          <div class="no-runners">
            <h3>Waiting for runners...</h3>
            <p>Runners will appear here when they start</p>
          </div>
        </div>
      </div>
      
      <div id="connection-status" class="connection-status connecting">
        Connecting...
      </div>
      
      <script>
        // ═══════════════════════════════════════════════════════════
        // CONFIGURATION
        // ═══════════════════════════════════════════════════════════
        
        const RACE_ID = '${raceId}';
        const WS_URL = '${wsUrl}';
        const HTTP_URL = '${httpUrl}';
        const SPECTATOR_ID = 'spectator_' + Math.random().toString(36).substr(2, 9);
        
        // Firebase config for Firestore fallback
        const firebaseConfig = ${JSON.stringify(firebaseConfig)};
        
        // Initialize Firebase
        let db = null;
        let firestoreUnsubscribe = null;
        try {
          firebase.initializeApp(firebaseConfig);
          db = firebase.firestore();
          console.log('✅ Firebase initialized');
        } catch (e) {
          console.warn('⚠️ Firebase init error:', e);
        }
        
        // Runner colors (matches iOS app)
        const RUNNER_COLORS = [
          '#FF6347', // Tomato (Orange-Red)
          '#4169E1', // Royal Blue
          '#32CD32', // Lime Green
          '#FFD700', // Gold
          '#FF69B4', // Hot Pink
          '#00CED1', // Dark Turquoise
          '#9370DB', // Medium Purple
          '#FF8C00'  // Dark Orange
        ];
        
        // ═══════════════════════════════════════════════════════════
        // STATE
        // ═══════════════════════════════════════════════════════════
        
        let ws = null;
        let map = null;
        let runners = new Map(); // runnerId → { marker, data, trail }
        let reconnectAttempts = 0;
        
        // ═══════════════════════════════════════════════════════════
        // MAP INITIALIZATION
        // ═══════════════════════════════════════════════════════════
        
        function initMap() {
          // Default to Miami Half Marathon start area
          map = L.map('map', {
            center: [25.782187, -80.189261],
            zoom: 15,
            zoomControl: false,
            attributionControl: false
          });
          
          // Dark map tiles
          L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 19
          }).addTo(map);
          
          // Add zoom control to bottom left
          L.control.zoom({ position: 'bottomleft' }).addTo(map);
        }
        
        // ═══════════════════════════════════════════════════════════
        // FIRESTORE FALLBACK (Primary data source!)
        // ═══════════════════════════════════════════════════════════
        
        function connectFirestore() {
          if (!db) {
            console.warn('⚠️ Firestore not available');
            return;
          }
          
          console.log('🔥 Connecting to Firestore for race:', RACE_ID);
          updateConnectionStatus('connecting');
          
          // Listen to participants subcollection
          firestoreUnsubscribe = db.collection('liveRaces')
            .doc(RACE_ID)
            .collection('participants')
            .onSnapshot((snapshot) => {
              console.log('🔥 Firestore update: ' + snapshot.docs.length + ' participants');
              updateConnectionStatus('connected');
              
              snapshot.docs.forEach(doc => {
                const data = doc.data();
                
                // Only show runners with valid positions (not 0,0)
                if (data.latitude && data.longitude && data.latitude !== 0 && data.longitude !== 0) {
                  updateRunner(doc.id, {
                    name: data.userName || 'Runner',
                    lat: data.latitude,
                    lng: data.longitude,
                    distance: data.distance || 0,
                    pace: data.currentPace || 0,
                    heading: data.heading || 0,
                    status: data.status,
                    imageUrl: data.userImageUrl || null,
                    role: data.role
                  });
                }
              });
            }, (error) => {
              console.error('❌ Firestore error:', error);
              updateConnectionStatus('disconnected');
            });
        }
        
        // ═══════════════════════════════════════════════════════════
        // WEBSOCKET CONNECTION (Backup if Pulse is running)
        // ═══════════════════════════════════════════════════════════
        
        function connect() {
          const url = WS_URL + '?raceId=' + RACE_ID + '&userId=' + SPECTATOR_ID + '&role=spectator';
          
          console.log('🔌 Connecting to:', url);
          
          ws = new WebSocket(url);
          ws.binaryType = 'arraybuffer';
          
          ws.onopen = () => {
            console.log('✅ Connected to Pulse server');
            reconnectAttempts = 0;
            
            // Load initial snapshot
            loadSnapshot();
          };
          
          ws.onmessage = (event) => {
            handleMessage(event.data);
          };
          
          ws.onclose = () => {
            console.log('❌ Pulse disconnected, using Firestore');
            reconnectAttempts++;
          };
          
          ws.onerror = (err) => {
            console.error('❌ WebSocket error:', err);
          };
        }
        
        // ═══════════════════════════════════════════════════════════
        // SNAPSHOT LOADING
        // ═══════════════════════════════════════════════════════════
        
        async function loadSnapshot() {
          try {
            const response = await fetch(HTTP_URL + '/race/' + RACE_ID + '/snapshot');
            
            if (!response.ok) {
              console.warn('⚠️ Snapshot not available');
              return;
            }
            
            const buffer = await response.arrayBuffer();
            const data = new Uint8Array(buffer);
            
            // Parse snapshot (simple binary format)
            // Format: [type:1][serverTime:8][runnerCount:2][runners...]
            if (data.length < 13) {
              console.log('📦 Empty snapshot');
              return;
            }
            
            const view = new DataView(buffer);
            const runnerCount = view.getUint16(9, true);
            
            console.log('📦 Loaded snapshot:', runnerCount, 'runners');
            
            // Parse each runner (simplified - real parsing depends on protocol)
            let offset = 11;
            for (let i = 0; i < runnerCount && offset < data.length; i++) {
              // This is a simplified parser - actual format may differ
              // For now, we'll rely on WebSocket updates
            }
            
          } catch (err) {
            console.error('❌ Snapshot error:', err);
          }
        }
        
        // ═══════════════════════════════════════════════════════════
        // MESSAGE HANDLING
        // ═══════════════════════════════════════════════════════════
        
        function handleMessage(data) {
          const buffer = new Uint8Array(data);
          const messageType = buffer[0];
          
          // Message type 2 = POSITION_DELTA
          if (messageType === 2) {
            handlePositionDelta(buffer);
          }
          // Message type 4 = LEADERBOARD
          else if (messageType === 4) {
            handleLeaderboard(buffer);
          }
        }
        
        function handlePositionDelta(buffer) {
          const view = new DataView(buffer.buffer);
          
          // Parse position delta (based on protocol)
          // Format: [type:1][runnerId:4][lat:4][lng:4][distance:4][pace:2][heading:2][seq:2][timestamp:4]
          if (buffer.length < 23) return;
          
          const runnerId = view.getUint32(1, true);
          const lat = view.getFloat32(5, true);
          const lng = view.getFloat32(9, true);
          const distance = view.getFloat32(13, true);
          const pace = view.getUint16(17, true) / 100; // pace in min/mi × 100
          const heading = view.getInt16(19, true);
          
          console.log('📍 Position update:', { runnerId, lat, lng, distance, pace });
          
          updateRunner(runnerId.toString(), {
            lat,
            lng,
            distance,
            pace,
            heading
          });
        }
        
        function handleLeaderboard(buffer) {
          // Leaderboard updates (future)
          console.log('🏆 Leaderboard update received');
        }
        
        // ═══════════════════════════════════════════════════════════
        // RUNNER MANAGEMENT
        // ═══════════════════════════════════════════════════════════
        
        function updateRunner(runnerId, data) {
          const colorIndex = runners.size % RUNNER_COLORS.length;
          const color = runners.has(runnerId) ? runners.get(runnerId).color : RUNNER_COLORS[colorIndex];
          const displayName = data.name || 'Runner ' + runnerId.slice(-4);
          
          if (!runners.has(runnerId)) {
            // Create new runner
            const marker = L.circleMarker([data.lat, data.lng], {
              radius: 12,
              fillColor: color,
              fillOpacity: 1,
              color: '#fff',
              weight: 3
            }).addTo(map);
            
            // Add label with actual name
            const label = L.tooltip({
              permanent: true,
              direction: 'top',
              offset: [0, -15],
              className: 'runner-label'
            }).setContent(displayName.split(' ')[0]); // First name only
            
            marker.bindTooltip(label);
            
            // Trail polyline
            const trail = L.polyline([], {
              color: color,
              weight: 4,
              opacity: 0.6
            }).addTo(map);
            
            runners.set(runnerId, {
              marker,
              trail,
              data: { ...data, name: displayName },
              positions: [[data.lat, data.lng]],
              color: color
            });
            
            console.log('🏃 New runner:', displayName, 'at', data.lat.toFixed(5), data.lng.toFixed(5));
            
            // Fit map to show all runners
            fitMapToRunners();
            
          } else {
            // Update existing runner
            const runner = runners.get(runnerId);
            runner.marker.setLatLng([data.lat, data.lng]);
            runner.data = { ...data, name: runner.data.name || displayName };
            
            // Update trail (smooth animation)
            const lastPos = runner.positions[runner.positions.length - 1];
            const newPos = [data.lat, data.lng];
            
            // Only add to trail if moved significantly (>5 meters)
            if (!lastPos || getDistance(lastPos, newPos) > 5) {
              runner.positions.push(newPos);
              if (runner.positions.length > 500) {
                runner.positions.shift(); // Keep last 500 points
              }
              runner.trail.setLatLngs(runner.positions);
            }
          }
          
          // Update UI
          updateRunnersPanel();
        }
        
        // Calculate distance between two points in meters
        function getDistance(pos1, pos2) {
          const R = 6371000; // Earth radius in meters
          const lat1 = pos1[0] * Math.PI / 180;
          const lat2 = pos2[0] * Math.PI / 180;
          const deltaLat = (pos2[0] - pos1[0]) * Math.PI / 180;
          const deltaLng = (pos2[1] - pos1[1]) * Math.PI / 180;
          
          const a = Math.sin(deltaLat/2) * Math.sin(deltaLat/2) +
                    Math.cos(lat1) * Math.cos(lat2) *
                    Math.sin(deltaLng/2) * Math.sin(deltaLng/2);
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
          
          return R * c;
        }
        
        function fitMapToRunners() {
          if (runners.size === 0) return;
          
          const bounds = L.latLngBounds([]);
          runners.forEach(runner => {
            bounds.extend([runner.data.lat, runner.data.lng]);
          });
          
          map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
        }
        
        // ═══════════════════════════════════════════════════════════
        // UI UPDATES
        // ═══════════════════════════════════════════════════════════
        
        function updateRunnersPanel() {
          const container = document.getElementById('runners-list');
          
          if (runners.size === 0) {
            container.innerHTML = \`
              <div class="no-runners">
                <h3>Waiting for runners...</h3>
                <p>Runners will appear here when they start</p>
              </div>
            \`;
            return;
          }
          
          // Sort by distance (descending)
          const sorted = Array.from(runners.entries())
            .sort((a, b) => (b[1].data.distance || 0) - (a[1].data.distance || 0));
          
          container.innerHTML = sorted.map(([runnerId, runner], index) => {
            const data = runner.data;
            const color = runner.color;
            const distanceMiles = ((data.distance || 0) / 1609.34).toFixed(2);
            const paceStr = formatPace(data.pace || 0);
            const name = data.name || 'Runner';
            const initials = name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
            
            return \`
              <div class="runner-card" onclick="focusRunner('\${runnerId}')">
                <div class="runner-position" style="background: \${color}; color: #000;">
                  \${index + 1}
                </div>
                <div class="runner-avatar" style="background: \${color};">
                  \${initials}
                </div>
                <div class="runner-info">
                  <div class="runner-name">\${name}</div>
                  <div class="runner-stats">
                    <span class="stat">
                      <span class="stat-value">\${distanceMiles}</span> mi
                    </span>
                  </div>
                </div>
                <div class="runner-pace">
                  <div class="pace-value">\${paceStr}</div>
                  <div class="pace-label">min/mi</div>
                </div>
              </div>
            \`;
          }).join('');
        }
        
        function formatPace(pace) {
          if (!pace || pace <= 0) return '--:--';
          const minutes = Math.floor(pace);
          const seconds = Math.round((pace - minutes) * 60);
          return minutes + ':' + seconds.toString().padStart(2, '0');
        }
        
        function focusRunner(runnerId) {
          const runner = runners.get(runnerId);
          if (runner) {
            map.setView([runner.data.lat, runner.data.lng], 17);
          }
        }
        
        function updateConnectionStatus(status) {
          const el = document.getElementById('connection-status');
          el.className = 'connection-status ' + status;
          
          switch (status) {
            case 'connected':
              el.textContent = '● Connected';
              break;
            case 'disconnected':
              el.textContent = '○ Reconnecting...';
              break;
            case 'connecting':
              el.textContent = '◐ Connecting...';
              break;
          }
        }
        
        // ═══════════════════════════════════════════════════════════
        // INITIALIZATION
        // ═══════════════════════════════════════════════════════════
        
        document.addEventListener('DOMContentLoaded', () => {
          initMap();
          
          // Primary: Connect to Firestore (always works!)
          connectFirestore();
          
          // Secondary: Also try WebSocket for lower latency
          connect();
          
          // Refresh runners panel periodically
          setInterval(updateRunnersPanel, 1000);
        });
      </script>
    </body>
    </html>
  `);
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
              <strong>Runners:</strong> ${race.runners} | <strong>Clients:</strong> ${race.clients}<br>
              <a href="/watch/${race.raceId}" style="color: #00ff88; font-weight: bold;">📺 Watch Live →</a>
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
