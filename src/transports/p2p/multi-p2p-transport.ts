import dgram from "node:dgram";
import { EdenTransport, Endpoint } from "../transport.js";
import { StunClient } from "../../stun/stun-client.js";
import { SignalingClient } from "../../signaling/signaling-client.js";
import { HolePuncher, PROBE_MAGIC } from "../../hole-punch/hole-puncher.js";
import { RelayClient } from "../../relay/relay-client.js";

type PeerState =
  | { mode: "direct"; endpoint: Endpoint }
  | { mode: "relay"; relay: RelayClient };

const DEFAULT_STUN_SERVERS = [
  { host: "stun.l.google.com", port: 19302 },
  { host: "stun.cloudflare.com", port: 3478 },
];

interface MultiP2PTransportOptions {
  stunServers?: { host: string; port: number }[];
  stunTimeoutMs?: number;
  punchTimeoutMs?: number;
  signalingTimeoutMs?: number;
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
  private socketBound = false;
  private readonly peers = new Map<string, PeerState>();

  constructor(private readonly options: MultiP2PTransportOptions = {}) {}

  bind(port: number, onMessage: (msg: Buffer) => void): void {
    this.bindPort = port;
    this.socket = dgram.createSocket("udp4");
    this.onMessage = (msg: Buffer) => {
      if (msg.toString() === PROBE_MAGIC) return;
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
    for (const peer of this.peers.values()) {
      if (peer.mode === "relay") peer.relay.close();
    }
    this.peers.clear();
    try { this.socket?.close(); } catch { /* already closed */ }
    this.socket = null;
  }

  async addPeer(myId: string, targetId: string, signalingUrl: string): Promise<void> {
    if (!this.socket) throw new Error("Must call bind() before addPeer()");

    // Ensure socket is bound before using it
    if (!this.socketBound) {
      await new Promise<void>((resolve) => this.socket!.bind(this.bindPort, resolve));
      this.socketBound = true;
    }

    const localPort = (this.socket.address() as { port: number }).port;

    // Discover public endpoint via STUN (keepAlive + prebound to share socket)
    const stunServers = this.options.stunServers ?? DEFAULT_STUN_SERVERS;
    let publicHost = "127.0.0.1";

    if (stunServers.length > 0) {
      try {
        const stun = new StunClient(stunServers, {
          timeoutMs: this.options.stunTimeoutMs ?? 3000,
          createSocket: () => this.socket as any,
          keepAlive: true,
          prebound: true,
        });
        const ep = await stun.discover();
        publicHost = ep.host;
      } catch {
        // no internet or STUN unavailable — use loopback
      }
    }

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
  }

  removePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer?.mode === "relay") peer.relay.close();
    this.peers.delete(peerId);
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  private async setupRelay(myId: string, targetId: string, signalingUrl: string): Promise<void> {
    const relay = new RelayClient(signalingUrl, myId, targetId);
    if (this.onMessage) relay.bind(0, this.onMessage);
    await relay.waitForReady();
    this.peers.set(targetId, { mode: "relay", relay });
  }
}
