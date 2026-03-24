import dgram from "node:dgram";
import { EdenTransport, Endpoint } from "../transport.js";
import { StunClient } from "../../stun/stun-client.js";
import { SignalingClient } from "../../signaling/signaling-client.js";
import { HolePuncher, PROBE_MAGIC } from "../../hole-punch/hole-puncher.js";
import { RelayClient } from "../../relay/relay-client.js";

const DEFAULT_STUN_SERVERS = [
  { host: "stun.l.google.com", port: 19302 },
  { host: "stun.cloudflare.com", port: 3478 },
];

interface P2PTransportOptions {
  stunServers?: { host: string; port: number }[];
  stunTimeoutMs?: number;
  punchTimeoutMs?: number;
  signalingTimeoutMs?: number;
}

/**
 * P2PTransport — UDP com NAT traversal automático.
 *
 * Estratégia (Happy Eyeballs):
 *  1. Descobre endpoint público via STUN (opcional — skip se stunServers=[])
 *  2. Troca endpoints com peer via Signaling
 *  3. Tenta hole punching direto
 *  4. Se falhar, cai para Relay via signaling server
 */
export class P2PTransport implements EdenTransport {
  private socket: dgram.Socket | null = null;
  private relay: RelayClient | null = null;
  private onMessage: ((msg: Buffer) => void) | null = null;
  private peerEndpoint: Endpoint | null = null;

  constructor(
    private readonly peerId: string,
    private readonly signalingUrl: string,
    private readonly options: P2PTransportOptions = {}
  ) {}

  async connect(targetPeerId: string): Promise<void> {
    // 1. Criar socket UDP local
    this.socket = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => this.socket!.bind(0, resolve));
    const localPort = (this.socket.address() as { port: number }).port;

    if (this.onMessage) {
      this.socket.on("message", this.onMessage);
    }

    // 2. Descobrir endpoint público via STUN (pula se stunServers=[])
    const stunServers = this.options.stunServers ?? DEFAULT_STUN_SERVERS;
    let publicHost = "127.0.0.1";

    if (stunServers.length > 0) {
      try {
        const stun = new StunClient(stunServers, {
          timeoutMs: this.options.stunTimeoutMs ?? 3000,
        });
        const ep = await stun.discover();
        publicHost = ep.host;
      } catch {
        // sem internet ou STUN indisponível — usa loopback
      }
    }

    // 3. Registrar no Signaling e obter endpoint do peer
    const signaling = new SignalingClient(this.signalingUrl, {
      timeoutMs: this.options.signalingTimeoutMs ?? 5000,
    });

    await signaling.register(this.peerId, { host: publicHost, port: localPort });

    // Retry requestConnect — peer remoto pode ainda não ter registrado
    let remoteEndpoint: Endpoint | null = null;
    const maxRetries = 5;
    const retryDelayMs = 200;

    for (let i = 0; i < maxRetries; i++) {
      try {
        const result = await signaling.requestConnect(this.peerId, targetPeerId);
        remoteEndpoint = result.endpoint;
        break;
      } catch {
        if (i < maxRetries - 1) {
          await new Promise<void>((r) => setTimeout(r, retryDelayMs));
        }
      }
    }

    if (!remoteEndpoint) {
      signaling.close();
      await this.setupRelay(targetPeerId);
      return;
    }

    signaling.close();

    // 4. Tentar hole punching (punchTimeoutMs=0 força relay direto)
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
      this.peerEndpoint = remoteEndpoint;
    } else {
      await this.setupRelay(targetPeerId);
    }
  }

  send(msg: Buffer): void {
    if (this.relay) {
      this.relay.send(msg);
    } else if (this.socket && this.peerEndpoint) {
      this.socket.send(msg, this.peerEndpoint.port, this.peerEndpoint.host);
    }
  }

  bind(_port: number, onMessage: (msg: Buffer) => void): void {
    // filtra probes do hole puncher — não chegam na aplicação
    const filtered = (msg: Buffer) => {
      if (msg.toString() === PROBE_MAGIC) return;
      onMessage(msg);
    };
    this.onMessage = filtered;
    if (this.socket) this.socket.on("message", filtered);
    if (this.relay) this.relay.bind(0, filtered);
  }

  close(): void {
    try { this.socket?.close(); } catch { /* already closed */ }
    this.relay?.close();
    this.socket = null;
    this.relay = null;
    this.peerEndpoint = null;
  }

  private async setupRelay(targetPeerId: string): Promise<void> {
    this.relay = new RelayClient(this.signalingUrl, this.peerId, targetPeerId);
    if (this.onMessage) this.relay.bind(0, this.onMessage);
    await this.relay.waitForReady();
  }
}
