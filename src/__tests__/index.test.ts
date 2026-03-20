import {
  Eden,
  EdenError,
  EdenInvalidEventTypeError,
  EdenInvalidEnvelopeError,
  EdenStunTimeoutError,
  EdenSignalingError,
  EdenSentinelError,
  UdpTransport,
  P2PTransport,
  SignalingSentinel,
  SentinelElection,
  SENTINEL_HEARTBEAT_MAGIC,
} from "../index.js";
import type { EventEnvelope, EdenTransport, Endpoint } from "../index.js";

describe("public API", () => {
  it("exports Eden", () => expect(Eden).toBeDefined());
  it("exports EdenError", () => expect(EdenError).toBeDefined());
  it("exports EdenInvalidEventTypeError", () => expect(EdenInvalidEventTypeError).toBeDefined());
  it("exports EdenInvalidEnvelopeError", () => expect(EdenInvalidEnvelopeError).toBeDefined());
  it("exports EdenStunTimeoutError", () => expect(EdenStunTimeoutError).toBeDefined());
  it("exports EdenSignalingError", () => expect(EdenSignalingError).toBeDefined());
  it("exports UdpTransport", () => expect(UdpTransport).toBeDefined());
  it("exports P2PTransport", () => expect(P2PTransport).toBeDefined());

  it("EventEnvelope type is usable", () => {
    const envelope: EventEnvelope = {
      id: "1",
      type: "eden:user:created",
      payload: {},
      timestamp: Date.now(),
      version: "1.0.0",
    };
    expect(envelope.id).toBe("1");
  });

  it("EdenTransport type is usable", () => {
    const transport: EdenTransport = {
      send: (_msg: Buffer) => {},
      bind: (_port: number, _onMessage: (msg: Buffer) => void) => {},
      close: () => {},
    };
    expect(transport).toBeDefined();
  });

  it("Endpoint type is usable", () => {
    const endpoint: Endpoint = { host: "127.0.0.1", port: 4000 };
    expect(endpoint.host).toBe("127.0.0.1");
  });

  it("EdenStunTimeoutError is instance of EdenError", () => {
    const err = new EdenStunTimeoutError(["stun.l.google.com:19302"]);
    expect(err).toBeInstanceOf(EdenError);
  });

  it("EdenSignalingError is instance of EdenError", () => {
    const err = new EdenSignalingError("peer not found");
    expect(err).toBeInstanceOf(EdenError);
  });

  it("exports EdenSentinelError", () => expect(EdenSentinelError).toBeDefined());
  it("EdenSentinelError is instance of EdenError", () => {
    const err = new EdenSentinelError("connection lost");
    expect(err).toBeInstanceOf(EdenError);
  });

  it("exports SignalingSentinel", () => expect(SignalingSentinel).toBeDefined());
  it("exports SentinelElection", () => expect(SentinelElection).toBeDefined());
  it("exports SENTINEL_HEARTBEAT_MAGIC", () => {
    expect(SENTINEL_HEARTBEAT_MAGIC).toBe("__EDEN_SENTINEL_HB__\n");
  });
});
