/**
 * SEVN PULSE PROTOCOL v1.0
 * Binary message format for ultra-low latency position streaming
 */

// ═══════════════════════════════════════════════════════════
// MESSAGE TYPES
// ═══════════════════════════════════════════════════════════

const MessageType = {
  // Client → Server
  SET_INTEREST: 0x10,
  RUNNER_UPDATE: 0x11,
  PIN_RUNNER: 0x12,
  HEARTBEAT: 0x13,

  // Server → Client
  SNAPSHOT: 0x20,
  POSITION_DELTA: 0x21,
  LEADERBOARD: 0x22,
  TIER_CHANGE: 0x23,
  RACE_EVENT: 0x24,

  // Errors
  ERROR: 0xFF
};

// ═══════════════════════════════════════════════════════════
// TIER DEFINITIONS
// ═══════════════════════════════════════════════════════════

const Tier = {
  ULTRA_HIGH: 1,  // 5Hz - Leaders, pinned runners
  HIGH: 2,        // 2Hz - Nearby pack
  MEDIUM: 3,      // 1Hz - Mid-distance
  LOW: 4          // 0.2-0.5Hz - Distant field
};

const TierUpdateRate = {
  [Tier.ULTRA_HIGH]: 200,   // 5Hz (every 200ms)
  [Tier.HIGH]: 500,          // 2Hz
  [Tier.MEDIUM]: 1000,       // 1Hz
  [Tier.LOW]: 2000           // 0.5Hz
};

// ═══════════════════════════════════════════════════════════
// ENCODER: POSITION DELTA (Server → Client)
// ═══════════════════════════════════════════════════════════

/**
 * Encode position update for streaming
 * Format: 24 bytes per runner
 */
function encodePositionDelta(update) {
  const buffer = Buffer.alloc(25); // FIXED: Was 24, needed 25
  let offset = 0;

  buffer.writeUInt8(MessageType.POSITION_DELTA, offset);
  offset += 1;

  buffer.writeUInt16LE(update.runnerId, offset);
  offset += 2;

  buffer.writeFloatLE(update.lat, offset);
  offset += 4;

  buffer.writeFloatLE(update.lng, offset);
  offset += 4;

  buffer.writeUInt32LE(update.distance, offset);
  offset += 4;

  buffer.writeUInt16LE(Math.round(update.pace * 10), offset);
  offset += 2;

  buffer.writeUInt16LE(update.heading, offset);
  offset += 2;

  buffer.writeUInt16LE(update.sequence, offset);
  offset += 2;

  buffer.writeUInt32LE(update.timestamp, offset);
  offset += 4;

  return buffer;
}

// ═══════════════════════════════════════════════════════════
// DECODER: RUNNER UPDATE (Client → Server)
// ═══════════════════════════════════════════════════════════

/**
 * Decode runner position update from client
 * Format: 28 bytes
 */
function decodeRunnerUpdate(buffer) {
  let offset = 1; // Skip message type

  return {
    lat: buffer.readFloatLE(offset), offset: (offset += 4),
    lng: buffer.readFloatLE(offset += 0), offset: (offset += 4),
    distance: buffer.readUInt32LE(offset += 0), offset: (offset += 4),
    pace: buffer.readUInt16LE(offset += 0) / 10.0, offset: (offset += 2),
    heading: buffer.readUInt16LE(offset += 0), offset: (offset += 2),
    status: buffer.readUInt8(offset += 0)
  };
}

// ═══════════════════════════════════════════════════════════
// ENCODER: SNAPSHOT (Server → Client, on join)
// ═══════════════════════════════════════════════════════════

/**
 * Encode full race snapshot for instant fill
 * Format: Header (13 bytes) + (28 bytes × numRunners)
 */
function encodeSnapshot(data) {
  const runnerCount = data.runners.length;
  const buffer = Buffer.alloc(13 + (runnerCount * 28));
  let offset = 0;

  // Header
  buffer.writeUInt8(MessageType.SNAPSHOT, offset);
  offset += 1;

  buffer.writeBigUInt64LE(BigInt(data.serverTime), offset);
  offset += 8;

  buffer.writeUInt32LE(runnerCount, offset);
  offset += 4;

  // Runners
  data.runners.forEach(runner => {
    buffer.writeUInt16LE(runner.uid, offset);
    offset += 2;

    buffer.writeFloatLE(runner.lat, offset);
    offset += 4;

    buffer.writeFloatLE(runner.lng, offset);
    offset += 4;

    buffer.writeUInt32LE(runner.dist, offset);
    offset += 4;

    buffer.writeUInt16LE(Math.round(runner.pace * 10), offset);
    offset += 2;

    buffer.writeUInt16LE(runner.hdg, offset);
    offset += 2;

    buffer.writeUInt8(runner.status, offset);
    offset += 1;

    // Padding for alignment
    buffer.writeUInt8(0, offset);
    offset += 1;

    buffer.writeUInt32LE(runner.colorIndex || 0, offset);
    offset += 4;

    buffer.writeUInt32LE(runner.position || 0, offset);
    offset += 4;
  });

  return buffer;
}

// ═══════════════════════════════════════════════════════════
// DECODER: SET INTEREST (Client → Server)
// ═══════════════════════════════════════════════════════════

function decodeSetInterest(data) {
  try {
    return JSON.parse(data);
  } catch (err) {
    console.error('Failed to decode SET_INTEREST:', err);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// ENCODER: LEADERBOARD (Server → Client)
// ═══════════════════════════════════════════════════════════

/**
 * Encode top 10 leaderboard (server-authoritative)
 * Format: 1 byte type + (6 bytes × 10 leaders)
 */
function encodeLeaderboard(leaders) {
  const buffer = Buffer.alloc(1 + (leaders.length * 6));
  let offset = 0;

  buffer.writeUInt8(MessageType.LEADERBOARD, offset);
  offset += 1;

  leaders.forEach(leader => {
    buffer.writeUInt16LE(leader.uid, offset);
    offset += 2;

    buffer.writeUInt32LE(leader.distance, offset);
    offset += 4;
  });

  return buffer;
}

// ═══════════════════════════════════════════════════════════
// ENCODER: TIER CHANGE (Server → Client)
// ═══════════════════════════════════════════════════════════

function encodeTierChange(change) {
  const buffer = Buffer.alloc(8);
  let offset = 0;

  buffer.writeUInt8(MessageType.TIER_CHANGE, offset);
  offset += 1;

  buffer.writeUInt16LE(change.runnerId, offset);
  offset += 2;

  buffer.writeUInt8(change.oldTier, offset);
  offset += 1;

  buffer.writeUInt8(change.newTier, offset);
  offset += 1;

  buffer.writeUInt16LE(TierUpdateRate[change.newTier], offset);
  offset += 2;

  return buffer;
}

// ═══════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════

module.exports = {
  MessageType,
  Tier,
  TierUpdateRate,
  encodePositionDelta,
  decodeRunnerUpdate,
  encodeSnapshot,
  decodeSetInterest,
  encodeLeaderboard,
  encodeTierChange
};
