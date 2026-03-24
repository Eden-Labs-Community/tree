export { Eden } from "./eden/eden.js";

export {
  EdenError,
  EdenInvalidEventTypeError,
  EdenInvalidEnvelopeError,
  EdenStunTimeoutError,
  EdenSignalingError,
  EdenSentinelError,
} from "./errors/errors.js";

export { UdpTransport } from "./transports/udp/udp-transport.js";
export { MultiUdpTransport } from "./transports/udp/multi-udp-transport.js";
export { P2PTransport } from "./transports/p2p/p2p-transport.js";
export { MultiP2PTransport } from "./transports/p2p/multi-p2p-transport.js";

export { SignalingSentinel } from "./signaling/signaling-sentinel.js";
export { SentinelElection, SENTINEL_HEARTBEAT_MAGIC } from "./sentinel/sentinel-election.js";

export { MeshRelay } from "./mesh/mesh-relay.js";
export type { MeshRelayOptions } from "./mesh/mesh-relay.js";

export { MessageRouter } from "./routing/message-router.js";
export type { ServerConnection, MeshConnection, MessageRouterOptions } from "./routing/message-router.js";
export { RoomManager } from "./routing/room-manager.js";
export type { RoomRouter, RoomManagerOptions } from "./routing/room-manager.js";

export type { ConnectResult } from "./signaling/signaling-client.js";

export { encrypt, decrypt } from "./crypto/box.js";
export { createIdentity, derivePeerId } from "./crypto/identity.js";
export type { Identity } from "./crypto/identity.js";

export type { EdenTransport, Endpoint } from "./transports/transport.js";
export type { EventEnvelope } from "./envelope/envelope.js";
