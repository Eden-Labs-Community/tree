import dgram from "node:dgram";
import { WebSocketServer, WebSocket } from "ws";
import { MultiP2PTransport } from "../transports/p2p/multi-p2p-transport.js";
import { SENTINEL_HEARTBEAT_MAGIC } from "../sentinel/sentinel-election.js";

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
            ws.send(JSON.stringify({ type: "identified" }));
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

  it("addPeer paralelo não causa EINVAL de bind duplo", async () => {
    const url = `ws://127.0.0.1:${signalingPort}`;
    const t = new MultiP2PTransport(testOpts);
    t.bind(0, () => {});

    // Dois addPeer simultâneos — o segundo não pode tentar socket.bind() de novo
    await expect(
      Promise.all([
        t.addPeer("race-a", "race-b", url).catch(() => {}),
        t.addPeer("race-a", "race-c", url).catch(() => {}),
      ])
    ).resolves.not.toThrow();

    t.close();
  }, 8000);

  it("addPeer duplicado fecha relay antigo antes de reconectar", (done) => {
    const url = `ws://127.0.0.1:${signalingPort}`;
    const opts = { stunServers: [], punchTimeoutMs: 0, signalingTimeoutMs: 2000 };
    const tA = new MultiP2PTransport(opts);
    const tB = new MultiP2PTransport(opts);

    tB.bind(0, () => {});
    tA.bind(0, () => {});

    // Primeira conexão
    Promise.all([
      tA.addPeer("dup-a", "dup-b", url),
      tB.addPeer("dup-b", "dup-a", url),
    ]).then(() => {
      expect(tA.getPeerCount()).toBe(1);

      // Segunda conexão com o mesmo targetId — deve limpar a anterior sem leak
      tA.addPeer("dup-a", "dup-b", url).then(() => {
        expect(tA.getPeerCount()).toBe(1); // continua 1, não 2
        tA.close();
        tB.close();
        done();
      });
    });
  }, 10000);

  it("pacotes STUN binários não chegam no onMessage da aplicação", (done) => {
    const url = `ws://127.0.0.1:${signalingPort}`;
    const tA = new MultiP2PTransport(testOpts);
    const tB = new MultiP2PTransport(testOpts);

    const received: string[] = [];
    tB.bind(0, (msg) => {
      received.push(msg.toString());
    });
    tA.bind(0, () => {});

    Promise.all([
      tA.addPeer("stun-a", "stun-b", url),
      tB.addPeer("stun-b", "stun-a", url),
    ]).then(() => {
      // Simula pacote STUN binário chegando no socket de tB
      // Magic cookie 0x2112A442 nos bytes 4-7
      const stunPacket = Buffer.alloc(20);
      stunPacket.writeUInt16BE(0x0101, 0); // Binding Response
      stunPacket.writeUInt16BE(0, 2);       // length
      stunPacket.writeUInt32BE(0x2112a442, 4); // magic cookie

      // Envia pacote STUN diretamente via UDP para o socket de tB
      const sender = dgram.createSocket("udp4");
      const tBPort = (tB as any).socket.address().port;
      sender.send(stunPacket, tBPort, "127.0.0.1", () => {
        sender.close();

        // Envia mensagem real depois
        tA.send(Buffer.from("real-message"));

        setTimeout(() => {
          // Deve ter recebido só a mensagem real, não o pacote STUN
          expect(received).toEqual(["real-message"]);
          tA.close();
          tB.close();
          done();
        }, 300);
      });
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

  it("sentinel=true cria sentinel após primeiro addPeer", (done) => {
    const url = `ws://127.0.0.1:${signalingPort}`;
    const opts = { ...testOpts, sentinel: true };
    const tA = new MultiP2PTransport(opts);
    const tB = new MultiP2PTransport(testOpts);

    tB.bind(0, () => {});
    tA.bind(0, () => {});

    expect(tA.getSentinel()).toBeNull();

    Promise.all([
      tA.addPeer("sent-a", "sent-b", url),
      tB.addPeer("sent-b", "sent-a", url),
    ]).then(() => {
      // Aguardar sentinel.start() assíncrono
      setTimeout(() => {
        const sentinel = tA.getSentinel();
        expect(sentinel).not.toBeNull();
        expect(sentinel!.isConnected()).toBe(true);
        tA.close();
        tB.close();
        done();
      }, 200);
    });
  }, 8000);

  it("close() para o sentinel", (done) => {
    const url = `ws://127.0.0.1:${signalingPort}`;
    const opts = { ...testOpts, sentinel: true };
    const tA = new MultiP2PTransport(opts);
    const tB = new MultiP2PTransport(testOpts);

    tB.bind(0, () => {});
    tA.bind(0, () => {});

    Promise.all([
      tA.addPeer("sent-close-a", "sent-close-b", url),
      tB.addPeer("sent-close-b", "sent-close-a", url),
    ]).then(() => {
      setTimeout(() => {
        const sentinel = tA.getSentinel();
        expect(sentinel).not.toBeNull();

        tA.close();

        expect(tA.getSentinel()).toBeNull();
        expect(sentinel!.isConnected()).toBe(false);
        tB.close();
        done();
      }, 200);
    });
  }, 8000);

  // --- Fase 2: Integração SentinelElection ---

  it("heartbeat messages são filtrados em bind() e não chegam no app", (done) => {
    const url = `ws://127.0.0.1:${signalingPort}`;
    const tA = new MultiP2PTransport(testOpts);
    const tB = new MultiP2PTransport(testOpts);

    const received: string[] = [];
    tB.bind(0, (msg) => {
      received.push(msg.toString());
    });
    tA.bind(0, () => {});

    Promise.all([
      tA.addPeer("hb-filt-a", "hb-filt-b", url),
      tB.addPeer("hb-filt-b", "hb-filt-a", url),
    ]).then(() => {
      // Envia heartbeat diretamente via UDP para o socket de tB
      const heartbeatMsg = SENTINEL_HEARTBEAT_MAGIC + JSON.stringify({
        sentinelId: "hb-filt-a",
        epoch: 1,
        successors: ["hb-filt-b"],
        ts: Date.now(),
      });

      const sender = dgram.createSocket("udp4");
      const tBPort = (tB as any).socket.address().port;
      sender.send(Buffer.from(heartbeatMsg), tBPort, "127.0.0.1", () => {
        sender.close();

        // Envia mensagem real depois
        tA.send(Buffer.from("real-app-message"));

        setTimeout(() => {
          // Só a mensagem real deve ter chegado, não o heartbeat
          expect(received).toEqual(["real-app-message"]);
          tA.close();
          tB.close();
          done();
        }, 300);
      });
    });
  }, 8000);

  it("sentinel=true inicia election como sentinel após primeiro addPeer", (done) => {
    const url = `ws://127.0.0.1:${signalingPort}`;
    const opts = { ...testOpts, sentinel: true, heartbeatIntervalMs: 500 };
    const tA = new MultiP2PTransport(opts);
    const tB = new MultiP2PTransport(testOpts);

    tB.bind(0, () => {});
    tA.bind(0, () => {});

    expect(tA.getElection()).toBeNull();

    Promise.all([
      tA.addPeer("elec-a", "elec-b", url),
      tB.addPeer("elec-b", "elec-a", url),
    ]).then(() => {
      const election = tA.getElection();
      expect(election).not.toBeNull();
      expect(election!.isSentinelActive()).toBe(true);
      expect(election!.getEpoch()).toBe(1);

      tA.close();
      tB.close();
      done();
    });
  }, 8000);

  it("follower promove e cria SignalingSentinel quando sentinel morre", (done) => {
    const url = `ws://127.0.0.1:${signalingPort}`;
    // tA é sentinel, tB é follower com sentinel=true
    const sentinelOpts = { ...testOpts, sentinel: true, heartbeatIntervalMs: 200, heartbeatTimeoutMs: 600 };
    const tA = new MultiP2PTransport(sentinelOpts);
    const tB = new MultiP2PTransport(sentinelOpts);

    tB.bind(0, () => {});
    tA.bind(0, () => {});

    Promise.all([
      tA.addPeer("failover-a", "failover-b", url),
      tB.addPeer("failover-b", "failover-a", url),
    ]).then(() => {
      setTimeout(() => {
        // tA é sentinel, tB deve ter election como follower
        expect(tA.getElection()!.isSentinelActive()).toBe(true);
        expect(tB.getElection()!.isSentinelActive()).toBe(false);

        // tA morre
        tA.close();

        // Aguarda timeout do follower (600ms) + margem para sentinel.start()
        setTimeout(() => {
          expect(tB.getElection()!.isSentinelActive()).toBe(true);
          expect(tB.getSentinel()).not.toBeNull();

          tB.close();
          done();
        }, 1000);
      }, 400); // espera heartbeats iniciais propagarem
    });
  }, 10000);

  it("peer demovido perde SignalingSentinel", (done) => {
    const url = `ws://127.0.0.1:${signalingPort}`;
    const sentinelOpts = { ...testOpts, sentinel: true, heartbeatIntervalMs: 200, heartbeatTimeoutMs: 600 };
    const tA = new MultiP2PTransport(sentinelOpts);
    const tB = new MultiP2PTransport(sentinelOpts);

    tB.bind(0, () => {});
    tA.bind(0, () => {});

    Promise.all([
      tA.addPeer("demote-a", "demote-b", url),
      tB.addPeer("demote-b", "demote-a", url),
    ]).then(() => {
      setTimeout(() => {
        // tA é sentinel
        expect(tA.getSentinel()).not.toBeNull();
        expect(tA.getElection()!.isSentinelActive()).toBe(true);

        // Simula split-brain: tB recebe heartbeat com epoch maior de outro peer
        // Forçamos demotion via handleHeartbeat com epoch maior
        const higherEpochHb = Buffer.from(
          SENTINEL_HEARTBEAT_MAGIC + JSON.stringify({
            sentinelId: "demote-a",
            epoch: 99,
            successors: ["demote-b"],
            ts: Date.now(),
          })
        );

        // Se tA fosse sentinel com epoch=1 e recebesse epoch=99 de outro, demoção
        // Vamos testar via tA: enviar heartbeat com epoch maior de um "peer fantasma"
        const demotionHb = Buffer.from(
          SENTINEL_HEARTBEAT_MAGIC + JSON.stringify({
            sentinelId: "alpha-peer", // lexicograficamente menor que "demote-a"
            epoch: 50,
            successors: ["demote-a", "demote-b"],
            ts: Date.now(),
          })
        );
        tA.getElection()!.handleHeartbeat(demotionHb);

        // tA deve ter sido demovido
        expect(tA.getElection()!.isSentinelActive()).toBe(false);
        expect(tA.getSentinel()).toBeNull();

        tA.close();
        tB.close();
        done();
      }, 400);
    });
  }, 8000);

  it("removePeer com peers.size=0 para election (mesh morta)", (done) => {
    const url = `ws://127.0.0.1:${signalingPort}`;
    const sentinelOpts = { ...testOpts, sentinel: true, heartbeatIntervalMs: 200 };
    const tA = new MultiP2PTransport(sentinelOpts);
    const tB = new MultiP2PTransport(testOpts);

    tB.bind(0, () => {});
    tA.bind(0, () => {});

    Promise.all([
      tA.addPeer("mesh-dead-a", "mesh-dead-b", url),
      tB.addPeer("mesh-dead-b", "mesh-dead-a", url),
    ]).then(() => {
      expect(tA.getElection()).not.toBeNull();
      expect(tA.getElection()!.isSentinelActive()).toBe(true);

      // Remove o único peer — mesh morta
      tA.removePeer("mesh-dead-b");
      expect(tA.getPeerCount()).toBe(0);
      expect(tA.getElection()).toBeNull();

      tA.close();
      tB.close();
      done();
    });
  }, 8000);
});
