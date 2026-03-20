import { WebSocket } from "ws";
import { Endpoint } from "../transports/transport.js";
import { EdenSentinelError } from "../errors/errors.js";

export interface SignalingSentinelOptions {
  url: string;
  peerId: string;
  endpoint: Endpoint;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  backoffMultiplier?: number;
  onReconnect?: () => void;
  onDisconnect?: () => void;
}

const DEFAULT_INITIAL_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;

export class SignalingSentinel {
  private readonly url: string;
  private readonly peerId: string;
  private endpoint: Endpoint;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly backoffMultiplier: number;
  private readonly onReconnect: (() => void) | undefined;
  private readonly onDisconnect: (() => void) | undefined;

  private ws: WebSocket | null = null;
  private connectingWs: WebSocket | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;

  constructor(options: SignalingSentinelOptions) {
    this.url = options.url;
    this.peerId = options.peerId;
    this.endpoint = options.endpoint;
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.backoffMultiplier = options.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
    this.onReconnect = options.onReconnect;
    this.onDisconnect = options.onDisconnect;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connectAndRegister();
  }

  stop(): void {
    this.stopped = true;

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.connectingWs) {
      this.connectingWs.removeAllListeners();
      this.connectingWs.on("error", () => {});
      try { this.connectingWs.terminate(); } catch { /* already closed */ }
      this.connectingWs = null;
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.on("error", () => {});
      try { this.ws.terminate(); } catch { /* already closed */ }
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  updateEndpoint(ep: Endpoint): void {
    this.endpoint = ep;
    if (this.isConnected()) {
      this.sendRegister();
    }
  }

  private connectAndRegister(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.stopped) return resolve();

      const ws = new WebSocket(this.url);
      this.connectingWs = ws;

      ws.once("open", () => {
        this.connectingWs = null;

        if (this.stopped) {
          ws.terminate();
          return resolve();
        }

        this.ws = ws;
        this.attempt = 0;
        this.setupListeners();
        this.sendRegister();

        const onMessage = (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "registered") {
              ws.off("message", onMessage);
              resolve();
            }
          } catch { /* ignore non-JSON */ }
        };
        ws.on("message", onMessage);
      });

      ws.once("error", (err) => {
        this.connectingWs = null;
        if (!this.ws) {
          reject(new EdenSentinelError(`Failed to connect: ${err.message}`));
        }
      });
    });
  }

  private setupListeners(): void {
    if (!this.ws) return;

    const handleClose = () => {
      this.ws = null;
      if (this.stopped) return;
      this.onDisconnect?.();
      this.scheduleReconnect();
    };

    this.ws.on("close", handleClose);
    this.ws.on("error", () => {
      // Error will be followed by close event — let close handler deal with it
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;

    const delay = Math.min(
      this.initialBackoffMs * Math.pow(this.backoffMultiplier, this.attempt),
      this.maxBackoffMs
    );
    this.attempt++;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped) return;

      try {
        await this.connectAndRegister();
        this.onReconnect?.();
      } catch {
        // Connection failed — schedule next attempt
        if (!this.stopped) this.scheduleReconnect();
      }
    }, delay);
  }

  private sendRegister(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      type: "register",
      peerId: this.peerId,
      endpoint: this.endpoint,
    }));
  }
}
