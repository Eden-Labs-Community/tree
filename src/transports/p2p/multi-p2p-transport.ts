import dgram from "node:dgram";
import { EdenTransport, Endpoint } from "../transport.js";
import { StunClient } from "../../stun/stun-client.js";
import { SignalingClient } from "../../signaling/signaling-client.js";
import { HolePuncher, PROBE_MAGIC } from "../../hole-punch/hole-puncher.js";
import { RelayClient } from "../../relay/relay-client.js";
import { SignalingSentinel } from "../../signaling/signaling-sentinel.js";
import { SentinelElection, SENTINEL_HEARTBEAT_MAGIC } from "../../sentinel/sentinel-election.js";

type PeerState =
  | { mode: "direct"; endpoint: Endpoint }
  | { mode: "relay"; relay: RelayClient };

const DEFAULT_STUN_SERVERS = [
  { host: "stun.l.google.com", port: 19302 },
  { host: "stun.cloudflare.com", port: 3478 },
];

// Magic cookie RFC 5389 — bytes 4-7 de qualquer mensagem STUN
const STUN_MAGIC_COOKIE = 0x2112a442;

function isStunPacket(msg: Buffer): boolean {
  if (msg.length < 8) return false;
  return msg.readUInt32BE(4) === STUN_MAGIC_COOKIE;
}

interface MultiP2PTransportOptions {
  stunServers?: { host: string; port: number }[];
  stunTimeoutMs?: number;
  punchTimeoutMs?: number;
  signalingTimeoutMs?: number;
  sentinel?: boolean;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  cascadeStepMs?: number;
}

/**
 * MultiP2PTransport — socket único com NAT traversal por peer.
 *
 * Combina as vantagens do MultiUdpTransport (1 fd para N peers) com
 * o NAT traversal do P2PTransport (STUN + hole punch + relay).
 *
 * Uso:
 *   transport.bind(0, onMessage);        // cria e prepara socket
 *   await transport.addPeer(myId, targetId, signalingUrl);
 *   transport.send(msg);                 // fanout para todos os peers
 */
export class MultiP2PTransport implements EdenTransport {
  private socket: dgram.Socket | null = null;
  private onMessage: ((msg: Buffer) => void) | null = null;
  private bindPort = 0;
  private bindPromise: Promise<void> | null = null;
  private publicEndpoint: Endpoint | null = null;
  private readonly peers = new Map<string, PeerState>();
  private sentinel: SignalingSentinel | null = null;
  private election: SentinelElection | null = null;
  private myId: string | null = null;
  private lastSignalingUrl: string | null = null;

  constructor(private readonly options: MultiP2PTransportOptions = {}) {}

  bind(port: number, onMessage: (msg: Buffer) => void): void {
    this.bindPort = port;
    this.socket = dgram.createSocket("udp4");
    this.onMessage = (msg: Buffer) => {
      if (msg.toString() === PROBE_MAGIC) return;
      if (isStunPacket(msg)) return;
      const str = msg.toString();
      if (str.startsWith(SENTINEL_HEARTBEAT_MAGIC)) {
        this.election?.handleHeartbeat(msg);
        return;
      }
      onMessage(msg);
    };
    this.socket.on("message", this.onMessage);
  }

  send(msg: Buffer): void {
    for (const peer of this.peers.values()) {
      if (peer.mode === "direct") {
        try {
          this.socket?.send(msg, peer.endpoint.port, peer.endpoint.host);
        } catch { /* socket closed */ }
      } else {
        peer.relay.send(msg);
      }
    }
  }

  close(): void {
    this.election?.stop();
    this.election = null;
    this.sentinel?.stop();
    this.sentinel = null;
    for (const peer of this.peers.values()) {
      if (peer.mode === "relay") peer.relay.close();
    }
    this.peers.clear();
    try { this.socket?.close(); } catch { /* already closed */ }
    this.socket = null;
    this.bindPromise = null;
    this.publicEndpoint = null;
  }

  async addPeer(myId: string, targetId: string, signalingUrl: string): Promise<void> {
    if (!this.socket) throw new Error("Must call bind() before addPeer()");

    // Bug 3: limpar peer existente antes de sobrescrever (evita relay leak)
    this.removePeer(targetId);

    // Bug 2: promise compartilhada para evitar bind() duplo em addPeer() paralelos
    if (!this.bindPromise) {
      this.bindPromise = new Promise<void>((resolve) => this.socket!.bind(this.bindPort, resolve));
    }
    await this.bindPromise;

    const localPort = (this.socket.address() as { port: number }).port;

    // Bônus: cache do publicEndpoint — mesmo socket, mesmo resultado
    const stunServers = this.options.stunServers ?? DEFAULT_STUN_SERVERS;

    if (!this.publicEndpoint && stunServers.length > 0) {
      try {
        const stun = new StunClient(stunServers, {
          timeoutMs: this.options.stunTimeoutMs ?? 3000,
          createSocket: () => this.socket as any,
          keepAlive: true,
          prebound: true,
        });
        const ep = await stun.discover();
        this.publicEndpoint = { host: ep.host, port: localPort };
      } catch {
        // no internet or STUN unavailable — use loopback
        this.publicEndpoint = { host: "127.0.0.1", port: localPort };
      }
    }

    const publicHost = this.publicEndpoint?.host ?? "127.0.0.1";

    // Register in Signaling and get peer endpoint
    const signaling = new SignalingClient(signalingUrl, {
      timeoutMs: this.options.signalingTimeoutMs ?? 5000,
    });

    await signaling.register(myId, { host: publicHost, port: localPort });

    let remoteEndpoint: Endpoint | null = null;
    const maxRetries = 5;
    const retryDelayMs = 200;

    for (let i = 0; i < maxRetries; i++) {
      try {
        remoteEndpoint = await signaling.requestConnect(myId, targetId);
        break;
      } catch {
        if (i < maxRetries - 1) {
          await new Promise<void>((r) => setTimeout(r, retryDelayMs));
        }
      }
    }

    if (!remoteEndpoint) {
      signaling.close();
      await this.setupRelay(myId, targetId, signalingUrl);
      return;
    }

    signaling.close();

    // Attempt hole punching (punchTimeoutMs=0 forces relay directly)
    const punchTimeout = this.options.punchTimeoutMs ?? 3000;
    let punched = false;

    if (punchTimeout > 0) {
      const puncher = new HolePuncher(this.socket, {
        timeoutMs: punchTimeout,
        probeIntervalMs: 100,
      });
      punched = await puncher.punch(remoteEndpoint);
    }

    if (punched) {
      this.peers.set(targetId, { mode: "direct", endpoint: remoteEndpoint });
    } else {
      await this.setupRelay(myId, targetId, signalingUrl);
    }

    // Track state for election
    this.myId = myId;
    this.lastSignalingUrl = signalingUrl;

    // Inicia sentinel + election na primeira conexão bem-sucedida
    if (this.options.sentinel && !this.election) {
      this.election = new SentinelElection({
        peerId: myId,
        heartbeatIntervalMs: this.options.heartbeatIntervalMs,
        heartbeatTimeoutMs: this.options.heartbeatTimeoutMs,
        cascadeStepMs: this.options.cascadeStepMs,
        sendHeartbeat: (msg) => this.send(msg),
        getSuccessors: () => [...this.peers.keys()],
        onPromoted: () => this.handlePromoted(signalingUrl, publicHost, localPort),
        onDemoted: () => this.handleDemoted(),
      });

      // First peer with sentinel=true becomes sentinel
      this.sentinel = new SignalingSentinel({
        url: signalingUrl,
        peerId: myId,
        endpoint: { host: publicHost, port: localPort },
      });
      this.sentinel.start().catch(() => { /* sentinel start failure is non-fatal */ });
      this.election.startAsSentinel();
    } else if (this.options.sentinel && this.election) {
      this.election.peerAdded(targetId);
    }
  }

  removePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer?.mode === "relay") peer.relay.close();
    this.peers.delete(peerId);
    this.election?.peerRemoved(peerId);
    if (this.peers.size === 0) {
      this.election?.stop();
      this.election = null;
    }
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  getSentinel(): SignalingSentinel | null {
    return this.sentinel;
  }

  getElection(): SentinelElection | null {
    return this.election;
  }

  private handlePromoted(signalingUrl: string, publicHost: string, localPort: number): void {
    if (!this.myId) return;
    this.sentinel = new SignalingSentinel({
      url: signalingUrl,
      peerId: this.myId,
      endpoint: { host: publicHost, port: localPort },
    });
    this.sentinel.start().catch(() => { /* sentinel start failure is non-fatal */ });
  }

  private handleDemoted(): void {
    this.sentinel?.stop();
    this.sentinel = null;
  }

  private async setupRelay(myId: string, targetId: string, signalingUrl: string): Promise<void> {
    const relay = new RelayClient(signalingUrl, myId, targetId);
    if (this.onMessage) relay.bind(0, this.onMessage);
    await relay.waitForReady();
    this.peers.set(targetId, { mode: "relay", relay });
  }
}
