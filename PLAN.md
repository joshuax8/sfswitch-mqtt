# sfswitch-mqtt Application Plan

## Overview
**2-container Docker app** for NOC monitoring of MeshCore network via MQTT.

**Data Flow:**
```
MQTT Broker (wss://subscriber.dutchmeshcore.nl:443)
  -> Backend Container (MQTT Subscriber + REST API + WebSocket)
  -> Frontend Container (Dashboard UI)
  -> NOC Browser
```

---

## Container Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        BACKEND                             │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ MQTT Client │  │ Data Store   │  │ REST/WS API      │  │
│  │ (subscribes)│──▶│ (in-memory)  │──▶│ (serves data)    │  │
│  └─────────────┘  └──────────────┘  └─────────────────┘  │
└─────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────┐
│                        FRONTEND                            │
│  ┌──────────────┐  ┌──────────────────┐  ┌─────────────┐ │
│  │ NOC Dashboard │  │ Data Visualization│  │ MQTT Status  │ │
│  │ (HTML/JS)    │  │ (charts/maps)      │  │ Panel        │ │
│  └──────────────┘  └──────────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## Decisions (from user)

1. **Starting point**: Milestone 1-2 (Backend Core + Data Processing Pipeline)
2. **Real-time protocol**: WebSocket
3. **Data persistence**: In-Memory with lightweight persistence
4. **Raw data parsing**: Optional, NOT enabled by default (performance)

---

## Milestones

### Milestone 1: Backend Core *(Foundation)*
- [ ] Dockerfile for backend (Node.js)
- [ ] MQTT WebSocket client connection using .env config
- [ ] Subscribe to `meshcore/+/+/packets`
- [ ] Parse incoming JSON messages
- [ ] Basic health endpoint (`/health`)
- [ ] Config: MQTT_URL, MQTT_TOPIC, MQTT_USER, MQTT_PASSWORD from .env
- [ ] Tests: Connection, subscription, message parsing
- [ ] **Performance**: Connection handled as async stream, no blocking

### Milestone 2: Data Processing Pipeline *(Hot Path)*
- [ ] Packet decoder for `raw` hex field -> MeshCore header extraction
- [ ] In-memory ring buffer for last N packets (configurable, default: 10000)
- [ ] Real-time aggregations:
  - Packets/sec by observer
  - Packet type counts (REQ, RESPONSE, TXT_MSG, ADVERT, etc.)
  - Route type counts (FLOOD vs DIRECT)
  - SNR/RSSI min/avg/max per observer
- [ ] Lightweight persistence (sqlite) for restart recovery
- [ ] Data eviction: oldest packets removed when buffer full
- [ ] Raw packet parsing: OPTIONAL flag (disabled by default)
- [ ] **Performance**: All aggregations O(1) updates, ring buffer for packet storage
- [ ] Tests: Decoder correctness, aggregation accuracy, eviction behavior

### Milestone 3: REST API *(Data Access)*
- [ ] `/api/packets` - Latest packets (paginated)
- [ ] `/api/stats` - Aggregated statistics
- [ ] `/api/observers` - List of active observers with status
- [ ] `/api/topology` - Network topology (derived from packet paths, if parsing enabled)
- [ ] **Performance**: No per-item DB queries; all data from in-memory store

### Milestone 4: WebSocket API *(Real-time)*
- [ ] WebSocket server pushing updates to clients
- [ ] Events: new packet, stats update, observer status change
- [ ] Frontend can subscribe to specific data streams

### Milestone 5: Frontend Core *(UI Foundation)*
- [ ] Dockerfile for frontend (nginx serving static files)
- [ ] HTML/CSS/JS (no framework - per AGENTS.md rule)
- [ ] Connect to backend API (same container network)
- [ ] Real-time updates via WebSocket
- [ ] Basic layout: header, sidebar, main dashboard area

### Milestone 6: Dashboard Views *(NOC Insights)*
- [ ] **Overview Panel**: Total packets, observers, uptime
- [ ] **Packet Flow View**: Real-time packet rate chart
- [ ] **Observer Status Table**: SNR, RSSI, last seen, packet count
- [ ] **Network Topology**: Node connections derived from packet paths (if parsing enabled)
- [ ] **Packet Type Breakdown**: Pie chart of payload types
- [ ] **Route Analysis**: Flood vs Direct ratio
- [ ] **Deep Linking**: All views bookmarkable via URL hash

### Milestone 7: Alerting *(NOC Critical)*
- [ ] Configurable thresholds (SNR < X, RSSI < Y, observer down)
- [ ] Alert state tracked per observer
- [ ] Alerts exposed via `/api/alerts`
- [ ] Frontend: Alert panel with acknowledgment

### Milestone 8: Docker Compose & Deployment
- [ ] `docker-compose.yml` orchestrating both containers
- [ ] Shared network for frontend<->backend communication
- [ ] Volume for backend data persistence (sqlite)
- [ ] Health checks for both containers

---

## Data Model (In-Memory Store)

```javascript
// Backend Store Structure
{
  // Ring buffer of raw packets (configurable size)
  packets: [ /* {timestamp, origin, origin_id, raw, SNR, RSSI, ...} */ ],

  // Aggregated stats (updated on each packet)
  stats: {
    totalPackets: number,
    packetsPerObserver: Map<origin_id, number>,
    packetTypes: Map<packet_type, number>,
    routeTypes: Map<route_type, number>,
    snr: { min: number, max: number, avg: number } per observer,
    rssi: { min: number, max: number, avg: number } per observer
  },

  // Network topology (only if raw parsing enabled)
  topology: {
    nodes: Map<node_hash, { id: string, type: string, lastSeen: Date }>,
    edges: Map<edge_key, { count: number, lastSeen: Date, avgSNR: number }>
  },

  // Active observers
  observers: Map<origin_id, {
    name: string,
    lastSeen: Date,
    packetCount: number,
    avgSNR: number,
    avgRSSI: number,
    status: 'online' | 'offline' | 'degraded'
  }>
}
```

---

## File Structure

```
sfswitch-mqtt/
├── .gitignore
├── .env                    # MQTT credentials (ignored)
├── docker-compose.yml
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── src/
│   │   ├── index.js        # Entry point
│   │   ├── mqtt.js         # MQTT client
│   │   ├── store.js        # In-memory data store + sqlite persistence
│   │   ├── decoder.js      # MeshCore packet decoder (optional)
│   │   ├── api.js          # REST API routes
│   │   ├── websocket.js    # WebSocket server
│   │   └── config.js       # Config from .env
│   └── tests/
│       ├── test-decoder.js
│       ├── test-store.js
│       └── test-api.js
├── frontend/
│   ├── Dockerfile
│   ├── nginx.conf
│   └── static/
│       ├── index.html
│       ├── style.css
│       └── app.js
└── docs/
```

---

## Performance Considerations

| Component | Approach | Complexity |
|-----------|----------|------------|
| Packet ingestion | Async stream processing | O(1) per packet |
| Ring buffer | Fixed-size circular buffer | O(1) insert, O(1) eviction |
| Aggregations | Incremental updates on ingestion | O(1) per packet |
| API queries | In-memory lookups | O(1) or O(n) where n = result size |
| Topology building | Hash map lookups | O(1) per hop in path |

**Hard Rules:**
- No blocking operations in hot path
- All data structures sized with configurable limits
- Raw packet parsing disabled by default (opt-in via config)
- WebSocket for real-time, no polling

---

## Configuration (from .env)

```bash
# MQTT Connection
MQTT_URL="wss://subscriber.dutchmeshcore.nl:443"
MQTT_TOPIC="meshcore/+/+/packets"
MQTT_USER="subscriber809791"
MQTT_PASSWORD=""

# Backend
BACKEND_PORT=3000
BACKEND_HOST=0.0.0.0
PACKET_BUFFER_SIZE=10000
AGGREGATION_WINDOW=60  # seconds

# Optional Features
PARSE_RAW_PACKETS=false  # Disable by default for performance
PERSISTENCE_FILE=/data/packets.db  # SQLite database path

# WebSocket
WS_PORT=3001
```

---

## MQTT Message Format Reference

```json
{
  "timestamp": "2026-05-09T22:41:51.000000",
  "hash": "F01E08660F7E5E54",
  "origin": "Stollenberg Observer",
  "origin_id": "36F4DB912E96A2C28DE58145F27A62371EB82356464F9506D3C0B857243AD548",
  "type": "PACKET",
  "direction": "rx",
  "time": "22:41:51",
  "date": "09/05/2026",
  "len": "38",
  "packet_type": "0",
  "route": "F",
  "payload_len": "20",
  "raw": "0111770E6AEF094DF367B81EA288BADCDBD3F2DF8B6F07C4D8B3B085AC3165A9DA1406041E0166",
  "SNR": "-0.2",
  "RSSI": "-103"
}
```

**Topic Pattern:** `meshcore/{region}/{observer_id}/packets`

---

## MeshCore Packet Reference

From docs/MESHCORE_NETWORK_BEHAVIOR.md:

**Header Byte Layout (8 bits):**
- Bits 0-1: Route Type (0=TRANSPORT_FLOOD, 1=FLOOD, 2=DIRECT, 3=TRANSPORT_DIRECT)
- Bits 2-5: Payload Type (0=REQ, 1=RESPONSE, 2=TXT_MSG, 3=ACK, 4=ADVERT, 5=GRP_TXT, 6=GRP_DATA, 7=ANON_REQ, 8=PATH, 9=TRACE, 10=MULTIPART, 11=CONTROL, 15=RAW_CUSTOM)
- Bits 6-7: Payload Version (0=PAYLOAD_VER_1, 1=PAYLOAD_VER_2)

**Packet Structure:**
```
[header:1 byte] [transport_codes:4 bytes optional] [path_len:1 byte] [path:variable] [payload:variable]
```

---

## Testing Strategy

Per AGENTS.md:
- ALL tests must pass before pushing
- Every new feature must add tests
- Backend: Unit tests for decoder, store, API
- Frontend: Integration tests (browser validation required)
- Performance: No O(n²) in hot paths, no per-item API calls

---

*Plan generated: 2026-05-10*
*Last updated: 2026-05-10*
