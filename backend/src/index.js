const http = require('http');
const { WebSocketServer } = require('ws');
const config = require('./config');
const store = require('./store');
const mqttClient = require('./mqtt');

// Create HTTP server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  // Health endpoint
  if (url.pathname === '/health') {
    const health = {
      backend: store.getHealth(),
      mqtt: mqttClient.getStatus(),
      timestamp: new Date().toISOString(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health, null, 2));
    return;
  }

  // API routes
  if (url.pathname.startsWith('/api/')) {
    handleApiRequest(req, res, url);
    return;
  }

  // Not found
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

function handleApiRequest(req, res, url) {
  try {
    const path = url.pathname;
    
    if (path === '/api/packets') {
      const limit = parseInt(url.searchParams.get('limit')) || 100;
      const packets = store.getPackets(limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(packets));
      return;
    }

    if (path === '/api/stats') {
      const stats = store.getStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
      return;
    }

    if (path === '/api/history') {
      const type = url.searchParams.get('type'); // 'packets', 'observers', 'buffer'
      const hours = parseInt(url.searchParams.get('hours')) || 12;
      if (!type || !['packets', 'observers', 'buffer'].includes(type)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid type. Use: packets, observers, buffer' }));
        return;
      }
      const history = store.getHistory(type, hours);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(history));
      return;
    }

    if (path === '/api/observers') {
      const observers = store.getAllObservers();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(observers));
      return;
    }

    if (path === '/api/observer') {
      const originId = url.searchParams.get('id');
      if (!originId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing observer id' }));
        return;
      }
      const observer = store.getObserver(originId);
      if (!observer) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Observer not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(observer));
      return;
    }

    if (path === '/api/topology') {
      const topology = store.getTopology();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(topology));
      return;
    }

    if (path === '/api/alerts') {
      const alerts = store.getAlerts();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(alerts));
      return;
    }

    if (path === '/api/alerts/active') {
      const alerts = store.getActiveAlerts();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(alerts));
      return;
    }

    if (path === '/api/alerts/acknowledge') {
      const id = url.searchParams.get('id');
      const by = url.searchParams.get('by') || 'system';
      
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing alert id' }));
        return;
      }
      
      const success = store.acknowledgeAlert(id, by);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success, alertId: id }));
      return;
    }

    if (path === '/api/alerts/acknowledge-all') {
      const by = url.searchParams.get('by') || 'system';
      const count = store.acknowledgeAllAlerts(by);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, count }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'API endpoint not found' }));
  } catch (err) {
    console.error('API error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// WebSocket server
const wss = new WebSocketServer({ noServer: true });

// Broadcast updates to WebSocket clients
const wsClients = new Set();

// Upgrade HTTP to WebSocket
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wsClients.add(ws);
      
      console.log('WebSocket client connected');
      
      // Send initial data
      const initialData = {
        type: 'init',
        stats: store.getStats(),
        observers: store.getAllObservers(),
      };
      ws.send(JSON.stringify(initialData));

      ws.on('close', () => {
        wsClients.delete(ws);
        console.log('WebSocket client disconnected');
      });

      ws.on('error', (err) => {
        wsClients.delete(ws);
        console.error('WebSocket error:', err.message);
      });
      
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

function broadcastUpdate(type, data) {
  const message = JSON.stringify({ type, data });
  for (const ws of wsClients) {
    if (ws.readyState === 1) { // 1 = OPEN
      ws.send(message);
    }
  }
}

// Periodic stats broadcast
setInterval(() => {
  const stats = store.getStats();
  broadcastUpdate('stats', stats);
  
  // Save history data
  const now = new Date().toISOString();
  store.saveHistory('packets', now, stats.packetsPerSecond || 0);
  store.saveHistory('observers', now, stats.observerCount || 0);
  store.saveHistory('buffer', now, stats.bufferSize || 0);
  
  // Broadcast topology if enabled
  if (config.PARSE_RAW_PACKETS) {
    broadcastUpdate('topology', store.getTopology());
  }
  
  // Broadcast alerts
  broadcastUpdate('alerts', store.getActiveAlerts());
}, 1000);

// Start MQTT client
mqttClient.connect();

// Start server
server.listen(config.BACKEND_PORT, config.BACKEND_HOST, () => {
  console.log(`Backend server running on http://${config.BACKEND_HOST}:${config.BACKEND_PORT}`);
  console.log(`WebSocket server running on ws://${config.BACKEND_HOST}:${config.BACKEND_PORT}/ws`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  mqttClient.disconnect();
  store.close();
  server.close(() => {
    console.log('Server stopped');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  mqttClient.disconnect();
  store.close();
  server.close(() => {
    console.log('Server stopped');
    process.exit(0);
  });
});

module.exports = server;
