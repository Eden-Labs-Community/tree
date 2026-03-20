import { WebSocket } from "ws";
import { EdenTransport } from "../transports/transport.js";

export class RelayClient implements EdenTransport {
  private ws: WebSocket | null = null;
  private onMessage: ((msg: Buffer) => void) | null = null;
  private queue: Buffer[] = [];

  constructor(
    private readonly relayUrl: string,
    private readonly peerId: string,
    private readonly targetPeerId: string
  ) {}

  send(msg: Buffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.relay(msg);
    } else {
      this.queue.push(msg);
      this.connect();
    }
  }

  bind(_port: number, onMessage: (msg: Buffer) => void): void {
    this.onMessage = onMessage;
    this.connect().catch(() => {}); // inicia conexão para poder receber mensagens
  }

  /** Conecta ao relay server e aguarda estar pronto para enviar/receber. */
  waitForReady(): Promise<void> {
    return this.connect();
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    this.queue = [];
    if (ws) {
      ws.on("error", () => {}); // suppress late error events
      try { ws.terminate(); } catch { /* ignore */ }
    }
  }

  private relay(msg: Buffer): void {
    this.ws!.send(
      JSON.stringify({
        type: "relay",
        fromPeerId: this.peerId,
        targetPeerId: this.targetPeerId,
        payload: msg.toString("base64"),
      })
    );
  }

  private connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();

    if (this.ws) {
      // already connecting — wait for open
      return new Promise<void>((resolve) => this.ws!.once("open", () => resolve()));
    }

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.relayUrl);
      this.ws = ws;

      ws.once("open", () => {
        ws.send(JSON.stringify({ type: "identify", peerId: this.peerId }));
      });

      ws.once("error", (err) => reject(err));

      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "identified") {
          for (const m of this.queue) this.relay(m);
          this.queue = [];
          resolve();
        }
        if (msg.type === "data" && this.onMessage) {
          this.onMessage(Buffer.from(msg.payload as string, "base64"));
        }
      });
    });
  }
}
