/**
 * SPATIAL GRID - In-memory geo-indexing for fast nearby queries
 * Replaces Redis GEORADIUS to avoid CPU bomb at scale
 */

class SpatialGrid {
  constructor(rows = 16, cols = 16, bounds = null) {
    this.rows = rows;
    this.cols = cols;
    this.cells = new Map(); // cellId → Set<runnerId>
    this.positions = new Map(); // runnerId → { lat, lng, cellId }
    
    // Default bounds (will auto-adjust based on race route)
    this.bounds = bounds || {
      minLat: 25.7,
      maxLat: 25.8,
      minLng: -80.2,
      maxLng: -80.1
    };
  }

  /**
   * Get cell ID for a coordinate
   */
  getCellId(lat, lng) {
    const { minLat, maxLat, minLng, maxLng } = this.bounds;
    
    const row = Math.floor(
      ((lat - minLat) / (maxLat - minLat)) * this.rows
    );
    const col = Math.floor(
      ((lng - minLng) / (maxLng - minLng)) * this.cols
    );
    
    const clampedRow = Math.max(0, Math.min(row, this.rows - 1));
    const clampedCol = Math.max(0, Math.min(col, this.cols - 1));
    
    return `${clampedRow},${clampedCol}`;
  }

  /**
   * Update runner position in grid
   */
  update(runnerId, lat, lng) {
    // Remove from old cell
    const oldPos = this.positions.get(runnerId);
    if (oldPos) {
      const oldCell = this.cells.get(oldPos.cellId);
      if (oldCell) {
        oldCell.delete(runnerId);
        if (oldCell.size === 0) {
          this.cells.delete(oldPos.cellId);
        }
      }
    }

    // Add to new cell
    const newCellId = this.getCellId(lat, lng);
    if (!this.cells.has(newCellId)) {
      this.cells.set(newCellId, new Set());
    }
    this.cells.get(newCellId).add(runnerId);

    // Update position
    this.positions.set(runnerId, { lat, lng, cellId: newCellId });
  }

  /**
   * Get nearby runners within radius (meters)
   */
  getNearby(lat, lng, radiusMeters) {
    const cellId = this.getCellId(lat, lng);
    const [row, col] = cellId.split(',').map(Number);
    
    // Calculate cell search radius
    const latPerCell = (this.bounds.maxLat - this.bounds.minLat) / this.rows;
    const lngPerCell = (this.bounds.maxLng - this.bounds.minLng) / this.cols;
    const metersPerDegree = 111000; // Rough approximation
    const cellRadius = Math.ceil(
      radiusMeters / metersPerDegree / Math.min(latPerCell, lngPerCell)
    );
    
    const nearby = new Set();
    
    // Check surrounding cells
    for (let r = row - cellRadius; r <= row + cellRadius; r++) {
      for (let c = col - cellRadius; c <= col + cellRadius; c++) {
        if (r >= 0 && r < this.rows && c >= 0 && c < this.cols) {
          const checkCellId = `${r},${c}`;
          const cell = this.cells.get(checkCellId);
          
          if (cell) {
            cell.forEach(runnerId => {
              const pos = this.positions.get(runnerId);
              if (pos && this.distance(lat, lng, pos.lat, pos.lng) <= radiusMeters) {
                nearby.add(runnerId);
              }
            });
          }
        }
      }
    }
    
    return Array.from(nearby);
  }

  /**
   * Get all runners in grid
   */
  getAllRunners() {
    return Array.from(this.positions.keys());
  }

  /**
   * Remove runner from grid
   */
  remove(runnerId) {
    const pos = this.positions.get(runnerId);
    if (pos) {
      const cell = this.cells.get(pos.cellId);
      if (cell) {
        cell.delete(runnerId);
        if (cell.size === 0) {
          this.cells.delete(pos.cellId);
        }
      }
      this.positions.delete(runnerId);
    }
  }

  /**
   * Haversine distance (meters)
   */
  distance(lat1, lng1, lat2, lng2) {
    const R = 6371e3; // Earth radius in meters
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

  /**
   * Auto-adjust bounds to fit all runners
   */
  adjustBounds() {
    if (this.positions.size === 0) return;

    let minLat = Infinity, maxLat = -Infinity;
    let minLng = Infinity, maxLng = -Infinity;

    this.positions.forEach(pos => {
      minLat = Math.min(minLat, pos.lat);
      maxLat = Math.max(maxLat, pos.lat);
      minLng = Math.min(minLng, pos.lng);
      maxLng = Math.max(maxLng, pos.lng);
    });

    // Add 20% padding
    const latPadding = (maxLat - minLat) * 0.2;
    const lngPadding = (maxLng - minLng) * 0.2;

    this.bounds = {
      minLat: minLat - latPadding,
      maxLat: maxLat + latPadding,
      minLng: minLng - lngPadding,
      maxLng: maxLng + lngPadding
    };

    console.log('📐 Grid bounds adjusted:', this.bounds);
  }

  /**
   * Get grid stats for debugging
   */
  getStats() {
    return {
      totalRunners: this.positions.size,
      totalCells: this.cells.size,
      avgRunnersPerCell: this.positions.size / Math.max(this.cells.size, 1),
      bounds: this.bounds
    };
  }
}

module.exports = SpatialGrid;
