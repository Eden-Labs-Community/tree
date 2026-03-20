# @eden_labs/core

Event manager for the Eden ecosystem. Fast, reliable event bus with at-least-once delivery guarantees — works on the same machine, across a local network, or across the internet through NAT via P2P hole punching and relay fallback.

## How it works

```
Eden A                        Eden B
  |                             |
  | emit("eden:user:created")   |
  |──────── UDP ───────────────>|
  |                             | on("eden:user:created", handler)
  |<──────── ACK ───────────────|
```

Events are sent as UDP packets. The emitter retries automatically if no ACK arrives within `timeoutMs`. The receiver deduplicates repeated deliveries — your handler is never called twice for the same event.

---

## Quick start

### Same machine / same network (UdpTransport, default)

```ts
import { Eden } from "@eden_labs/core";

const a = new Eden({
  listenPort: 5000,
  remote: { host: "127.0.0.1", port: 5001 },
});

const b = new Eden({
  listenPort: 5001,
  remote: { host: "127.0.0.1", port: 5000 },
});

b.on("eden:user:created", (envelope) => {
  console.log(envelope.payload); // { id: "123" }
});

b.on("eden:chat:message", (envelope) => {
  console.log(envelope.payload);
}, { room: "sala-1" });

a.emit("eden:user:created", { id: "123" });
a.emit("eden:chat:message", { text: "hi" }, { room: "sala-1" });

a.stop();
b.stop();
```

### Across the internet (P2PTransport — NAT traversal)

For peers behind NAT (home networks, mobile, cloud VMs without public IP), use `P2PTransport`. It automatically tries:

1. **STUN** — discovers your public IP/port
2. **UDP hole punching** — opens a direct path through NAT (~85% of cases)
3. **WebSocket relay** — fallback when hole punching fails (~15% of symmetric NAT)

You need a **signaling server** with a public IP — a small WebSocket server peers use to exchange endpoints before connecting. See [Signaling server](#signaling-server) below.

```ts
import { Eden, P2PTransport } from "@eden_labs/core";

const transport = new P2PTransport("peer-alice", "ws://your-signal-server:8080", {
  stunServers: [
    { host: "stun.l.google.com", port: 19302 },
    { host: "stun.cloudflare.com", port: 3478 },
  ],
  punchTimeoutMs: 3000,
  signalingTimeoutMs: 5000,
});

const alice = new Eden({
  listenPort: 0,
  remote: { host: "0.0.0.0", port: 0 },
  transport: () => transport,
});

// Connect to the other peer (both sides call connect simultaneously)
await transport.connect("peer-bob");

alice.on("eden:chat:message", (envelope) => {
  console.log(envelope.payload);
});

alice.emit("eden:chat:message", { text: "hello over the internet!" });
```

---

## API

### `new Eden(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `listenPort` | `number` | required | Local UDP port to listen on (`0` = OS-assigned, for P2P) |
| `remote.host` | `string` | required | Remote host to send events to |
| `remote.port` | `number` | required | Remote port to send events to |
| `timeoutMs` | `number` | `5000` | Time (ms) before retrying an unacknowledged event |
| `retryIntervalMs` | `number` | `1000` | How often to check for expired events |
| `transport` | `(target) => EdenTransport` | `UdpTransport` | Custom transport factory |

### `eden.on(type, handler, options?)`

Registers a listener for an event type. Returns an `unsubscribe` function.

```ts
const unsubscribe = eden.on("eden:user:created", (envelope) => {
  console.log(envelope.type, envelope.payload);
});

// stop listening
unsubscribe();
```

Options:
- `room?: string` — only receive events sent to this room

### `eden.emit(type, payload, options?)`

Emits an event to the remote instance.

```ts
eden.emit("eden:user:created", { id: "1" });
eden.emit("eden:chat:message", { text: "hi" }, { room: "sala-1" });
```

Options:
- `room?: string` — send to a specific room

### `eden.stop()`

Closes all sockets and stops the retry interval. Must be called when the instance is no longer needed.

```ts
process.on("SIGTERM", () => {
  eden.stop();
  process.exit(0);
});
```

---

## P2PTransport

### `new P2PTransport(peerId, signalingUrl, options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `peerId` | `string` | required | Unique ID for this peer |
| `signalingUrl` | `string` | required | WebSocket URL of your signaling server |
| `stunServers` | `{ host, port }[]` | Google + Cloudflare STUN | STUN servers to discover public IP. Pass `[]` to skip STUN (same network) |
| `stunTimeoutMs` | `number` | `3000` | Timeout per STUN attempt |
| `punchTimeoutMs` | `number` | `3000` | Timeout for hole punching. Pass `0` to skip punching and go straight to relay |
| `signalingTimeoutMs` | `number` | `5000` | Timeout for signaling server responses |

### `transport.connect(targetPeerId)`

Executes the full connection sequence (STUN → register → hole punch → relay fallback). Both peers must call `connect` pointing at each other simultaneously.

```ts
// Both peers call this at roughly the same time
await Promise.all([
  transportAlice.connect("peer-bob"),
  transportBob.connect("peer-alice"),
]);
```

---

## Signaling server

The signaling server is a small WebSocket server that helps peers find each other before connecting. It only exchanges IP/port info — it never sees your event payloads.

You need to host one with a public IP. The minimal protocol it must implement:

```
Client → Server: { type: "register", peerId, endpoint: { host, port } }
Server → Client: { type: "registered" }

Client → Server: { type: "request_connect", peerId, targetId }
Server → Client: { type: "peer_endpoint", endpoint: { host, port } }
             or: { type: "error", reason: "peer_not_found" }

Client → Server: { type: "relay", fromPeerId, targetPeerId, payload: base64 }
Server → Target: { type: "data", from: fromPeerId, payload: base64 }

Client → Server: { type: "identify", peerId }   // re-register WebSocket after reconnect
```

Minimal Node.js signaling server:

```ts
import { WebSocketServer, WebSocket } from "ws";

const server = new WebSocketServer({ port: 8080 });
const peers = new Map<string, { endpoint: { host: string; port: number }; ws: WebSocket }>();

server.on("connection", (ws) => {
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.type === "register") {
      peers.set(msg.peerId, { endpoint: msg.endpoint, ws });
      ws.send(JSON.stringify({ type: "registered" }));
    }

    if (msg.type === "request_connect") {
      const peer = peers.get(msg.targetId);
      if (peer) ws.send(JSON.stringify({ type: "peer_endpoint", endpoint: peer.endpoint }));
      else ws.send(JSON.stringify({ type: "error", reason: "peer_not_found" }));
    }

    if (msg.type === "relay") {
      const target = peers.get(msg.targetPeerId);
      if (target?.ws.readyState === WebSocket.OPEN)
        target.ws.send(JSON.stringify({ type: "data", from: msg.fromPeerId, payload: msg.payload }));
    }

    if (msg.type === "identify") {
      const existing = peers.get(msg.peerId);
      if (existing) peers.set(msg.peerId, { ...existing, ws });
    }
  });
});
```

---

## Event types

Must follow the format `{namespace}:{domain}:{action}`:

```
eden:user:created      ✓
eden:order:updated     ✓
eden:chat:message      ✓

user:created           ✗  (missing namespace)
created                ✗  (only one part)
```

Throws `EdenInvalidEventTypeError` if the format is invalid.

---

## Envelope

Every event is wrapped in an envelope automatically:

```ts
{
  id: string;        // UUID v4 — used for deduplication
  type: string;      // "eden:user:created"
  payload: unknown;  // your event data
  timestamp: number; // Unix ms
  version: string;   // protocol version
  room?: string;     // present if emitted to a room
}
```

---

## Delivery guarantees

| What | How |
|------|-----|
| At-least-once | Emitter retries until ACK received |
| No duplicates | Receiver deduplicates by envelope `id` |
| Effectively exactly-once | Both combined |

---

## Rooms

- **No room** → delivered to all listeners of that event type (broadcast)
- **With room** → delivered only to listeners subscribed to that room

```ts
// only receives events emitted to "sala-1"
eden.on("eden:chat:message", handler, { room: "sala-1" });

// receives all "eden:chat:message" events regardless of room
eden.on("eden:chat:message", handler);
```

---

## Errors

All errors extend `EdenError`:

| Error | When |
|-------|------|
| `EdenInvalidEventTypeError` | Event type doesn't follow `{ns}:{domain}:{action}` format |
| `EdenInvalidEnvelopeError` | Received message is not valid JSON or missing required fields |
| `EdenStunTimeoutError` | No STUN server responded within `stunTimeoutMs` |
| `EdenSignalingError` | Signaling server returned an error or timed out |

```ts
import { EdenError, EdenSignalingError, EdenStunTimeoutError } from "@eden_labs/core";

try {
  await transport.connect("peer-bob");
} catch (err) {
  if (err instanceof EdenStunTimeoutError) {
    console.error("Could not discover public IP — check STUN server");
  }
  if (err instanceof EdenSignalingError) {
    console.error("Peer not found or signaling server unreachable");
  }
}
```

---

## Performance (loopback 127.0.0.1)

Measured with sequential ping-pong RTT (1000 samples):

| Transport | p50 | p95 | p99 | Throughput |
|-----------|-----|-----|-----|------------|
| UdpTransport (baseline) | 0.051 ms | 0.077 ms | 0.116 ms | 15,578 msg/s |
| P2PTransport (hole punch) | 0.053 ms | 0.074 ms | 0.141 ms | 15,230 msg/s |
| P2PTransport (relay) | 0.104 ms | 0.158 ms | 0.222 ms | 8,176 msg/s |

P2PTransport adds ~2.6% overhead after connection is established (hole punch path). The relay path adds ~103% because it goes through a WebSocket/TCP intermediary — still fast enough for most use cases, and only used as a fallback.

Real-world latencies will be higher due to actual network RTT.

Run the benchmark yourself:

```bash
npm run bench
```

---

## Development

```bash
npm test                 # run all unit tests
npm run test:watch       # watch mode
npm run test:integration # real network tests (STUN against stun.l.google.com)
npm run build            # compile to dist/
npm run bench            # transport benchmark
```

All code follows strict TDD — no production code without a failing test first.
