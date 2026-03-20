/**
 * Eden Core — Transport Benchmark
 *
 * Mede throughput (msg/s) e latência (p50/p95/p99) via ping-pong sequencial.
 * Compara:
 *   1. UdpTransport (baseline — UDP puro)
 *   2. P2PTransport via hole punch (UDP com NAT traversal)
 *   3. P2PTransport via relay (WebSocket fallback)
 *   4. MultiUdpTransport — fanout 1 socket para N peers
 *   5. MultiP2PTransport — socket único + NAT traversal por peer (hole punch + relay)
 *
 * Uso: npm run bench
 */

import dgram from "node:dgram";
import { WebSocketServer, WebSocket } from "ws";
import { Eden } from "../src/eden/eden.js";
import { P2PTransport } from "../src/transports/p2p/p2p-transport.js";
import { MultiP2PTransport } from "../src/transports/p2p/multi-p2p-transport.js";
import { MultiUdpTransport } from "../src/transports/udp/multi-udp-transport.js";
import { UdpTransport } from "../src/transports/udp/udp-transport.js";

const WARMUP = 100;
const SAMPLES = 1000;

const BENCH_EDEN_OPTS = {};

// ─── Helpers ────────────────────────────────────────────────────────────────

function hrMs(): number {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1_000_000;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function printStats(label: string, latencies: number[], totalMs: number) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const throughput = Math.round((latencies.length / totalMs) * 1000);

  console.log(`\n  ${label}`);
  console.log(`  ${"─".repeat(52)}`);
  console.log(`  Throughput  : ${throughput.toLocaleString()} msg/s`);
  console.log(`  Latência p50: ${percentile(sorted, 50).toFixed(3)} ms`);
  console.log(`  Latência p95: ${percentile(sorted, 95).toFixed(3)} ms`);
  console.log(`  Latência p99: ${percentile(sorted, 99).toFixed(3)} ms`);
  console.log(`  Média       : ${mean.toFixed(3)} ms`);
  console.log(`  Total       : ${latencies.length} msgs em ${totalMs.toFixed(1)} ms`);
}

// ─── Ping-pong sequencial ────────────────────────────────────────────────────
// Envia uma mensagem, aguarda o receiver ecoar de volta, mede RTT.

async function runPingPong(sender: Eden, receiver: Eden, samples: number): Promise<number[]> {
  // Receiver ecoa tudo de volta para o sender
  const echoUnsub = receiver.on("bench:transport:ping", (env) => {
    receiver.emit("bench:transport:pong", env.payload);
  });

  const latencies: number[] = [];

  for (let i = 0; i < samples; i++) {
    const start = hrMs();
    await new Promise<void>((resolve) => {
      const unsub = sender.on("bench:transport:pong", () => {
        unsub();
        latencies.push(hrMs() - start);
        resolve();
      });
      sender.emit("bench:transport:ping", { seq: i });
    });
  }

  echoUnsub();
  return latencies;
}

// ─── Signaling server in-process ────────────────────────────────────────────

function startSignalingServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ port: 0 }, () => {
      const port = (server.address() as { port: number }).port;
      const peers = new Map<string, { endpoint: { host: string; port: number }; ws: WebSocket }>();

      server.on("connection", (ws: WebSocket) => {
        ws.on("message", (data: Buffer) => {
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
            if (target?.ws.readyState === WebSocket.OPEN) {
              target.ws.send(JSON.stringify({ type: "data", from: msg.fromPeerId, payload: msg.payload }));
            }
          }
          if (msg.type === "identify") {
            const existing = peers.get(msg.peerId);
            if (existing) peers.set(msg.peerId, { ...existing, ws });
          }
        });
      });

      resolve({ port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log(  "║          Eden Core — Transport Benchmark              ║");
  console.log(  "╚═══════════════════════════════════════════════════════╝");
  console.log(`  Método: ping-pong sequencial (RTT)`);
  console.log(`  Warmup: ${WARMUP} msgs | Amostras: ${SAMPLES} msgs\n`);

  // ── 1. UdpTransport (baseline) ──────────────────────────────────────────
  process.stdout.write("  [1/5] UdpTransport... ");
  const portA = 42100;
  const portB = 42101;
  const udpA = new Eden({ listenPort: portA, remote: { host: "127.0.0.1", port: portB }, ...BENCH_EDEN_OPTS });
  const udpB = new Eden({ listenPort: portB, remote: { host: "127.0.0.1", port: portA }, ...BENCH_EDEN_OPTS });
  await new Promise((r) => setTimeout(r, 100)); // aguarda sockets UDP bindarem

  await runPingPong(udpA, udpB, WARMUP);
  const udpStart = hrMs();
  const udpLat = await runPingPong(udpA, udpB, SAMPLES);
  const udpTotal = hrMs() - udpStart;

  udpA.stop();
  udpB.stop();
  process.stdout.write("done\n");
  printStats("UdpTransport — UDP puro (baseline)", udpLat, udpTotal);

  // ── 2. P2PTransport (hole punch) ─────────────────────────────────────────
  process.stdout.write("  [2/5] P2PTransport (hole punch)... ");
  const sig1 = await startSignalingServer();
  const url1 = `ws://127.0.0.1:${sig1.port}`;
  const pOpts = { stunServers: [], punchTimeoutMs: 2000, signalingTimeoutMs: 3000 };

  const tA = new P2PTransport("bench-a", url1, pOpts);
  const tB = new P2PTransport("bench-b", url1, pOpts);
  const p2pA = new Eden({ listenPort: 0, remote: { host: "127.0.0.1", port: 0 }, transport: () => tA, ...BENCH_EDEN_OPTS });
  const p2pB = new Eden({ listenPort: 0, remote: { host: "127.0.0.1", port: 0 }, transport: () => tB, ...BENCH_EDEN_OPTS });

  await Promise.all([tA.connect("bench-b"), tB.connect("bench-a")]);

  await runPingPong(p2pA, p2pB, WARMUP);
  const p2pStart = hrMs();
  const p2pLat = await runPingPong(p2pA, p2pB, SAMPLES);
  const p2pTotal = hrMs() - p2pStart;

  p2pA.stop();
  p2pB.stop();
  await sig1.close();
  process.stdout.write("done\n");
  printStats("P2PTransport — hole punch (UDP direto pós-conexão)", p2pLat, p2pTotal);

  // ── 3. P2PTransport (relay) ──────────────────────────────────────────────
  process.stdout.write("  [3/5] P2PTransport (relay)... ");
  const sig2 = await startSignalingServer();
  const url2 = `ws://127.0.0.1:${sig2.port}`;
  const rOpts = { stunServers: [], punchTimeoutMs: 0, signalingTimeoutMs: 3000 };

  const tC = new P2PTransport("bench-c", url2, rOpts);
  const tD = new P2PTransport("bench-d", url2, rOpts);
  const relA = new Eden({ listenPort: 0, remote: { host: "127.0.0.1", port: 0 }, transport: () => tC, ...BENCH_EDEN_OPTS });
  const relB = new Eden({ listenPort: 0, remote: { host: "127.0.0.1", port: 0 }, transport: () => tD, ...BENCH_EDEN_OPTS });

  await Promise.all([tC.connect("bench-d"), tD.connect("bench-c")]);

  await runPingPong(relA, relB, WARMUP);
  const relStart = hrMs();
  const relLat = await runPingPong(relA, relB, SAMPLES);
  const relTotal = hrMs() - relStart;

  relA.stop();
  relB.stop();
  await sig2.close();
  process.stdout.write("done\n");
  printStats("P2PTransport — relay via WebSocket (fallback)", relLat, relTotal);

  // ── 4. MultiUdpTransport — fanout hub → N peers ─────────────────────────
  // Cenário: hub envia 1 mensagem para N peers simultâneos.
  // Latência = tempo até o ÚLTIMO peer receber (tail latency).
  // Comparativo: MultiUdpTransport (1 socket) vs N UdpTransport (N sockets).

  const FANOUT_PEER_COUNTS = [10, 50, 200];
  const FANOUT_WARMUP = 50;
  const FANOUT_SAMPLES = 200;
  const MULTI_BASE_PORT = 43000;

  console.log("\n  MultiUdpTransport — Fanout hub → N peers");
  console.log("  ─────────────────────────────────────────────────────");
  console.log("  Métrica: tail latency (último peer receber) — menor é melhor\n");

  for (const N of FANOUT_PEER_COUNTS) {
    // Sockets que representam os N peers receptores
    const peerSockets: dgram.Socket[] = [];
    const peerPorts: number[] = [];

    await new Promise<void>((resolve) => {
      let bound = 0;
      for (let i = 0; i < N; i++) {
        const sock = dgram.createSocket("udp4");
        const port = MULTI_BASE_PORT + i;
        peerSockets.push(sock);
        peerPorts.push(port);
        sock.bind(port, () => { if (++bound === N) resolve(); });
      }
    });

    // ── MultiUdpTransport (1 socket) ──
    const hub = new MultiUdpTransport();
    for (const port of peerPorts) hub.addPeer({ host: "127.0.0.1", port });

    const runFanout = async (send: () => void): Promise<number> => {
      const start = hrMs();
      await new Promise<void>((resolve) => {
        let received = 0;
        for (const sock of peerSockets) {
          sock.once("message", () => { if (++received === N) resolve(); });
        }
        send();
      });
      return hrMs() - start;
    };

    const multiLat: number[] = [];
    for (let i = 0; i < FANOUT_WARMUP; i++) await runFanout(() => hub.send(Buffer.from("w")));
    for (let i = 0; i < FANOUT_SAMPLES; i++) multiLat.push(await runFanout(() => hub.send(Buffer.from("x"))));
    hub.close();

    // ── N UdpTransport (N sockets) ──
    const udpInstances = peerPorts.map((port) => new UdpTransport({ host: "127.0.0.1", port }));

    const udpLats: number[] = [];
    const runFanoutUdp = async () => {
      const start = hrMs();
      await new Promise<void>((resolve) => {
        let received = 0;
        for (const sock of peerSockets) {
          sock.once("message", () => { if (++received === N) resolve(); });
        }
        for (const t of udpInstances) t.send(Buffer.from("x"));
      });
      return hrMs() - start;
    };

    for (let i = 0; i < FANOUT_WARMUP; i++) await runFanoutUdp();
    for (let i = 0; i < FANOUT_SAMPLES; i++) udpLats.push(await runFanoutUdp());
    for (const t of udpInstances) t.close();
    for (const sock of peerSockets) sock.close();

    const multiSorted = [...multiLat].sort((a, b) => a - b);
    const udpSorted = [...udpLats].sort((a, b) => a - b);
    const multiP50 = percentile(multiSorted, 50);
    const multiP95 = percentile(multiSorted, 95);
    const udpP50 = percentile(udpSorted, 50);
    const udpP95 = percentile(udpSorted, 95);
    const overhead = (((multiP50 - udpP50) / udpP50) * 100).toFixed(1);

    console.log(`  N=${String(N).padEnd(3)}  MultiUdp  p50=${multiP50.toFixed(3)}ms  p95=${multiP95.toFixed(3)}ms  (1 socket)`);
    console.log(`         ${N}xUdpTp  p50=${udpP50.toFixed(3)}ms  p95=${udpP95.toFixed(3)}ms  (${N} sockets)  overhead=${overhead}%`);
    console.log();
  }

  // ── 5. MultiP2PTransport (hole punch + relay) ────────────────────────────
  // Ping-pong direto (sem Eden) — mede latência do transporte isolado.
  // bind() deve ser chamado antes de addPeer().

  // Helper: cria um par de MultiP2PTransport já conectados.
  // tA usa um handler mutable (ref) para que o ping-pong possa registrar
  // callbacks one-shot sem precisar rebindar o socket.
  async function setupMultiP2PPair(
    url: string,
    idA: string,
    idB: string,
    opts: { stunServers: never[]; punchTimeoutMs: number; signalingTimeoutMs: number }
  ): Promise<{ tA: MultiP2PTransport; tB: MultiP2PTransport; setHandlerA: (fn: (m: Buffer) => void) => void }> {
    const tA = new MultiP2PTransport(opts);
    const tB = new MultiP2PTransport(opts);

    let handlerA: (m: Buffer) => void = () => {};

    tA.bind(0, (msg) => handlerA(msg));
    tB.bind(0, (msg) => tB.send(msg)); // echo

    await Promise.all([
      tA.addPeer(idA, idB, url),
      tB.addPeer(idB, idA, url),
    ]);

    return { tA, tB, setHandlerA: (fn) => { handlerA = fn; } };
  }

  async function runMultiP2PPingPong(
    tA: MultiP2PTransport,
    setHandlerA: (fn: (m: Buffer) => void) => void,
    samples: number
  ): Promise<number[]> {
    const latencies: number[] = [];
    for (let i = 0; i < samples; i++) {
      const start = hrMs();
      await new Promise<void>((resolve) => {
        setHandlerA(() => { setHandlerA(() => {}); resolve(); });
        tA.send(Buffer.from("ping"));
      });
      latencies.push(hrMs() - start);
    }
    return latencies;
  }

  process.stdout.write("  [5a/5] MultiP2PTransport (hole punch)... ");
  const sig3 = await startSignalingServer();
  const url3 = `ws://127.0.0.1:${sig3.port}`;
  const mpOpts = { stunServers: [] as never[], punchTimeoutMs: 2000, signalingTimeoutMs: 3000 };

  const { tA: mpA, tB: mpB, setHandlerA: setMpA } = await setupMultiP2PPair(url3, "mp-bench-a", "mp-bench-b", mpOpts);

  await runMultiP2PPingPong(mpA, setMpA, WARMUP);
  const mpStart = hrMs();
  const mpLat = await runMultiP2PPingPong(mpA, setMpA, SAMPLES);
  const mpTotal = hrMs() - mpStart;

  mpA.close();
  mpB.close();
  await sig3.close();
  process.stdout.write("done\n");
  printStats("MultiP2PTransport — hole punch (socket único, UDP direto)", mpLat, mpTotal);

  process.stdout.write("  [5b/5] MultiP2PTransport (relay)... ");
  const sig4 = await startSignalingServer();
  const url4 = `ws://127.0.0.1:${sig4.port}`;
  const mpRelOpts = { stunServers: [] as never[], punchTimeoutMs: 0, signalingTimeoutMs: 3000 };

  const { tA: mpC, tB: mpD, setHandlerA: setMpC } = await setupMultiP2PPair(url4, "mp-rel-c", "mp-rel-d", mpRelOpts);

  await runMultiP2PPingPong(mpC, setMpC, WARMUP);
  const mpRelStart = hrMs();
  const mpRelLat = await runMultiP2PPingPong(mpC, setMpC, SAMPLES);
  const mpRelTotal = hrMs() - mpRelStart;

  mpC.close();
  mpD.close();
  await sig4.close();
  process.stdout.write("done\n");
  printStats("MultiP2PTransport — relay via WebSocket (fallback)", mpRelLat, mpRelTotal);

  // ── Comparativo ──────────────────────────────────────────────────────────
  const udpP50 = [...udpLat].sort((a, b) => a - b)[Math.floor(udpLat.length * 0.5)]!;
  const p2pP50 = [...p2pLat].sort((a, b) => a - b)[Math.floor(p2pLat.length * 0.5)]!;
  const relP50 = [...relLat].sort((a, b) => a - b)[Math.floor(relLat.length * 0.5)]!;
  const mpP50  = [...mpLat].sort((a, b) => a - b)[Math.floor(mpLat.length * 0.5)]!;
  const mpRelP50 = [...mpRelLat].sort((a, b) => a - b)[Math.floor(mpRelLat.length * 0.5)]!;

  console.log("\n  Overhead vs UDP puro (p50)");
  console.log("  ─────────────────────────────────────────────────────");
  console.log(`  P2PTransport (hole punch)      : +${(((p2pP50 - udpP50) / udpP50) * 100).toFixed(1)}%`);
  console.log(`  MultiP2PTransport (hole punch) : +${(((mpP50  - udpP50) / udpP50) * 100).toFixed(1)}%`);
  console.log(`  P2PTransport (relay)           : +${(((relP50 - udpP50) / udpP50) * 100).toFixed(1)}%`);
  console.log(`  MultiP2PTransport (relay)      : +${(((mpRelP50 - udpP50) / udpP50) * 100).toFixed(1)}%`);
  console.log("\n  Nota: loopback 127.0.0.1 — latências reais em rede serão maiores.\n");

  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
