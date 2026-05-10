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
    const now = Date.now();
    const elapsedMs = now - this.windowStart;
    const elapsedSec = elapsedMs / 1000;
    // Calculate packets per second in current window
    const packetsPerSecond = elapsedSec > 0 ? this.windowPackets / elapsedSec : 0;
    return {
      totalPackets: this.totalPackets,
      packetsPerObserver: Object.fromEntries(this.packetsPerObserver),
      packetTypes: Object.fromEntries(this.packetTypes),
      routeTypes: Object.fromEntries(this.routeTypes),
      windowPackets: this.windowPackets,
      packetsPerSecond: parseFloat(packetsPerSecond.toFixed(2)),
      windowElapsed: parseFloat(elapsedSec.toFixed(2)),
    };
  }

  resetWindow() {
    this.windowPackets = 0;
    this.windowStart = Date.now();
  }
}

/**
 * Alert Manager
 * Tracks and manages alerts for observers based on configurable thresholds
 */
class AlertManager {
  constructor() {
    this.config = config;
    this.alerts = new Map(); // alertId -> alert
    this.alertCounter = 0;
    this.lastCheck = Date.now();
  }

  checkObservers(observers) {
    const now = Date.now();
    const snrThreshold = this.config.ALERT_SNR_THRESHOLD;
    const rssiThreshold = this.config.ALERT_RSSI_THRESHOLD;
    const timeoutThreshold = this.config.ALERT_OBSERVER_TIMEOUT * 1000;
    
    observers.forEach(observer => {
      const avgSNR = observer.totalSNR / observer.packetCount;
      const avgRSSI = observer.totalRSSI / observer.packetCount;
      const isOffline = now - observer.lastSeen > timeoutThreshold;
      
      // Check for SNR alert
      if (avgSNR < snrThreshold) {
        this._createOrUpdateAlert(
          `snr-${observer.originId}`,
          'SNR',
          'warning',
          `Observer ${observer.name} has low SNR: ${avgSNR.toFixed(1)} dB`,
          observer.originId,
          { type: 'SNR', value: avgSNR, threshold: snrThreshold }
        );
      } else {
        this._clearAlert(`snr-${observer.originId}`);
      }
      
      // Check for RSSI alert
      if (avgRSSI < rssiThreshold) {
        this._createOrUpdateAlert(
          `rssi-${observer.originId}`,
          'RSSI',
          'warning',
          `Observer ${observer.name} has low RSSI: ${avgRSSI} dBm`,
          observer.originId,
          { type: 'RSSI', value: avgRSSI, threshold: rssiThreshold }
        );
      } else {
        this._clearAlert(`rssi-${observer.originId}`);
      }
      
      // Check for offline alert
      if (isOffline) {
        this._createOrUpdateAlert(
          `offline-${observer.originId}`,
          'Offline',
          'critical',
          `Observer ${observer.name} is offline (last seen: ${new Date(observer.lastSeen).toISOString()})`,
          observer.originId,
          { type: 'offline', lastSeen: observer.lastSeen }
        );
      } else {
        this._clearAlert(`offline-${observer.originId}`);
      }
    });
    
    this.lastCheck = now;
    return this.getAlerts();
  }

  _createOrUpdateAlert(id, type, severity, message, originId, details) {
    const existing = this.alerts.get(id);
    
    if (existing) {
      // Update existing alert
      existing.lastUpdated = Date.now();
      existing.message = message;
      existing.details = details;
    } else {
      // Create new alert
      this.alertCounter++;
      this.alerts.set(id, {
        id,
        alertId: this.alertCounter,
        type,
        severity,
        message,
        originId,
        details,
        createdAt: Date.now(),
        lastUpdated: Date.now(),
        acknowledged: false,
        acknowledgedAt: null,
        acknowledgedBy: null,
      });
    }
  }

  _clearAlert(id) {
    this.alerts.delete(id);
  }

  getAlerts() {
    return Array.from(this.alerts.values()).map(a => ({
      ...a,
      createdAt: new Date(a.createdAt).toISOString(),
      lastUpdated: new Date(a.lastUpdated).toISOString(),
    }));
  }

  getActiveAlerts() {
    return this.getAlerts().filter(a => !a.acknowledged);
  }

  getAlert(id) {
    const alert = this.alerts.get(id);
    if (alert) {
      return {
        ...alert,
        createdAt: new Date(alert.createdAt).toISOString(),
        lastUpdated: new Date(alert.lastUpdated).toISOString(),
      };
    }
    return null;
  }

  acknowledgeAlert(id, by = 'system') {
    const alert = this.alerts.get(id);
    if (alert) {
      alert.acknowledged = true;
      alert.acknowledgedAt = Date.now();
      alert.acknowledgedBy = by;
      return true;
    }
    return false;
  }

  acknowledgeAll(by = 'system') {
    for (const [id, alert] of this.alerts) {
      alert.acknowledged = true;
      alert.acknowledgedAt = Date.now();
      alert.acknowledgedBy = by;
    }
    return this.alerts.size;
  }

  clearAll() {
    this.alerts.clear();
  }

  get count() {
    return this.alerts.size;
  }

  get activeCount() {
    return this.getActiveAlerts().length;
  }
}

/**
 * Topology Tracker
 * Extracts network topology from MeshCore packet paths
 */
class TopologyTracker {
  constructor() {
    this.nodes = new Map(); // hash -> node info
    this.edges = new Map(); // "hash1->hash2" -> edge info
    this.observers = new Map(); // origin_id -> observer node hash
  }

  updateFromPacket(packet) {
    if (!packet.raw || !config.PARSE_RAW_PACKETS) {
      return false;
    }

    try {
      const raw = Buffer.from(packet.raw, 'hex');
      if (raw.length < 2) return false;

      // Parse header byte
      const header = raw[0];
      const routeType = header & 0x03;
      const payloadType = (header >> 2) & 0x0F;
      const payloadVersion = (header >> 6) & 0x03;

      // Parse path_len byte
      const pathLenByte = raw[1];
      const hashSize = (pathLenByte >> 6) + 1; // 1-3 bytes
      const hashCount = pathLenByte & 0x3F; // 0-63 hashes

      // Parse path hashes
      const pathHashes = [];
      let offset = 2; // After header + path_len
      
      for (let i = 0; i < hashCount; i++) {
        const hashBytes = raw.slice(offset, offset + hashSize);
        const hash = hashBytes.toString('hex');
        pathHashes.push(hash);
        offset += hashSize;
      }

      // Map origin_id to first hash in path (or observer's own hash)
      if (pathHashes.length > 0) {
        this.observers.set(packet.origin_id, pathHashes[0]);
      }

      // Register all nodes in path
      for (const hash of pathHashes) {
        if (!this.nodes.has(hash)) {
          this.nodes.set(hash, {
            hash,
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            packetCount: 0,
          });
        }
        const node = this.nodes.get(hash);
        node.lastSeen = Date.now();
        node.packetCount++;
      }

      // Register edges between consecutive nodes in path
      for (let i = 0; i < pathHashes.length - 1; i++) {
        const from = pathHashes[i];
        const to = pathHashes[i + 1];
        const edgeKey = `${from}->${to}`;
        
        if (!this.edges.has(edgeKey)) {
          this.edges.set(edgeKey, {
            from,
            to,
            count: 0,
            lastSeen: Date.now(),
          });
        }
        const edge = this.edges.get(edgeKey);
        edge.count++;
        edge.lastSeen = Date.now();
      }

      return true;
    } catch (err) {
      console.error('Error parsing topology:', err.message);
      return false;
    }
  }

  getTopology() {
    return {
      nodes: Array.from(this.nodes.values()).map(n => ({
        ...n,
        lastSeen: new Date(n.lastSeen).toISOString(),
      })),
      edges: Array.from(this.edges.values()).map(e => ({
        ...e,
        lastSeen: new Date(e.lastSeen).toISOString(),
      })),
      observers: Array.from(this.observers.entries()).map(([originId, hash]) => ({
        originId,
        hash,
      })),
    };
  }

  getNode(hash) {
    return this.nodes.get(hash);
  }

  cleanup(staleMs = 3600000) { // 1 hour
    const now = Date.now();
    
    // Remove stale nodes
    for (const [hash, node] of this.nodes) {
      if (now - node.lastSeen > staleMs) {
        this.nodes.delete(hash);
      }
    }
    
    // Remove stale edges
    for (const [key, edge] of this.edges) {
      if (now - edge.lastSeen > staleMs) {
        this.edges.delete(key);
      }
    }
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
    this.topologyTracker = new TopologyTracker();
    this.alertManager = new AlertManager();
    
    // SQLite persistence
    this.db = null;
    this._initDb();
    
    // Window reset interval
    this.windowInterval = setInterval(
      () => this.aggregationStore.resetWindow(),
      config.AGGREGATION_WINDOW * 1000
    );
    
    // Alert check interval
    this.alertInterval = setInterval(
      () => {
        const observers = this.observerTracker.getAll();
        this.alertManager.checkObservers(observers);
      },
      config.ALERT_CHECK_INTERVAL * 1000
    );
    
    // Cleanup interval
    this.cleanupInterval = setInterval(
      () => {
        this.observerTracker.cleanup();
        if (config.PARSE_RAW_PACKETS) {
          this.topologyTracker.cleanup();
        }
      },
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
      
      // Time-series history tables
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS history_packets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp DATETIME NOT NULL,
          value REAL NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS history_observers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp DATETIME NOT NULL,
          value INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS history_buffer (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp DATETIME NOT NULL,
          value INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_history_packets_ts ON history_packets(timestamp)
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_history_observers_ts ON history_observers(timestamp)
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_history_buffer_ts ON history_buffer(timestamp)
      `);
      
      // Clean up old history data (keep last 12 hours)
      const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      this.db.exec(`DELETE FROM history_packets WHERE timestamp < ?`, [twelveHoursAgo]);
      this.db.exec(`DELETE FROM history_observers WHERE timestamp < ?`, [twelveHoursAgo]);
      this.db.exec(`DELETE FROM history_buffer WHERE timestamp < ?`, [twelveHoursAgo]);
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
    
    // Update topology tracker (optional, only if parsing enabled)
    if (config.PARSE_RAW_PACKETS) {
      this.topologyTracker.updateFromPacket(packet);
    }
    
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

  // Save history data point
  saveHistory(type, timestamp, value) {
    if (!this.db) return;
    try {
      let table;
      switch(type) {
        case 'packets': table = 'history_packets'; break;
        case 'observers': table = 'history_observers'; break;
        case 'buffer': table = 'history_buffer'; break;
        default: return;
      }
      const stmt = this.db.prepare(`INSERT INTO ${table} (timestamp, value) VALUES (?, ?)`);
      stmt.run(timestamp, value);
    } catch (err) {
      console.error('History save error:', err.message);
    }
  }

  // Get history data for a time range
  getHistory(type, hours = 12) {
    if (!this.db) return [];
    try {
      let table;
      switch(type) {
        case 'packets': table = 'history_packets'; break;
        case 'observers': table = 'history_observers'; break;
        case 'buffer': table = 'history_buffer'; break;
        default: return [];
      }
      const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      const stmt = this.db.prepare(`SELECT timestamp, value FROM ${table} WHERE timestamp >= ? ORDER BY timestamp ASC`);
      const rows = stmt.all(cutoff);
      return rows.map(r => ({ timestamp: r.timestamp, value: r.value }));
    } catch (err) {
      console.error('History fetch error:', err.message);
      return [];
    }
  }

  getHealth() {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      packetsStored: this.ringBuffer.size,
      observersTracked: this.observerTracker.count,
      dbConnected: this.db !== null,
      topologyEnabled: config.PARSE_RAW_PACKETS,
      alertsActive: this.alertManager.activeCount,
      alertsTotal: this.alertManager.count,
    };
  }

  getTopology() {
    if (!config.PARSE_RAW_PACKETS) {
      return {
        error: 'Topology tracking disabled. Set PARSE_RAW_PACKETS=true in .env',
        nodes: [],
        edges: [],
        observers: [],
      };
    }
    return this.topologyTracker.getTopology();
  }

  // Alert methods
  getAlerts() {
    return this.alertManager.getAlerts();
  }

  getActiveAlerts() {
    return this.alertManager.getActiveAlerts();
  }

  getAlert(id) {
    return this.alertManager.getAlert(id);
  }

  acknowledgeAlert(id, by = 'system') {
    return this.alertManager.acknowledgeAlert(id, by);
  }

  acknowledgeAllAlerts(by = 'system') {
    return this.alertManager.acknowledgeAll(by);
  }

  close() {
    clearInterval(this.windowInterval);
    clearInterval(this.alertInterval);
    clearInterval(this.cleanupInterval);
    if (this.db) {
      this.db.close();
    }
  }
}

// Singleton instance
const store = new DataStore();

module.exports = store;
