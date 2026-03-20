import { WebSocketServer, WebSocket } from "ws";
import { SignalingSentinel } from "../signaling/signaling-sentinel.js";
import { Endpoint } from "../transports/transport.js";

describe("SignalingSentinel", () => {
  let server: WebSocketServer;
  let port: number;

  const peers = new Map<string, { endpoint: Endpoint; ws: WebSocket }>();

  function createServerHandler(ws: WebSocket) {
    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString());

      if (msg.type === "register") {
        peers.set(msg.peerId, { endpoint: msg.endpoint, ws });
        ws.send(JSON.stringify({ type: "registered" }));
      }
    });
  }

  function startServer(usePort = 0): Promise<void> {
    peers.clear();
    return new Promise((resolve) => {
      server = new WebSocketServer({ port: usePort }, () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
      server.on("connection", createServerHandler);
    });
  }

  function stopServer(): Promise<void> {
    return new Promise((resolve) => {
      // Force-close all connections so close events fire immediately
      for (const client of server.clients) {
        client.terminate();
      }
      server.close(() => resolve());
    });
  }

  beforeEach(() => startServer());
  afterEach(() => stopServer(), 10000);

  it("start() conecta e registra no signaling server", async () => {
    const sentinel = new SignalingSentinel({
      url: `ws://127.0.0.1:${port}`,
      peerId: "sentinel-1",
      endpoint: { host: "1.2.3.4", port: 5000 },
    });

    await sentinel.start();

    expect(sentinel.isConnected()).toBe(true);
    expect(peers.has("sentinel-1")).toBe(true);
    expect(peers.get("sentinel-1")!.endpoint).toEqual({ host: "1.2.3.4", port: 5000 });

    sentinel.stop();
  });

  it("stop() é idempotente", async () => {
    const sentinel = new SignalingSentinel({
      url: `ws://127.0.0.1:${port}`,
      peerId: "sentinel-idem",
      endpoint: { host: "1.2.3.4", port: 5000 },
    });

    await sentinel.start();

    expect(() => sentinel.stop()).not.toThrow();
    expect(() => sentinel.stop()).not.toThrow();
    expect(sentinel.isConnected()).toBe(false);
  });

  it("reconecta com exponential backoff quando servidor desconecta", async () => {
    const savedPort = port;
    const sentinel = new SignalingSentinel({
      url: `ws://127.0.0.1:${savedPort}`,
      peerId: "sentinel-reconnect",
      endpoint: { host: "1.2.3.4", port: 5000 },
      initialBackoffMs: 100,
      maxBackoffMs: 1000,
    });

    await sentinel.start();
    expect(sentinel.isConnected()).toBe(true);

    // Derrubar servidor (force-close connections)
    await stopServer();

    // Aguardar sentinela detectar desconexão
    await new Promise<void>((r) => setTimeout(r, 100));
    expect(sentinel.isConnected()).toBe(false);

    // Reiniciar na mesma porta
    await startServer(savedPort);

    // Aguardar reconexão (backoff inicial 100ms + margem)
    await new Promise<void>((r) => setTimeout(r, 600));

    expect(sentinel.isConnected()).toBe(true);
    expect(peers.has("sentinel-reconnect")).toBe(true);

    sentinel.stop();
  }, 10000);

  it("backoff respeita maxBackoffMs", async () => {
    const sentinel = new SignalingSentinel({
      url: `ws://127.0.0.1:${port}`,
      peerId: "sentinel-max",
      endpoint: { host: "1.2.3.4", port: 5000 },
      initialBackoffMs: 50,
      maxBackoffMs: 200,
      backoffMultiplier: 2,
    });

    await sentinel.start();

    // Fechar servidor e não reiniciar — sentinela tenta reconectar
    await stopServer();

    // Esperar tempo suficiente para várias tentativas
    await new Promise<void>((r) => setTimeout(r, 800));

    // O sentinel deve ainda estar tentando (não parou), mas não estar conectado
    expect(sentinel.isConnected()).toBe(false);

    sentinel.stop();

    // Reiniciar servidor para afterEach
    await startServer();
  }, 10000);

  it("stop() interrompe loop de reconnect", async () => {
    const savedPort = port;
    const sentinel = new SignalingSentinel({
      url: `ws://127.0.0.1:${savedPort}`,
      peerId: "sentinel-stop-loop",
      endpoint: { host: "1.2.3.4", port: 5000 },
      initialBackoffMs: 100,
    });

    await sentinel.start();

    // Fechar servidor para forçar reconnect loop
    await stopServer();
    await new Promise<void>((r) => setTimeout(r, 50));

    // Parar sentinela antes de reconectar
    sentinel.stop();

    // Reiniciar servidor na mesma porta
    await startServer(savedPort);

    // Esperar além do backoff — sentinel NÃO deve reconectar
    peers.delete("sentinel-stop-loop");
    await new Promise<void>((r) => setTimeout(r, 500));

    expect(sentinel.isConnected()).toBe(false);
    expect(peers.has("sentinel-stop-loop")).toBe(false);
  }, 10000);

  it("chama onReconnect após reconexão e onDisconnect quando cai", async () => {
    const savedPort = port;
    let disconnected = false;
    let reconnected = false;

    const sentinel = new SignalingSentinel({
      url: `ws://127.0.0.1:${savedPort}`,
      peerId: "sentinel-callbacks",
      endpoint: { host: "1.2.3.4", port: 5000 },
      initialBackoffMs: 100,
      onDisconnect: () => { disconnected = true; },
      onReconnect: () => { reconnected = true; },
    });

    await sentinel.start();

    // Derrubar servidor
    await stopServer();
    await new Promise<void>((r) => setTimeout(r, 100));
    expect(disconnected).toBe(true);

    // Reiniciar na mesma porta
    await startServer(savedPort);

    await new Promise<void>((r) => setTimeout(r, 600));
    expect(reconnected).toBe(true);

    sentinel.stop();
  }, 10000);

  it("updateEndpoint re-registra em conexão ativa", async () => {
    const sentinel = new SignalingSentinel({
      url: `ws://127.0.0.1:${port}`,
      peerId: "sentinel-update",
      endpoint: { host: "1.2.3.4", port: 5000 },
    });

    await sentinel.start();
    expect(peers.get("sentinel-update")!.endpoint).toEqual({ host: "1.2.3.4", port: 5000 });

    sentinel.updateEndpoint({ host: "9.8.7.6", port: 6000 });

    // Aguardar re-registro
    await new Promise<void>((r) => setTimeout(r, 100));

    expect(peers.get("sentinel-update")!.endpoint).toEqual({ host: "9.8.7.6", port: 6000 });

    sentinel.stop();
  });
});
