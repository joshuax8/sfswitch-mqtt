const Database = require('better-sqlite3');
const config = require('./config');

/**
 * Ring Buffer for storing packets
 * O(1) insert and eviction
 */
class RingBuffer {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.buffer = new Array(maxSize);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }

  push(item) {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.maxSize;
    if (this.count < this.maxSize) {
      this.count++;
    } else {
      this.tail = (this.tail + 1) % this.maxSize;
    }
    return this.count;
  }

  getAll() {
    const result = [];
    if (this.count === 0) return result;
    
    if (this.tail < this.head) {
      for (let i = this.tail; i < this.head; i++) {
        result.push(this.buffer[i]);
      }
    } else {
      for (let i = this.tail; i < this.maxSize; i++) {
        result.push(this.buffer[i]);
      }
      for (let i = 0; i < this.head; i++) {
        result.push(this.buffer[i]);
      }
    }
    return result;
  }

  getLatest(n) {
    const all = this.getAll();
    return all.slice(-n);
  }

  get size() {
    return this.count;
  }
}

/**
 * Observer tracking
 */
class ObserverTracker {
  constructor(timeoutSeconds = 300) {
    this.observers = new Map(); // origin_id -> observer data
    this.timeoutMs = timeoutSeconds * 1000;
    this.lastCleanup = Date.now();
  }

  update(origin, originId, packet) {
    const now = Date.now();
    const snr = parseFloat(packet.SNR) || 0;
    const rssi = parseInt(packet.RSSI) || 0;
    
    let observer = this.observers.get(originId);
    if (!observer) {
      observer = {
        originId,
        name: origin,
        firstSeen: now,
        lastSeen: now,
        packetCount: 0,
        totalSNR: 0,
        totalRSSI: 0,
        minSNR: snr,
        maxSNR: snr,
        minRSSI: rssi,
        maxRSSI: rssi,
      };
      this.observers.set(originId, observer);
    }

    observer.lastSeen = now;
    observer.packetCount++;
    observer.totalSNR += snr;
    observer.totalRSSI += rssi;
    observer.minSNR = Math.min(observer.minSNR, snr);
    observer.maxSNR = Math.max(observer.maxSNR, snr);
    observer.minRSSI = Math.min(observer.minRSSI, rssi);
    observer.maxRSSI = Math.max(observer.maxRSSI, rssi);

    return observer;
  }

  get(originId) {
    return this.observers.get(originId);
  }

  getAll() {
    return Array.from(this.observers.values());
  }

  getStatus(originId) {
    const observer = this.observers.get(originId);
    if (!observer) return 'offline';
    
    const now = Date.now();
    if (now - observer.lastSeen > this.timeoutMs) {
      return 'offline';
    }
    
    // Degraded if SNR is consistently low or RSSI is poor
    const avgSNR = observer.totalSNR / observer.packetCount;
    const avgRSSI = observer.totalRSSI / observer.packetCount;
    
    if (avgSNR < -10 || avgRSSI < -90) {
      return 'degraded';
    }
    
    return 'online';
  }

  cleanup() {
    const now = Date.now();
    const timeout = this.timeoutMs;
    
    for (const [originId, observer] of this.observers) {
      if (now - observer.lastSeen > timeout) {
        this.observers.delete(originId);
      }
    }
  }

  get count() {
    return this.observers.size;
  }
}

/**
 * Aggregation Store for statistics
 */
class AggregationStore {
  constructor() {
    this.totalPackets = 0;
    this.packetsPerObserver = new Map();
    this.packetTypes = new Map();
    this.routeTypes = new Map();
    this.windowStart = Date.now();
    this.windowPackets = 0;
  }

  update(packet) {
    this.totalPackets++;
    this.windowPackets++;

    // Per observer count
    const observerKey = packet.origin_id;
    this.packetsPerObserver.set(
      observerKey,
      (this.packetsPerObserver.get(observerKey) || 0) + 1
    );

    // Packet type count
    const pt = packet.packet_type || 'unknown';
    this.packetTypes.set(pt, (this.packetTypes.get(pt) || 0) + 1);

    // Route type count
    const rt = packet.route || 'unknown';
    this.routeTypes.set(rt, (this.routeTypes.get(rt) || 0) + 1);
  }

  getStats() {
    return {
      totalPackets: this.totalPackets,
      packetsPerObserver: Object.fromEntries(this.packetsPerObserver),
      packetTypes: Object.fromEntries(this.packetTypes),
      routeTypes: Object.fromEntries(this.routeTypes),
      windowPackets: this.windowPackets,
    };
  }

  resetWindow() {
    this.windowPackets = 0;
    this.windowStart = Date.now();
  }
}

/**
 * Main Data Store
 * Combines ring buffer, observer tracking, and aggregations
 */
class DataStore {
  constructor() {
    this.config = config;
    this.ringBuffer = new RingBuffer(config.PACKET_BUFFER_SIZE);
    this.observerTracker = new ObserverTracker(config.OBSERVER_TIMEOUT);
    this.aggregationStore = new AggregationStore();
    
    // SQLite persistence
    this.db = null;
    this._initDb();
    
    // Window reset interval
    this.windowInterval = setInterval(
      () => this.aggregationStore.resetWindow(),
      config.AGGREGATION_WINDOW * 1000
    );
    
    // Cleanup interval
    this.cleanupInterval = setInterval(
      () => this.observerTracker.cleanup(),
      config.OBSERVER_TIMEOUT * 1000
    );
  }

  _initDb() {
    try {
      this.db = new Database(config.PERSISTENCE_FILE);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS packets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          origin TEXT NOT NULL,
          origin_id TEXT NOT NULL,
          packet_type TEXT,
          route TEXT,
          snr REAL,
          rssi INTEGER,
          raw TEXT,
          hash TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_origin_id ON packets(origin_id)
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_timestamp ON packets(timestamp)
      `);
    } catch (err) {
      console.error('SQLite initialization failed, running in-memory only:', err.message);
      this.db = null;
    }
  }

  addPacket(packet) {
    // Add to ring buffer
    this.ringBuffer.push(packet);
    
    // Update aggregations
    this.aggregationStore.update(packet);
    
    // Update observer tracker
    this.observerTracker.update(packet.origin, packet.origin_id, packet);
    
    // Persist to SQLite (fire and forget - don't block hot path)
    if (this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO packets (timestamp, origin, origin_id, packet_type, route, snr, rssi, raw, hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          packet.timestamp,
          packet.origin,
          packet.origin_id,
          packet.packet_type,
          packet.route,
          parseFloat(packet.SNR),
          parseInt(packet.RSSI),
          packet.raw,
          packet.hash
        );
      } catch (err) {
        // Non-critical: log and continue
        console.error('SQLite insert error:', err.message);
      }
    }
    
    return this.ringBuffer.size;
  }

  getPackets(limit = 100) {
    return this.ringBuffer.getLatest(limit);
  }

  getObserver(originId) {
    return this.observerTracker.get(originId);
  }

  getAllObservers() {
    return this.observerTracker.getAll().map(obs => ({
      ...obs,
      avgSNR: obs.packetCount > 0 ? obs.totalSNR / obs.packetCount : 0,
      avgRSSI: obs.packetCount > 0 ? obs.totalRSSI / obs.packetCount : 0,
      status: this.observerTracker.getStatus(obs.originId),
    }));
  }

  getStats() {
    return {
      ...this.aggregationStore.getStats(),
      bufferSize: this.ringBuffer.size,
      bufferCapacity: this.ringBuffer.maxSize,
      observerCount: this.observerTracker.count,
    };
  }

  getHealth() {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      packetsStored: this.ringBuffer.size,
      observersTracked: this.observerTracker.count,
      dbConnected: this.db !== null,
    };
  }

  close() {
    clearInterval(this.windowInterval);
    clearInterval(this.cleanupInterval);
    if (this.db) {
      this.db.close();
    }
  }
}

// Singleton instance
const store = new DataStore();

module.exports = store;
