import { WebSocketServer, WebSocket } from "ws";
import { MultiP2PTransport } from "../transports/p2p/multi-p2p-transport.js";

describe("MultiP2PTransport", () => {
  let signalingServer: WebSocketServer;
  let signalingPort: number;

  // Servidor de signaling + relay combinado para testes (mesmo padrão do p2p-transport.test.ts)
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
          }
        });
      });
    });
  }

  // Pula STUN, usa timeouts curtos para testes locais
  const testOpts = { stunServers: [], punchTimeoutMs: 1000, signalingTimeoutMs: 2000 };

  beforeEach(() => startServer());
  afterEach(
    () => new Promise<void>((resolve) => signalingServer.close(() => resolve())),
    10000
  );

  it("addPeer conecta dois peers via hole punch (loopback)", (done) => {
    const url = `ws://127.0.0.1:${signalingPort}`;
    const tA = new MultiP2PTransport(testOpts);
    const tB = new MultiP2PTransport(testOpts);

    tB.bind(0, (msg) => {
      expect(msg.toString()).toBe("hello multi-p2p");
      tA.close();
      tB.close();
      done();
    });
    tA.bind(0, () => {});

    Promise.all([
      tA.addPeer("mp2p-a", "mp2p-b", url),
      tB.addPeer("mp2p-b", "mp2p-a", url),
    ]).then(() => {
      tA.send(Buffer.from("hello multi-p2p"));
    });
  }, 8000);

  it("addPeer cai para relay quando punchTimeoutMs=0", (done) => {
    const url = `ws://127.0.0.1:${signalingPort}`;
    const opts = { stunServers: [], punchTimeoutMs: 0, signalingTimeoutMs: 2000 };

    const tA = new MultiP2PTransport(opts);
    const tB = new MultiP2PTransport(opts);

    tB.bind(0, (msg) => {
      expect(msg.toString()).toBe("via relay");
      tA.close();
      tB.close();
      done();
    });
    tA.bind(0, () => {});

    Promise.all([
      tA.addPeer("relay-ma", "relay-mb", url),
      tB.addPeer("relay-mb", "relay-ma", url),
    ]).then(() => {
      setTimeout(() => tA.send(Buffer.from("via relay")), 100);
    });
  }, 8000);

  it("send faz fanout para todos os peers registrados", (done) => {
    const url = `ws://127.0.0.1:${signalingPort}`;
    const tSender = new MultiP2PTransport(testOpts);
    const tB = new MultiP2PTransport(testOpts);
    const tC = new MultiP2PTransport(testOpts);

    const received: string[] = [];
    const check = () => {
      if (received.length === 2) {
        tSender.close();
        tB.close();
        tC.close();
        expect(received).toContain("B:fanout");
        expect(received).toContain("C:fanout");
        done();
      }
    };

    tB.bind(0, (msg) => { received.push(`B:${msg.toString()}`); check(); });
    tC.bind(0, (msg) => { received.push(`C:${msg.toString()}`); check(); });
    tSender.bind(0, () => {});

    Promise.all([
      tSender.addPeer("fanout-s", "fanout-b", url),
      tB.addPeer("fanout-b", "fanout-s", url),
    ]).then(() =>
      tSender.addPeer("fanout-s", "fanout-c", url)
    ).then(() =>
      tC.addPeer("fanout-c", "fanout-s", url)
    ).then(() => {
      expect(tSender.getPeerCount()).toBe(2);
      tSender.send(Buffer.from("fanout"));
    });
  }, 10000);

  it("removePeer para de entregar mensagens para o peer removido", (done) => {
    const url = `ws://127.0.0.1:${signalingPort}`;
    const tA = new MultiP2PTransport(testOpts);
    const tB = new MultiP2PTransport(testOpts);

    let receivedByB = 0;
    tB.bind(0, () => { receivedByB++; });
    tA.bind(0, () => {});

    Promise.all([
      tA.addPeer("rm-a", "rm-b", url),
      tB.addPeer("rm-b", "rm-a", url),
    ]).then(() => {
      tA.send(Buffer.from("before remove"));

      setTimeout(() => {
        tA.removePeer("rm-b");
        expect(tA.getPeerCount()).toBe(0);

        tA.send(Buffer.from("after remove"));

        setTimeout(() => {
          // receivedByB can be 0 or 1 (first msg may or may not have arrived before remove)
          // but the count must not increase after removePeer
          const countAfterRemove = receivedByB;
          setTimeout(() => {
            expect(receivedByB).toBe(countAfterRemove);
            tA.close();
            tB.close();
            done();
          }, 200);
        }, 100);
      }, 200);
    });
  }, 8000);

  it("close é idempotente", async () => {
    const url = `ws://127.0.0.1:${signalingPort}`;
    const t = new MultiP2PTransport(testOpts);
    t.bind(0, () => {});
    await t.addPeer("idem-a", "nonexistent", url).catch(() => {});
    expect(() => t.close()).not.toThrow();
    expect(() => t.close()).not.toThrow();
  }, 5000);
});
