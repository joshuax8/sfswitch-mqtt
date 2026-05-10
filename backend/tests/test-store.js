const assert = require('assert');

// Test RingBuffer
console.log('Testing RingBuffer...');

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

// Test basic push
const rb = new RingBuffer(5);
assert.strictEqual(rb.push('a'), 1);
assert.strictEqual(rb.push('b'), 2);
assert.strictEqual(rb.size, 2);
assert.deepStrictEqual(rb.getAll(), ['a', 'b']);

// Test wrap-around
rb.push('c');
rb.push('d');
rb.push('e');
assert.strictEqual(rb.size, 5);
assert.deepStrictEqual(rb.getAll(), ['a', 'b', 'c', 'd', 'e']);

// Test eviction
rb.push('f');
assert.strictEqual(rb.size, 5);
assert.deepStrictEqual(rb.getAll(), ['b', 'c', 'd', 'e', 'f']);

// Test getLatest
assert.deepStrictEqual(rb.getLatest(2), ['e', 'f']);
assert.deepStrictEqual(rb.getLatest(10), ['b', 'c', 'd', 'e', 'f']);

console.log('RingBuffer tests passed!');

// Test ObserverTracker
console.log('\nTesting ObserverTracker...');

class ObserverTracker {
  constructor(timeoutSeconds = 10) {
    this.observers = new Map();
    this.timeoutMs = timeoutSeconds * 1000;
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

const ot = new ObserverTracker(10);

// Test new observer
const packet1 = { SNR: '10.5', RSSI: '-50' };
ot.update('Observer1', 'obs1', packet1);
assert.strictEqual(ot.count, 1);
const obs1 = ot.get('obs1');
assert.strictEqual(obs1.name, 'Observer1');
assert.strictEqual(obs1.packetCount, 1);
assert.strictEqual(ot.getStatus('obs1'), 'online');

// Test existing observer update
const packet2 = { SNR: '15.0', RSSI: '-45' };
ot.update('Observer1', 'obs1', packet2);
const obs1Updated = ot.get('obs1');
assert.strictEqual(obs1Updated.packetCount, 2);
assert.strictEqual(obs1Updated.maxSNR, 15.0);
assert.strictEqual(obs1Updated.maxRSSI, -45);

// Test degraded status
const packet3 = { SNR: '-15.0', RSSI: '-50' };
ot.update('Observer2', 'obs2', packet3);
assert.strictEqual(ot.getStatus('obs2'), 'degraded');

// Test offline status
const packet4 = { SNR: '5.0', RSSI: '-60' };
ot.update('Observer3', 'obs3', packet4);
const obs3 = ot.get('obs3');
obs3.lastSeen = Date.now() - 20000; // 20 seconds ago (timeout is 10 seconds)
assert.strictEqual(ot.getStatus('obs3'), 'offline');

console.log('ObserverTracker tests passed!');

// Test AggregationStore
console.log('\nTesting AggregationStore...');

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

    const observerKey = packet.origin_id;
    this.packetsPerObserver.set(
      observerKey,
      (this.packetsPerObserver.get(observerKey) || 0) + 1
    );

    const pt = packet.packet_type || 'unknown';
    this.packetTypes.set(pt, (this.packetTypes.get(pt) || 0) + 1);

    const rt = packet.route || 'unknown';
    this.routeTypes.set(rt, (this.routeTypes.get(rt) || 0) + 1);
  }

  getStats() {
    const now = Date.now();
    const elapsedMs = now - this.windowStart;
    const elapsedSec = elapsedMs / 1000;
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

const ag = new AggregationStore();

// Test aggregation
ag.update({ origin_id: 'obs1', packet_type: '0', route: 'F' });
ag.update({ origin_id: 'obs1', packet_type: '0', route: 'F' });
ag.update({ origin_id: 'obs2', packet_type: '2', route: 'D' });

const stats = ag.getStats();
assert.strictEqual(stats.totalPackets, 3);
assert.strictEqual(stats.packetsPerObserver.obs1, 2);
assert.strictEqual(stats.packetsPerObserver.obs2, 1);
assert.strictEqual(stats.packetTypes['0'], 2);
assert.strictEqual(stats.packetTypes['2'], 1);
assert.strictEqual(stats.routeTypes.F, 2);
assert.strictEqual(stats.routeTypes.D, 1);

// Test window reset
ag.resetWindow();
assert.strictEqual(ag.windowPackets, 0);

console.log('AggregationStore tests passed!');

// Test TopologyTracker
console.log('\nTesting TopologyTracker...');

class TopologyTracker {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
    this.observers = new Map();
  }

  updateFromPacket(packet) {
    if (!packet.raw) {
      return false;
    }

    try {
      const raw = Buffer.from(packet.raw, 'hex');
      if (raw.length < 2) return false;

      // Parse path_len byte (simplified - we're not using header byte yet)
      const pathLenByte = raw[1];
      const hashSize = (pathLenByte >> 6) + 1;
      const hashCount = pathLenByte & 0x3F;

      // Parse path hashes
      const pathHashes = [];
      let offset = 2;
      
      for (let i = 0; i < hashCount; i++) {
        const hashBytes = raw.slice(offset, offset + hashSize);
        const hash = hashBytes.toString('hex');
        pathHashes.push(hash);
        offset += hashSize;
      }

      // Map origin_id to first hash in path
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
}

const tt = new TopologyTracker();

// Test with a sample packet that has path data
// Raw format: [header:1] [path_len:1] [path hash 1] [path hash 2]...
// For testing, we'll create a fake raw hex with 2 hashes of size 1
// path_len byte: hash_size-1 in top 2 bits, count in bottom 6 bits
// For hashSize=1, count=2: path_len = (0 << 6) | 2 = 2 = 0x02
// Then 2 hashes of 1 byte each: 0x01, 0x02
// Total raw: 00 02 01 02 (but we need header byte first)
const testPacket = {
  origin_id: 'test-observer',
  raw: '00020102', // header=0x00, path_len=0x02, hash1=0x01, hash2=0x02
};

const result = tt.updateFromPacket(testPacket);
assert.strictEqual(result, true);
assert.strictEqual(tt.nodes.size, 2);
assert.strictEqual(tt.edges.size, 1);
assert.strictEqual(tt.observers.size, 1);

const topology = tt.getTopology();
assert.strictEqual(topology.nodes.length, 2);
assert.strictEqual(topology.edges.length, 1);
assert.strictEqual(topology.observers.length, 1);

// Check first node hash is '01'
assert.strictEqual(topology.nodes[0].hash, '01');
assert.strictEqual(topology.nodes[1].hash, '02');

// Check edge
assert.strictEqual(topology.edges[0].from, '01');
assert.strictEqual(topology.edges[0].to, '02');

console.log('TopologyTracker tests passed!');

// Test AlertManager
console.log('\nTesting AlertManager...');

class AlertManager {
  constructor() {
    this.alerts = new Map();
    this.alertCounter = 0;
    this.lastCheck = Date.now();
  }

  checkObservers(observers) {
    const now = Date.now();
    const snrThreshold = -10;
    const rssiThreshold = -90;
    const timeoutThreshold = 600 * 1000; // 10 minutes
    
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
      existing.lastUpdated = Date.now();
      existing.message = message;
      existing.details = details;
    } else {
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

const am = new AlertManager();

// Test with offline observer
const now = Date.now();
const offlineObserver = {
  originId: 'obs1',
  name: 'Offline Observer',
  lastSeen: now - 700000, // 11+ minutes ago
  packetCount: 5,
  totalSNR: 25, // avg 5 (above -10 threshold)
  totalRSSI: -250, // avg -50 (above -90 threshold)
};

const onlineObserver = {
  originId: 'obs2',
  name: 'Online Observer',
  lastSeen: now - 1000, // 1 second ago
  packetCount: 10,
  totalSNR: 50, // avg 5 (above -10 threshold)
  totalRSSI: -400, // avg -40 (above -90 threshold)
};

am.checkObservers([offlineObserver, onlineObserver]);

const alerts = am.getAlerts();
assert.strictEqual(alerts.length, 1); // Only offline alert for obs1
assert.strictEqual(alerts[0].type, 'Offline');
assert.strictEqual(alerts[0].originId, 'obs1');

// Test acknowledge
const ackResult = am.acknowledgeAlert(`offline-obs1`, 'test-user');
assert.strictEqual(ackResult, true);
assert.strictEqual(am.getActiveAlerts().length, 0);

// Test RSSI alert
const lowRSSIObserver = {
  originId: 'obs3',
  name: 'Low RSSI Observer',
  lastSeen: now,
  packetCount: 5,
  totalSNR: 25, // avg 5
  totalRSSI: -500, // avg -100 (below -90)
};

am.checkObservers([lowRSSIObserver]);
const rssiAlerts = am.getAlerts().filter(a => a.type === 'RSSI');
assert.strictEqual(rssiAlerts.length, 1);
assert.strictEqual(rssiAlerts[0].originId, 'obs3');

// Test acknowledge all
am.acknowledgeAll('admin');
assert.strictEqual(am.getActiveAlerts().length, 0);

console.log('AlertManager tests passed!');

console.log('\nAll store component tests passed!');
