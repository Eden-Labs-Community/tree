import { WebSocketServer, WebSocket } from "ws";
import { RelayClient } from "../relay/relay-client.js";

// TASK-007: RelayClient implementa EdenTransport via relay node WebSocket
describe("RelayClient", () => {
  let server: WebSocketServer;
  let port: number;

  // Relay server mínimo: roteia mensagens entre peers por peerId
  function startRelayServer(): Promise<void> {
    return new Promise((resolve) => {
      server = new WebSocketServer({ port: 0 }, () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });

      const peers = new Map<string, WebSocket>();

      server.on("connection", (ws: WebSocket) => {
        ws.on("message", (data: Buffer) => {
          const msg = JSON.parse(data.toString());

          if (msg.type === "identify") {
            peers.set(msg.peerId, ws);
            ws.send(JSON.stringify({ type: "identified" }));
          }

          if (msg.type === "relay") {
            const target = peers.get(msg.targetPeerId);
            if (target && target.readyState === WebSocket.OPEN) {
              target.send(
                JSON.stringify({ type: "data", from: msg.fromPeerId, payload: msg.payload })
              );
            }
          }
        });

        ws.on("close", () => {
          for (const [id, sock] of peers) {
            if (sock === ws) peers.delete(id);
          }
        });
      });
    });
  }

  beforeEach(() => startRelayServer());
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("send entrega mensagem ao peer destino via relay", (done) => {
    const sender = new RelayClient(`ws://127.0.0.1:${port}`, "peer-sender", "peer-receiver");
    const receiver = new RelayClient(`ws://127.0.0.1:${port}`, "peer-receiver", "peer-sender");

    receiver.bind(0, (msg) => {
      expect(msg.toString()).toBe("hello from sender");
      sender.close();
      receiver.close();
      done();
    });

    setTimeout(() => {
      sender.send(Buffer.from("hello from sender"));
    }, 50);
  }, 3000);

  it("dois pares conseguem trocar mensagens bidirecionalmente", (done) => {
    const clientA = new RelayClient(`ws://127.0.0.1:${port}`, "alpha", "beta");
    const clientB = new RelayClient(`ws://127.0.0.1:${port}`, "beta", "alpha");

    const received: string[] = [];

    const check = () => {
      if (received.length === 2) {
        clientA.close();
        clientB.close();
        expect(received).toContain("A:from-beta");
        expect(received).toContain("B:from-alpha");
        done();
      }
    };

    clientA.bind(0, (msg) => { received.push(`A:${msg.toString()}`); check(); });
    clientB.bind(0, (msg) => { received.push(`B:${msg.toString()}`); check(); });

    setTimeout(() => {
      clientA.send(Buffer.from("from-alpha"));
      clientB.send(Buffer.from("from-beta"));
    }, 50);
  }, 3000);

  it("close encerra a conexão WebSocket", (done) => {
    const client = new RelayClient(`ws://127.0.0.1:${port}`, "peer-close-test", "other");
    client.bind(0, () => {});

    setTimeout(() => {
      client.close();
      setTimeout(() => {
        expect(server.clients.size).toBe(0);
        done();
      }, 50);
    }, 50);
  }, 3000);
});
