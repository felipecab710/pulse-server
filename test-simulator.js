#!/usr/bin/env node

/**
 * SEVN PULSE TEST SIMULATOR
 * Simulates 100+ runners for load testing
 * 
 * Usage: node test-simulator.js [numRunners] [serverUrl] [raceId]
 * 
 * Examples:
 *   node test-simulator.js 10                              # 10 runners, localhost
 *   node test-simulator.js 50 wss://myapp.railway.app      # 50 runners, cloud
 *   node test-simulator.js 100 wss://myapp.railway.app test-race-123
 */

const WebSocket = require('ws');

// Config - check if argv[2] is a URL or number
const arg2 = process.argv[2];
const arg3 = process.argv[3];
const arg4 = process.argv[4];

let NUM_RUNNERS, WS_URL, RACE_ID;

if (arg2 && arg2.startsWith('ws')) {
  // Format: node test-simulator.js wss://url [numRunners] [raceId]
  WS_URL = arg2;
  NUM_RUNNERS = parseInt(arg3) || 100;
  RACE_ID = arg4 || 'test-race-' + Date.now();
} else {
  // Format: node test-simulator.js [numRunners] [serverUrl] [raceId]
  NUM_RUNNERS = parseInt(arg2) || 100;
  WS_URL = arg3 || process.env.PULSE_SERVER_URL || process.env.WS_URL || 'ws://localhost:3000';
  RACE_ID = arg4 || 'test-race-' + Date.now();
}

// Miami Half Marathon route (simplified - 13.1 miles)
const MIAMI_ROUTE = [
  { lat: 25.7617, lng: -80.1918 }, // Start
  { lat: 25.7650, lng: -80.1900 },
  { lat: 25.7700, lng: -80.1850 },
  { lat: 25.7750, lng: -80.1800 },
  { lat: 25.7800, lng: -80.1750 },
  { lat: 25.7850, lng: -80.1700 },
  { lat: 25.7900, lng: -80.1650 },
  { lat: 25.7920, lng: -80.1600 }, // ~Mile 3
  { lat: 25.7950, lng: -80.1550 },
  { lat: 25.7980, lng: -80.1500 },
  { lat: 25.8000, lng: -80.1450 },
  { lat: 25.7980, lng: -80.1400 }, // Turn around
  { lat: 25.7950, lng: -80.1450 },
  { lat: 25.7900, lng: -80.1500 },
  { lat: 25.7850, lng: -80.1550 },
  { lat: 25.7800, lng: -80.1600 }, // ~Mile 9
  { lat: 25.7750, lng: -80.1650 },
  { lat: 25.7700, lng: -80.1700 },
  { lat: 25.7650, lng: -80.1750 },
  { lat: 25.7617, lng: -80.1800 }  // Finish (13.1 miles)
];

// Metrics tracking
const metrics = {
  messagesReceived: 0,
  messagesSent: 0,
  latencies: [],
  errors: 0,
  startTime: Date.now()
};

// Runner simulation
class SimulatedRunner {
  constructor(id) {
    this.id = id;
    this.ws = null;
    this.position = 0; // Position along route (0-1)
    this.pace = 6.0 + Math.random() * 4.0; // 6-10 min/mile
    this.speed = 1000 / (this.pace * 60); // m/s
    this.distance = 0; // meters
    this.heading = 0;
    this.isConnected = false;
    this.updateInterval = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = `${WS_URL}/race?raceId=${RACE_ID}&userId=${this.id}&role=runner`;
      
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.isConnected = true;
        console.log(`✅ Runner ${this.id} connected`);
        resolve();
      });

      this.ws.on('message', (data) => {
        metrics.messagesReceived++;
        
        // Track latency
        const messageType = data[0];
        if (messageType === 0x21) { // POSITION_DELTA
          const now = Date.now();
          const timestamp = data.readUInt32LE(20);
          const latency = now - timestamp;
          metrics.latencies.push(latency);
        }
      });

      this.ws.on('error', (err) => {
        metrics.errors++;
        console.error(`❌ Runner ${this.id} error:`, err.message);
        reject(err);
      });

      this.ws.on('close', () => {
        this.isConnected = false;
        this.stop();
      });
    });
  }

  start() {
    // Send position updates at ~2Hz (every 500ms)
    this.updateInterval = setInterval(() => {
      if (!this.isConnected) return;

      // Move along route
      this.position += (this.speed / 21097) * 0.5; // Advance based on speed
      this.position = Math.min(this.position, 1.0); // Cap at finish

      // Get current lat/lng from route
      const routeIndex = Math.floor(this.position * (MIAMI_ROUTE.length - 1));
      const nextIndex = Math.min(routeIndex + 1, MIAMI_ROUTE.length - 1);
      const t = (this.position * (MIAMI_ROUTE.length - 1)) - routeIndex;

      const p1 = MIAMI_ROUTE[routeIndex];
      const p2 = MIAMI_ROUTE[nextIndex];

      // Add GPS jitter (5-10m realistic noise)
      const jitterLat = (Math.random() - 0.5) * 0.0001; // ~10m
      const jitterLng = (Math.random() - 0.5) * 0.0001;

      const lat = p1.lat + (p2.lat - p1.lat) * t + jitterLat;
      const lng = p1.lng + (p2.lng - p1.lng) * t + jitterLng;

      // Calculate heading
      this.heading = Math.atan2(p2.lng - p1.lng, p2.lat - p1.lat) * 180 / Math.PI;
      if (this.heading < 0) this.heading += 360;

      // Calculate distance
      this.distance = this.position * 21097; // Total race distance in meters

      // Send position update
      this.sendPosition(lat, lng);

    }, 500); // 2Hz
  }

  sendPosition(lat, lng) {
    if (!this.isConnected) return;

    // Encode as binary (28 bytes)
    const buffer = Buffer.alloc(28);
    
    buffer.writeUInt8(0x11, 0); // RUNNER_UPDATE message type
    buffer.writeFloatLE(lat, 1);
    buffer.writeFloatLE(lng, 5);
    buffer.writeUInt32LE(Math.floor(this.distance), 9); // distance (meters)
    buffer.writeUInt16LE(Math.floor(this.pace * 10), 13); // pace (sec/km × 10)
    buffer.writeUInt16LE(Math.floor(this.heading), 15); // heading (degrees)
    buffer.writeUInt8(1, 17); // status: racing

    this.ws.send(buffer);
    metrics.messagesSent++;
  }

  stop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  disconnect() {
    this.stop();
    if (this.ws) {
      this.ws.close();
    }
  }
}

// Main simulation
async function runSimulation() {
  console.log(`
🏁 SEVN PULSE TEST SIMULATOR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Server:        ${WS_URL}
Race ID:       ${RACE_ID}
Num Runners:   ${NUM_RUNNERS}
Route:         Miami Half Marathon (13.1 mi)
Update Rate:   2Hz per runner
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

  const runners = [];

  // Create runners
  console.log(`📦 Creating ${NUM_RUNNERS} simulated runners...`);
  for (let i = 0; i < NUM_RUNNERS; i++) {
    runners.push(new SimulatedRunner(1000 + i));
  }

  // Connect runners (staggered to avoid overwhelming server)
  console.log(`🔌 Connecting runners (staggered)...`);
  for (let i = 0; i < runners.length; i++) {
    try {
      await runners[i].connect();
      
      // Stagger connections by 50ms
      if (i < runners.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } catch (err) {
      console.error(`Failed to connect runner ${runners[i].id}:`, err.message);
    }
  }

  const connectedCount = runners.filter(r => r.isConnected).length;
  console.log(`✅ ${connectedCount} / ${NUM_RUNNERS} runners connected`);

  if (connectedCount === 0) {
    console.error('❌ No runners connected. Exiting.');
    process.exit(1);
  }

  // Start race
  console.log(`\n🏃 Starting race simulation...\n`);
  runners.forEach(r => r.start());

  // Print metrics every 5 seconds
  const metricsInterval = setInterval(() => {
    const elapsed = (Date.now() - metrics.startTime) / 1000;
    const avgLatency = metrics.latencies.length > 0
      ? metrics.latencies.reduce((a, b) => a + b, 0) / metrics.latencies.length
      : 0;
    const p95Latency = metrics.latencies.length > 0
      ? metrics.latencies.sort((a, b) => a - b)[Math.floor(metrics.latencies.length * 0.95)]
      : 0;

    const sendRate = metrics.messagesSent / elapsed;
    const receiveRate = metrics.messagesReceived / elapsed;

    console.log(`
📊 METRICS (${Math.floor(elapsed)}s elapsed)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Connected:     ${runners.filter(r => r.isConnected).length} / ${NUM_RUNNERS}
Sent:          ${metrics.messagesSent} (${sendRate.toFixed(1)}/sec)
Received:      ${metrics.messagesReceived} (${receiveRate.toFixed(1)}/sec)
Latency Avg:   ${avgLatency.toFixed(0)}ms
Latency P95:   ${p95Latency.toFixed(0)}ms
Errors:        ${metrics.errors}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `);

    // Clear latency samples to avoid memory bloat
    if (metrics.latencies.length > 1000) {
      metrics.latencies = metrics.latencies.slice(-500);
    }
  }, 5000);

  // Run for 5 minutes or until interrupted
  setTimeout(() => {
    console.log('\n⏱️ Simulation time limit reached. Stopping...\n');
    cleanup();
  }, 5 * 60 * 1000);

  // Cleanup on interrupt
  process.on('SIGINT', cleanup);

  function cleanup() {
    clearInterval(metricsInterval);
    console.log('\n🛑 Stopping runners...');
    runners.forEach(r => r.disconnect());
    
    // Final metrics
    const elapsed = (Date.now() - metrics.startTime) / 1000;
    const avgLatency = metrics.latencies.length > 0
      ? metrics.latencies.reduce((a, b) => a + b, 0) / metrics.latencies.length
      : 0;

    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 FINAL RESULTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Duration:      ${elapsed.toFixed(1)}s
Total Sent:    ${metrics.messagesSent}
Total Received: ${metrics.messagesReceived}
Avg Latency:   ${avgLatency.toFixed(0)}ms
Errors:        ${metrics.errors}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `);

    process.exit(0);
  }
}

// Run
runSimulation().catch(err => {
  console.error('❌ Simulation failed:', err);
  process.exit(1);
});
