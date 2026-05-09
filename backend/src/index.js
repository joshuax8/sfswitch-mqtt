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
  broadcastUpdate('stats', store.getStats());
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
