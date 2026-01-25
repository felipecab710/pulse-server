/**
 * TIER MANAGER - Multi-fidelity interest management
 * This is the CORE INNOVATION of SEVN Pulse
 */

const { Tier, TierUpdateRate } = require('../protocol/messages');

class TierManager {
  constructor() {
    this.clientInterests = new Map(); // clientId → InterestProfile
    this.runnerTiers = new Map();     // runnerId → Map<clientId, tier>
  }

  /**
   * Set client interest profile
   */
  setInterest(clientId, profile) {
    this.clientInterests.set(clientId, {
      focus: profile.focus,
      targetRunnerIds: profile.targetRunnerIds || [],
      viewport: profile.viewport || null,
      pinnedRunners: profile.pinnedRunners || []
    });

    console.log(`🎯 Client ${clientId} interest: ${profile.focus}`);
  }

  /**
   * Calculate tier for a specific runner from a spectator's perspective
   */
  calculateTier(runnerId, clientId, raceState, spectatorPosition = null) {
    const runner = raceState.runners.get(runnerId);
    if (!runner) return Tier.LOW;

    const interest = this.clientInterests.get(clientId);
    if (!interest) return Tier.HIGH; // Default to HIGH for clients without explicit interest (MVP)

    // ═══════════════════════════════════════════════════════
    // TIER 1: ULTRA-HIGH FIDELITY (5Hz)
    // ═══════════════════════════════════════════════════════

    // Priority 1: Explicitly pinned
    if (interest.pinnedRunners.includes(runnerId)) {
      return Tier.ULTRA_HIGH;
    }

    // Priority 2: Top 10 leaders
    if (runner.position && runner.position <= 10) {
      return Tier.ULTRA_HIGH;
    }

    // Priority 3: Sprint finish mode (last 500m for top 20)
    if (raceState.totalDistance && runner.distance) {
      const distanceRemaining = raceState.totalDistance - runner.distance;
      if (distanceRemaining < 500 && runner.position <= 20) {
        return Tier.ULTRA_HIGH;
      }
    }

    // Priority 4: Following specific runners
    if (interest.focus === 'FOLLOW' && interest.targetRunnerIds.includes(runnerId)) {
      return Tier.ULTRA_HIGH;
    }

    // ═══════════════════════════════════════════════════════
    // TIER 2: HIGH FIDELITY (2Hz)
    // ═══════════════════════════════════════════════════════

    // Nearby runners (viewport-based)
    if (interest.viewport && runner.lat && runner.lng) {
      const distance = this.haversine(
        runner.lat,
        runner.lng,
        interest.viewport.center.lat,
        interest.viewport.center.lng
      );

      if (distance < interest.viewport.radius || distance < 500) {
        return Tier.HIGH;
      }
    }

    // Top 30 leaders (even if not top 10)
    if (runner.position && runner.position <= 30) {
      return Tier.HIGH;
    }

    // ═══════════════════════════════════════════════════════
    // TIER 3: MEDIUM FIDELITY (1Hz)
    // ═══════════════════════════════════════════════════════

    // Mid-distance from viewport
    if (interest.viewport && runner.lat && runner.lng) {
      const distance = this.haversine(
        runner.lat,
        runner.lng,
        interest.viewport.center.lat,
        interest.viewport.center.lng
      );

      if (distance < 2000) {
        return Tier.MEDIUM;
      }
    }

    // Mid-pack runners
    if (runner.position && runner.position <= 100) {
      return Tier.MEDIUM;
    }

    // ═══════════════════════════════════════════════════════
    // TIER 4: LOW FIDELITY (0.2-0.5Hz)
    // ═══════════════════════════════════════════════════════

    // Default: distant field
    return Tier.LOW;
  }

  /**
   * Get all runners for a client, grouped by tier
   */
  getTiersForClient(clientId, raceState) {
    const tiers = {
      [Tier.ULTRA_HIGH]: [],
      [Tier.HIGH]: [],
      [Tier.MEDIUM]: [],
      [Tier.LOW]: []
    };

    raceState.runners.forEach((runner, runnerId) => {
      const tier = this.calculateTier(runnerId, clientId, raceState);
      tiers[tier].push(runnerId);
    });

    return tiers;
  }

  /**
   * Update tier assignments and detect changes
   */
  updateTiers(clientId, raceState) {
    const changes = [];
    const newTiers = this.getTiersForClient(clientId, raceState);

    // Get or create runner tier map for this client
    if (!this.runnerTiers.has(clientId)) {
      this.runnerTiers.set(clientId, new Map());
    }

    const clientTiers = this.runnerTiers.get(clientId);

    // Check for tier changes
    Object.entries(newTiers).forEach(([tier, runnerIds]) => {
      runnerIds.forEach(runnerId => {
        const oldTier = clientTiers.get(runnerId);
        const newTier = parseInt(tier);

        if (oldTier !== undefined && oldTier !== newTier) {
          changes.push({
            runnerId,
            oldTier,
            newTier
          });
        }

        clientTiers.set(runnerId, newTier);
      });
    });

    return { tiers: newTiers, changes };
  }

  /**
   * Get update interval for a runner-client pair
   */
  getUpdateInterval(runnerId, clientId) {
    if (!this.runnerTiers.has(clientId)) {
      const defaultInterval = TierUpdateRate[Tier.HIGH];
      console.log(`⚠️ Client ${clientId} has no tier map, returning default: ${defaultInterval}ms`);
      return defaultInterval;
    }

    const tier = this.runnerTiers.get(clientId).get(runnerId);
    const interval = TierUpdateRate[tier] || TierUpdateRate[Tier.HIGH];
    console.log(`🕐 Client ${clientId} tier for runner ${runnerId}: ${tier} → ${interval}ms`);
    return interval;
  }

  /**
   * Should send update to client? (Throttling based on tier)
   */
  shouldSendUpdate(runnerId, clientId, lastSentTime) {
    const interval = this.getUpdateInterval(runnerId, clientId);
    const now = Date.now();
    return (now - lastSentTime) >= interval;
  }

  /**
   * Pin runner for ultra-high fidelity
   */
  pinRunner(clientId, runnerId) {
    const interest = this.clientInterests.get(clientId);
    if (interest) {
      if (!interest.pinnedRunners.includes(runnerId)) {
        interest.pinnedRunners.push(runnerId);
        console.log(`📌 Client ${clientId} pinned runner ${runnerId}`);
      }
    }
  }

  /**
   * Unpin runner
   */
  unpinRunner(clientId, runnerId) {
    const interest = this.clientInterests.get(clientId);
    if (interest) {
      interest.pinnedRunners = interest.pinnedRunners.filter(id => id !== runnerId);
      console.log(`📌 Client ${clientId} unpinned runner ${runnerId}`);
    }
  }

  /**
   * Remove client
   */
  removeClient(clientId) {
    this.clientInterests.delete(clientId);
    this.runnerTiers.delete(clientId);
  }

  /**
   * Get stats for debugging
   */
  getStats() {
    const stats = {
      totalClients: this.clientInterests.size,
      tierDistribution: {
        [Tier.ULTRA_HIGH]: 0,
        [Tier.HIGH]: 0,
        [Tier.MEDIUM]: 0,
        [Tier.LOW]: 0
      }
    };

    this.runnerTiers.forEach(clientTiers => {
      clientTiers.forEach(tier => {
        stats.tierDistribution[tier]++;
      });
    });

    return stats;
  }

  /**
   * Haversine distance helper
   */
  haversine(lat1, lng1, lat2, lng2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lng2 - lng1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) *
      Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }
}

module.exports = TierManager;
