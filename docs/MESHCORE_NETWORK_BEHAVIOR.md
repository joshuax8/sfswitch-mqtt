# MeshCore Network Behavior Reference

## Overview

This document summarizes the flooding, routing, repeater behavior, and packet types in MeshCore based on the official [MeshCore repository](https://github.com/meshcore-dev/MeshCore).

---

## Packet Types

MeshCore defines payload types in `src/Packet.h`. Each packet has a header byte containing:
- **Route Type** (2 bits): How the packet should be routed
- **Payload Type** (4 bits): What kind of data the packet carries
- **Payload Version** (2 bits): Version of the payload format

### Route Types

| Value | Name | Description |
|-------|------|-------------|
| 0x00 | `ROUTE_TYPE_TRANSPORT_FLOOD` | Flood mode with transport codes |
| 0x01 | `ROUTE_TYPE_FLOOD` | Flood mode, path needs to be built up |
| 0x02 | `ROUTE_TYPE_DIRECT` | Direct route, path is supplied |
| 0x03 | `ROUTE_TYPE_TRANSPORT_DIRECT` | Direct route with transport codes |

### Payload Types

| Value | Name | Description | Encrypted |
|-------|------|-------------|-----------|
| 0x00 | `PAYLOAD_TYPE_REQ` | Request packet (dest/src hashes, MAC) | Yes |
| 0x01 | `PAYLOAD_TYPE_RESPONSE` | Response to REQ or ANON_REQ | Yes |
| 0x02 | `PAYLOAD_TYPE_TXT_MSG` | Plain text message (dest/src hashes, MAC) | Yes |
| 0x03 | `PAYLOAD_TYPE_ACK` | Simple acknowledgment | No |
| 0x04 | `PAYLOAD_TYPE_ADVERT` | Node advertisement with Identity | No |
| 0x05 | `PAYLOAD_TYPE_GRP_TXT` | Group text message (channel hash, MAC) | Yes |
| 0x06 | `PAYLOAD_TYPE_GRP_DATA` | Group datagram (channel hash, MAC) | Yes |
| 0x07 | `PAYLOAD_TYPE_ANON_REQ` | Anonymous request (dest_hash, ephemeral pub_key, MAC) | Yes |
| 0x08 | `PAYLOAD_TYPE_PATH` | Returned path (dest/src hashes, MAC) | Yes |
| 0x09 | `PAYLOAD_TYPE_TRACE` | Trace a path, collecting SNR for each hop | No |
| 0x0A | `PAYLOAD_TYPE_MULTIPART` | One of a set of packets | No |
| 0x0B | `PAYLOAD_TYPE_CONTROL` | Control/discovery packet | No |
| 0x0F | `PAYLOAD_TYPE_RAW_CUSTOM` | Custom raw bytes for custom encryption | No |

### Payload Versions

| Value | Name | Description |
|-------|------|-------------|
| 0x00 | `PAYLOAD_VER_1` | 1-byte src/dest hashes, 2-byte MAC |
| 0x01 | `PAYLOAD_VER_2` | Future (2-byte hashes, 4-byte MAC) |

---

## Flooding Behavior

### How Flooding Works

1. **Packet Creation**: When `sendFlood()` is called, the packet header is set to `ROUTE_TYPE_FLOOD` (or `ROUTE_TYPE_TRANSPORT_FLOOD` with transport codes)
2. **Path Initialization**: The path is initialized with hash size (1-3 bytes) and count of 0 (no nodes in path yet)
3. **Table Marking**: The packet is marked as "seen" in the local MeshTables to prevent immediate rebroadcast
4. **Priority Assignment**:
   - `PAYLOAD_TYPE_PATH`: Priority 2
   - `PAYLOAD_TYPE_ADVERT`: Priority 3 (de-prioritized)
   - All others: Priority 1
5. **Transmission**: Packet is queued for transmission with the assigned priority

### Flood Packet Propagation

When a flood packet is received:

1. **Check if already seen**: If `_tables->hasSeen(packet)` returns true, the packet is discarded (`ACTION_RELEASE`)
2. **Append to path**: The receiving node appends its hash to the packet's path
3. **Increment hop count**: The path hash count is incremented
4. **Delay calculation**: A random retransmit delay is calculated based on packet airtime:
   ```cpp
   uint32_t getRetransmitDelay(const Packet* packet) {
     uint32_t t = (_radio->getEstAirtimeFor(packet->getRawLength()) * 52 / 50) / 2;
     return _rng->nextInt(0, 5)*t;
   }
   ```
5. **Priority adjustment**: Priority decreases as the packet propagates (higher hop count = lower priority)
6. **Re-transmit**: Packet is scheduled for re-transmission with delayed action

### Flood Path Building

- Each node that receives a flood packet appends its hash to the path
- Path format: `[hash_size:1-3 bytes] * [hash_count:0-63]`
- Maximum path size: 64 bytes
- Path is used to:
  - Track the route taken
  - Prevent loops (nodes check if they're already in the path)
  - Calculate SNR for each hop (for TRACE packets)

### Flood Termination

Flood packets stop propagating when:
1. The packet has already been seen (`_tables->hasSeen(packet)` returns true)
2. The path is full (would exceed `MAX_PATH_SIZE`)
3. The node is the destination and marks it with `markDoNotRetransmit()`

---

## Routing Behavior

### Direct Routing

Direct routing uses pre-defined paths. When `sendDirect()` is called:

1. **Packet Setup**: Header set to `ROUTE_TYPE_DIRECT` (or `ROUTE_TYPE_TRANSPORT_DIRECT`)
2. **Path Setting**: The complete path is copied into the packet
3. **Table Marking**: Packet marked as seen
4. **Priority**:
   - `PAYLOAD_TYPE_TRACE`: Priority 5
   - `PAYLOAD_TYPE_PATH`: Priority 1
   - All others: Priority 0 (highest)

### Direct Packet Processing

When a direct packet is received:

1. **Check if this node is next hop**: `self_id.isHashMatch(pkt->path, pkt->getPathHashSize())`
2. **If not next hop**: Packet is released (`ACTION_RELEASE`)
3. **If next hop**:
   - Remove self from path: `removeSelfFromPath(pkt)`
   - For ACK packets: `routeDirectRecvAcks()` handles special ACK forwarding
   - For multipart: `forwardMultipartDirect()` handles multipart sequences
   - Schedule re-transmission with `getDirectRetransmitDelay()` (default: 0)

### Path Following

- Each packet carries its complete path in the `path[]` array
- Path format uses `path_len` byte which encodes:
  - Upper 2 bits: hash size - 1 (so 0-2 = 1-3 byte hashes)
  - Lower 6 bits: number of hashes in path (0-63)
- Nodes check if they match the next hash in the path
- If match, they remove themselves and forward to the next hop

---

## Repeater Behavior

### Node Types (from AdvertDataHelpers.h)

| Type Value | Name | Description |
|------------|------|-------------|
| 0 | `ADV_TYPE_NONE` | No specific type |
| 1 | `ADV_TYPE_CHAT` | Chat-capable node |
| 2 | `ADV_TYPE_REPEATER` | Repeater node |
| 3 | `ADV_TYPE_ROOM` | Room server node |
| 4 | `ADV_TYPE_SENSOR` | Sensor node |

### Advertisement Data

Repeater nodes advertise their capabilities via `PAYLOAD_TYPE_ADVERT` packets containing:

- **Type byte** (4 bits): Node type (2 for repeater)
- **Flags**:
  - `ADV_LATLON_MASK` (0x10): Node has GPS coordinates
  - `ADV_NAME_MASK` (0x80): Node has a name
  - `ADV_FEAT1_MASK` (0x20): Feature 1 data present
  - `ADV_FEAT2_MASK` (0x40): Feature 2 data present

### Repeater Function

Repeaters in MeshCore:

1. **Forward packets**: Repeaters forward flood-routed packets to extend network range
2. **Path participation**: Repeaters are included in packet paths (both flood and direct)
3. **No special logic**: The base Mesh class doesn't distinguish between repeater and non-repeater nodes for routing
4. **Advertisement**: Repeaters advertise their type, allowing the network to discover them

### Repeater vs Non-Repeater

In the base implementation:
- **All nodes can forward flood packets** (controlled by `allowPacketForward()` which defaults to `false` but is overridden in subclasses)
- **Repeaters are just a node type** - the distinction is for the application layer
- **Routing is the same** for all node types

The actual repeater behavior (whether to forward or not) is determined by:
- In `BaseChatMesh.cpp`: Subclasses override `allowPacketForward()` to return `true`
- Transport layer decides based on node configuration

---

## Transport Layer

### Transport Codes

Transport codes are 16-bit values (2 per packet) that attach metadata to packets:
- Used with `ROUTE_TYPE_TRANSPORT_FLOOD` and `ROUTE_TYPE_TRANSPORT_DIRECT`
- Allow intermediate nodes to make forwarding decisions
- Can encode: priority, TTL, source info, etc.

### Transport Layer Responsibilities

1. **Packet Forwarding Decision**: Override `allowPacketForward()` to return `true` for nodes that should forward
2. **Retransmit Delay**: Control timing with `getRetransmitDelay()` and `getDirectRetransmitDelay()`
3. **Table Management**: Implement `MeshTables` interface for deduplication

---

## Packet Flow Examples

### Example 1: Flood Text Message

```
Node A creates text message -> sendFlood()
  -> Packet: ROUTE_TYPE_FLOOD, PAYLOAD_TYPE_TXT_MSG, path=[], hash_count=0
  -> Node A marks as seen, transmits

Node B receives:
  -> Not seen before, append B's hash to path
  -> Calculate random delay (0-5x airtime)
  -> Schedule retransmission with priority 1
  -> Process message (if destination matches)

Node C receives from B:
  -> Not seen before, append C's hash to path
  -> Calculate delay, retransmit with priority 1
  -> Path now contains [B, C]

Node D receives from both A and C:
  -> First packet (from A): not seen, process, append D, retransmit
  -> Second packet (from C): already seen, DISCARD
```

### Example 2: Direct Path Request

```
Node A wants path to Node D -> sendFlood(PATH request)
  -> Flood propagates through network
  -> Each node checks if it knows path to D

Node C knows path to D:
  -> Creates PATH response with route
  -> sendDirect(response, [C, B, A])
  -> Packet follows reverse path back to A

Node B receives:
  -> Check if B is next hop in path [C, B, A] -> YES
  -> Remove B from path, now [C, A]
  -> Forward to A

Node A receives:
  -> A is next hop, remove from path, now [C]
  -> Process PATH response
```

### Example 3: Repeater in Flood Path

```
Node A (Chat) -- Node B (Repeater) -- Node C (Chat)

A sends message to C via flood:
  -> A transmits flood message
  -> B (repeater) receives, checks allowPacketForward()=true
  -> B appends hash, retransmits
  -> C receives from B, processes message
  
Path in packet: [A, B] (B is the repeater)
```

---

## Key Implementation Details

### Deduplication

- Implemented via `MeshTables` interface
- `hasSeen(packet)`: Check if packet hash is in local table
- `clear(packet)`: Remove packet hash from table
- Packet hash is calculated from: payload type + payload content (and path_len for TRACE)

### SNR Handling

- SNR stored in packet as `_snr` (int8_t, scaled by 4)
- `getSNR()` returns float value: `_snr / 4.0f`
- For TRACE packets: SNR for each hop is appended to the path array

### Path Manipulation

- `removeSelfFromPath()`: Shifts all path hashes down by one, decrements count
- `copyPath()`: Copies path from one packet to another
- `getPathHashSize()`: Returns hash size (1, 2, or 3 bytes)
- `getPathHashCount()`: Returns number of hashes in path (0-63)

### Priority System

Packet transmission priorities (lower number = higher priority):
- 0: Direct routed packets (highest)
- 1: Flood routed packets (default)
- 2: PATH packets in flood mode
- 3: ADVERT packets in flood mode (lowest)
- 5: TRACE packets in direct mode

---

## Packet Structure Details

### Header Byte Layout

```
Bit:  7  6  5  4  3  2  1  0
     [ Ver1 | Ver0 | Type3 | Type2 | Type1 | Type0 | Route1 | Route0 ]
```

- Bits 0-1: Route Type (0-3)
- Bits 2-5: Payload Type (0-15)
- Bits 6-7: Payload Version (0-3)

### Packet Memory Layout

```
[ header:1 byte ]
[ transport_codes:4 bytes (optional) ]
[ path_len:1 byte ]
[ path:variable (0-64 bytes) ]
[ payload:variable (0-255 bytes) ]
```

Total maximum: 2 + 4 + 1 + 64 + 255 = 326 bytes (but constrained by MAX_MTU_SIZE)

---

## References

- Source: [MeshCore GitHub](https://github.com/meshcore-dev/MeshCore)
- Files analyzed:
  - `src/Packet.h` - Packet definitions and constants
  - `src/Packet.cpp` - Packet implementation
  - `src/Mesh.h` - Mesh network interface
  - `src/Mesh.cpp` - Mesh network implementation
  - `src/Dispatcher.h` - Low-level packet handling
  - `src/Dispatcher.cpp` - Dispatcher implementation
  - `src/helpers/AdvertDataHelpers.h` - Advertisement data encoding
  - `src/helpers/AdvertDataHelpers.cpp` - Advertisement data implementation

---

*Document generated: May 2026*
*MeshCore version: Latest from main branch*
