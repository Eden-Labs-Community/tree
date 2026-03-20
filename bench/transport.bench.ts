/**
 * Eden Core — Transport Benchmark
 *
 * Mede throughput (msg/s) e latência (p50/p95/p99) via ping-pong sequencial.
 * Compara:
 *   1. UdpTransport (baseline — UDP puro)
 *   2. P2PTransport via hole punch (UDP com NAT traversal)
 *   3. P2PTransport via relay (WebSocket fallback)
 *
 * Uso: npm run bench
 */

import { WebSocketServer, WebSocket } from "ws";
import { Eden } from "../src/eden/eden.js";
import { P2PTransport } from "../src/transports/p2p/p2p-transport.js";

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
  process.stdout.write("  [1/3] UdpTransport... ");
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
  process.stdout.write("  [2/3] P2PTransport (hole punch)... ");
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
  process.stdout.write("  [3/3] P2PTransport (relay)... ");
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

  // ── Comparativo ──────────────────────────────────────────────────────────
  const udpP50 = [...udpLat].sort((a, b) => a - b)[Math.floor(udpLat.length * 0.5)]!;
  const p2pP50 = [...p2pLat].sort((a, b) => a - b)[Math.floor(p2pLat.length * 0.5)]!;
  const relP50 = [...relLat].sort((a, b) => a - b)[Math.floor(relLat.length * 0.5)]!;

  console.log("\n  Overhead vs UDP puro (p50)");
  console.log("  ─────────────────────────────────────────────────────");
  console.log(`  P2PTransport (hole punch) : +${(((p2pP50 - udpP50) / udpP50) * 100).toFixed(1)}%`);
  console.log(`  P2PTransport (relay)      : +${(((relP50 - udpP50) / udpP50) * 100).toFixed(1)}%`);
  console.log("\n  Nota: loopback 127.0.0.1 — latências reais em rede serão maiores.\n");

  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
