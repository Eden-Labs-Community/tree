import { WebSocketServer, WebSocket } from "ws";
import { SignalingClient } from "../signaling/signaling-client.js";
import { EdenSignalingError } from "../errors/errors.js";
import { Endpoint } from "../transports/transport.js";

// TASK-005: SignalingClient troca endpoints entre peers via WS server
describe("SignalingClient", () => {
  let server: WebSocketServer;
  let port: number;

  // Servidor de signaling mínimo para testes
  function startServer(): Promise<void> {
    return new Promise((resolve) => {
      server = new WebSocketServer({ port: 0 }, () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });

      const peers = new Map<string, Endpoint>();

      server.on("connection", (ws: WebSocket) => {
        ws.on("message", (data: Buffer) => {
          const msg = JSON.parse(data.toString());

          if (msg.type === "register") {
            peers.set(msg.peerId, msg.endpoint);
            ws.send(JSON.stringify({ type: "registered" }));
          }

          if (msg.type === "request_connect") {
            const endpoint = peers.get(msg.targetId);
            if (endpoint) {
              ws.send(JSON.stringify({ type: "peer_endpoint", endpoint }));
            } else {
              ws.send(JSON.stringify({ type: "error", reason: "peer_not_found" }));
            }
          }
        });
      });
    });
  }

  beforeEach(() => startServer());

  afterEach(() => {
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("register envia endpoint e recebe confirmação", async () => {
    const client = new SignalingClient(`ws://127.0.0.1:${port}`);
    await client.register("peer-a", { host: "1.2.3.4", port: 5000 });
    client.close();
  });

  it("requestConnect retorna endpoint do peer registrado", async () => {
    const client = new SignalingClient(`ws://127.0.0.1:${port}`);

    await client.register("peer-b", { host: "5.6.7.8", port: 9000 });
    const result = await client.requestConnect("peer-a", "peer-b");

    expect(result.endpoint.host).toBe("5.6.7.8");
    expect(result.endpoint.port).toBe(9000);
    client.close();
  });

  it("requestConnect lança EdenSignalingError quando peer não existe", async () => {
    const client = new SignalingClient(`ws://127.0.0.1:${port}`);

    await expect(client.requestConnect("peer-a", "ghost-peer"))
      .rejects.toThrow(EdenSignalingError);

    client.close();
  });

  it("lança EdenSignalingError quando servidor não responde dentro do timeout", async () => {
    // servidor que nunca responde
    const silentServer = new WebSocketServer({ port: 0 });
    const silentPort = await new Promise<number>((resolve) => {
      silentServer.on("listening", () => {
        resolve((silentServer.address() as { port: number }).port);
      });
    });

    const client = new SignalingClient(`ws://127.0.0.1:${silentPort}`, { timeoutMs: 100 });

    await expect(client.register("peer-x", { host: "1.2.3.4", port: 1 }))
      .rejects.toThrow(EdenSignalingError);

    client.close();
    await new Promise<void>((resolve) => silentServer.close(() => resolve()));
  });

  it("timeout no send() remove listener do WebSocket (sem leak)", async () => {
    // Servidor que aceita register mas nunca responde a request_connect
    const leakServer = new WebSocketServer({ port: 0 });
    const leakPort = await new Promise<number>((resolve) => {
      leakServer.on("listening", () => {
        resolve((leakServer.address() as { port: number }).port);
      });
    });

    leakServer.on("connection", (ws: WebSocket) => {
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "register") {
          ws.send(JSON.stringify({ type: "registered" }));
        }
        // request_connect → silêncio total (força timeout)
      });
    });

    const client = new SignalingClient(`ws://127.0.0.1:${leakPort}`, { timeoutMs: 50 });
    await client.register("leak-peer", { host: "1.2.3.4", port: 1 });

    // Acessa o WS interno para contar listeners
    const ws = (client as any).ws as WebSocket;
    const before = ws.listenerCount("message");

    // 5 requestConnect que dão timeout — cada um adicionava listener sem remover
    for (let i = 0; i < 5; i++) {
      await client.requestConnect("leak-peer", "ghost").catch(() => {});
    }

    const after = ws.listenerCount("message");
    // Sem o fix, after seria before + 5. Com o fix, deve ser igual ao before.
    expect(after).toBe(before);

    client.close();
    await new Promise<void>((resolve) => leakServer.close(() => resolve()));
  });

  it("register envia publicKey junto com peerId e endpoint", async () => {
    // Server que captura o que recebeu
    const capturedServer = new WebSocketServer({ port: 0 });
    const capturedPort = await new Promise<number>((resolve) => {
      capturedServer.on("listening", () => {
        resolve((capturedServer.address() as { port: number }).port);
      });
    });

    let capturedMsg: any = null;
    capturedServer.on("connection", (ws: WebSocket) => {
      ws.on("message", (data: Buffer) => {
        capturedMsg = JSON.parse(data.toString());
        ws.send(JSON.stringify({ type: "registered" }));
      });
    });

    const client = new SignalingClient(`ws://127.0.0.1:${capturedPort}`);
    await client.register("peer-pk", { host: "1.2.3.4", port: 5000 }, "aabbccdd");

    expect(capturedMsg.publicKey).toBe("aabbccdd");
    expect(capturedMsg.peerId).toBe("peer-pk");

    client.close();
    await new Promise<void>((resolve) => capturedServer.close(() => resolve()));
  });

  it("requestConnect retorna endpoint and publicKey", async () => {
    // Server that returns publicKey in peer_endpoint
    const pkServer = new WebSocketServer({ port: 0 });
    const pkPort = await new Promise<number>((resolve) => {
      pkServer.on("listening", () => {
        resolve((pkServer.address() as { port: number }).port);
      });
    });

    pkServer.on("connection", (ws: WebSocket) => {
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "register") {
          ws.send(JSON.stringify({ type: "registered" }));
        }
        if (msg.type === "request_connect") {
          ws.send(JSON.stringify({
            type: "peer_endpoint",
            endpoint: { host: "5.6.7.8", port: 9000 },
            publicKey: "deadbeef",
          }));
        }
      });
    });

    const client = new SignalingClient(`ws://127.0.0.1:${pkPort}`);
    await client.register("peer-a", { host: "1.2.3.4", port: 5000 });
    const result = await client.requestConnect("peer-a", "peer-b");

    expect(result.endpoint.host).toBe("5.6.7.8");
    expect(result.endpoint.port).toBe(9000);
    expect(result.publicKey).toBe("deadbeef");

    client.close();
    await new Promise<void>((resolve) => pkServer.close(() => resolve()));
  });

  it("dois peers distintos conseguem trocar endpoints", async () => {
    const clientA = new SignalingClient(`ws://127.0.0.1:${port}`);
    const clientB = new SignalingClient(`ws://127.0.0.1:${port}`);

    await clientA.register("peer-aa", { host: "10.0.0.1", port: 4000 });
    await clientB.register("peer-bb", { host: "10.0.0.2", port: 4001 });

    const resultA = await clientB.requestConnect("peer-bb", "peer-aa");
    const resultB = await clientA.requestConnect("peer-aa", "peer-bb");

    expect(resultA.endpoint).toEqual({ host: "10.0.0.1", port: 4000 });
    expect(resultB.endpoint).toEqual({ host: "10.0.0.2", port: 4001 });

    clientA.close();
    clientB.close();
  });
});
