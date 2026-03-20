import { WebSocketServer, WebSocket } from "ws";
import { P2PTransport } from "../transports/p2p/p2p-transport.js";

// TASK-008: P2PTransport orquestra Signaling + HolePuncher + Relay
describe("P2PTransport", () => {
  let signalingServer: WebSocketServer;
  let signalingPort: number;

  // Servidor de signaling + relay combinado para testes
  function startServer(): Promise<void> {
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

  // Opções que pulam STUN e usam timeouts curtos para testes locais
  const testOpts = { stunServers: [], punchTimeoutMs: 1000, signalingTimeoutMs: 2000 };

  beforeEach(() => startServer());
  afterEach(
    () => new Promise<void>((resolve) => signalingServer.close(() => resolve())),
    10000
  );

  it("dois peers trocam mensagens via hole punch (loopback)", (done) => {
    const url = `ws://127.0.0.1:${signalingPort}`;
    const tA = new P2PTransport("peer-a", url, testOpts);
    const tB = new P2PTransport("peer-b", url, testOpts);

    tB.bind(0, (msg) => {
      expect(msg.toString()).toBe("hello p2p");
      tA.close();
      tB.close();
      done();
    });

    Promise.all([tA.connect("peer-b"), tB.connect("peer-a")]).then(() => {
      tA.send(Buffer.from("hello p2p"));
    });
  }, 8000);

  it("cai para relay quando hole punch falha", (done) => {
    const url = `ws://127.0.0.1:${signalingPort}`;
    // punchTimeout=0 força falha imediata do hole punch → relay
    const opts = { stunServers: [], punchTimeoutMs: 0, signalingTimeoutMs: 2000 };

    const tA = new P2PTransport("relay-a", url, opts);
    const tB = new P2PTransport("relay-b", url, opts);

    tB.bind(0, (msg) => {
      expect(msg.toString()).toBe("via relay");
      tA.close();
      tB.close();
      done();
    });

    Promise.all([tA.connect("relay-b"), tB.connect("relay-a")]).then(() => {
      setTimeout(() => tA.send(Buffer.from("via relay")), 100);
    });
  }, 8000);

  it("transportes trocam mensagens bidirecionalmente", (done) => {
    const url = `ws://127.0.0.1:${signalingPort}`;
    const tA = new P2PTransport("peer-x", url, testOpts);
    const tB = new P2PTransport("peer-y", url, testOpts);

    const received: string[] = [];
    const check = () => {
      if (received.length === 2) {
        tA.close();
        tB.close();
        expect(received).toContain("A:from-y");
        expect(received).toContain("B:from-x");
        done();
      }
    };

    tA.bind(0, (msg) => { received.push(`A:${msg.toString()}`); check(); });
    tB.bind(0, (msg) => { received.push(`B:${msg.toString()}`); check(); });

    Promise.all([tA.connect("peer-y"), tB.connect("peer-x")]).then(() => {
      tA.send(Buffer.from("from-x"));
      tB.send(Buffer.from("from-y"));
    });
  }, 8000);

  it("close limpa todos os recursos sem lançar", async () => {
    const url = `ws://127.0.0.1:${signalingPort}`;
    const t = new P2PTransport("peer-cleanup", url, testOpts);
    t.bind(0, () => {});
    await t.connect("nonexistent").catch(() => {});
    expect(() => t.close()).not.toThrow();
  }, 5000);
});
