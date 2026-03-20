import { WebSocketServer, WebSocket } from "ws";
import { Eden } from "../eden/eden.js";
import { P2PTransport } from "../transports/p2p/p2p-transport.js";

const BASE_PORT = 41400;

describe("Eden (UdpTransport default)", () => {
  let eden: Eden;

  afterEach(() => eden.stop());

  it("can be created", () => {
    eden = new Eden({
      listenPort: BASE_PORT,
      remote: { host: "127.0.0.1", port: BASE_PORT + 1 },
    });
    expect(eden).toBeDefined();
  });

  it("receives an event emitted by another Eden instance", (done) => {
    const sender = new Eden({
      listenPort: BASE_PORT + 1,
      remote: { host: "127.0.0.1", port: BASE_PORT + 2 },
    });

    eden = new Eden({
      listenPort: BASE_PORT + 2,
      remote: { host: "127.0.0.1", port: BASE_PORT + 1 },
    });

    eden.on("eden:user:created", (envelope) => {
      expect((envelope.payload as any).id).toBe("1");
      sender.stop();
      done();
    });

    sender.emit("eden:user:created", { id: "1" });
  });

  it("delivers event only to the correct room", (done) => {
    const sender = new Eden({
      listenPort: BASE_PORT + 3,
      remote: { host: "127.0.0.1", port: BASE_PORT + 4 },
    });

    eden = new Eden({
      listenPort: BASE_PORT + 4,
      remote: { host: "127.0.0.1", port: BASE_PORT + 3 },
    });

    const wrongRoom: unknown[] = [];

    eden.on("eden:chat:message", () => wrongRoom.push(true), { room: "sala-2" });
    eden.on("eden:chat:message", (envelope) => {
      expect(wrongRoom).toHaveLength(0);
      expect(envelope.room).toBe("sala-1");
      sender.stop();
      done();
    }, { room: "sala-1" });

    sender.emit("eden:chat:message", { text: "hi" }, { room: "sala-1" });
  });
});

describe("Eden — ACK routing", () => {
  it("pending queue esvazia após ACK ser recebido", (done) => {
    const portSender = BASE_PORT + 10;
    const portReceiver = BASE_PORT + 11;

    const sender = new Eden({
      listenPort: portSender,
      remote: { host: "127.0.0.1", port: portReceiver },
      timeoutMs: 5000,
      retryIntervalMs: 200,
    });
    const receiver = new Eden({
      listenPort: portReceiver,
      remote: { host: "127.0.0.1", port: portSender },
    });

    receiver.on("eden:ack:test", () => {
      // Aguarda o ACK percorrer o caminho de volta
      setTimeout(() => {
        expect(sender.getPendingCount()).toBe(0);
        sender.stop();
        receiver.stop();
        done();
      }, 100);
    });

    sender.emit("eden:ack:test", { v: 1 });
  });
});

// TASK-009: Eden com P2PTransport plugado
describe("Eden (P2PTransport)", () => {
  let signalingServer: WebSocketServer;
  let signalingPort: number;

  function startSignalingServer(): Promise<void> {
    return new Promise((resolve) => {
      signalingServer = new WebSocketServer({ port: 0 }, () => {
        signalingPort = (signalingServer.address() as { port: number }).port;
        resolve();
      });

      const peers = new Map<string, { endpoint: { host: string; port: number }; ws: WebSocket }>();

      signalingServer.on("connection", (ws: WebSocket) => {
        ws.on("message", (data: Buffer) => {
          const msg = JSON.parse(data.toString());

          if (msg.type === "register") {
            peers.set(msg.peerId, { endpoint: msg.endpoint, ws });
            ws.send(JSON.stringify({ type: "registered" }));
          }

          if (msg.type === "request_connect") {
            const peer = peers.get(msg.targetId);
            if (peer) {
              ws.send(JSON.stringify({ type: "peer_endpoint", endpoint: peer.endpoint }));
            } else {
              ws.send(JSON.stringify({ type: "error", reason: "peer_not_found" }));
            }
          }

          if (msg.type === "relay") {
            const target = peers.get(msg.targetPeerId);
            if (target && target.ws.readyState === WebSocket.OPEN) {
              target.ws.send(
                JSON.stringify({ type: "data", from: msg.fromPeerId, payload: msg.payload })
              );
            }
          }

          if (msg.type === "identify") {
            const existing = peers.get(msg.peerId);
            if (existing) peers.set(msg.peerId, { ...existing, ws });
            ws.send(JSON.stringify({ type: "identified" }));
          }
        });
      });
    });
  }

  beforeEach(() => startSignalingServer());
  afterEach(() => new Promise<void>((resolve) => signalingServer.close(() => resolve())), 10000);

  it("dois Eden com P2PTransport trocam eventos Eden", (done) => {
    const url = `ws://127.0.0.1:${signalingPort}`;
    const opts = { stunServers: [], punchTimeoutMs: 1000, signalingTimeoutMs: 2000 };

    const tA = new P2PTransport("eden-a", url, opts);
    const tB = new P2PTransport("eden-b", url, opts);

    const edenA = new Eden({ listenPort: 0, remote: { host: "127.0.0.1", port: 0 }, transport: () => tA });
    const edenB = new Eden({ listenPort: 0, remote: { host: "127.0.0.1", port: 0 }, transport: () => tB });

    edenB.on("eden:chat:message", (envelope) => {
      expect((envelope.payload as any).text).toBe("hello p2p eden");
      edenA.stop();
      edenB.stop();
      done();
    });

    Promise.all([tA.connect("eden-b"), tB.connect("eden-a")]).then(() => {
      edenA.emit("eden:chat:message", { text: "hello p2p eden" });
    });
  }, 10000);
});
