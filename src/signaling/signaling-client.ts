import { WebSocket } from "ws";
import { Endpoint } from "../transports/transport.js";
import { EdenSignalingError } from "../errors/errors.js";

type ServerMessage =
  | { type: "registered" }
  | { type: "peer_endpoint"; endpoint: Endpoint; publicKey?: string }
  | { type: "error"; reason: string };

export interface ConnectResult {
  endpoint: Endpoint;
  publicKey?: string;
}

interface SignalingClientOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private readonly timeoutMs: number;

  constructor(
    private readonly url: string,
    options: SignalingClientOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async register(peerId: string, endpoint: Endpoint, publicKey?: string): Promise<void> {
    const ws = await this.connect();
    const payload: Record<string, unknown> = { type: "register", peerId, endpoint };
    if (publicKey !== undefined) {
      payload["publicKey"] = publicKey;
    }
    await this.send(ws, payload, "registered");
  }

  async requestConnect(myId: string, targetId: string): Promise<ConnectResult> {
    const ws = await this.connect();
    const msg = await this.send(ws, { type: "request_connect", myId, targetId }, "peer_endpoint");
    const resp = msg as { type: "peer_endpoint"; endpoint: Endpoint; publicKey?: string };
    const result: ConnectResult = { endpoint: resp.endpoint };
    if (resp.publicKey !== undefined) {
      result.publicKey = resp.publicKey;
    }
    return result;
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  private connect(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve(this.ws);
    }

    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new EdenSignalingError("connection timeout"));
      }, this.timeoutMs);

      ws.once("open", () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve(ws);
      });

      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(new EdenSignalingError(err.message));
      });
    });
  }

  private send(
    ws: WebSocket,
    payload: object,
    expectedType: string
  ): Promise<ServerMessage> {
    return new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off("message", onMessage);
        reject(new EdenSignalingError(`timeout waiting for "${expectedType}"`));
      }, this.timeoutMs);

      const onMessage = (data: Buffer) => {
        const msg: ServerMessage = JSON.parse(data.toString());

        if (msg.type === "error") {
          clearTimeout(timer);
          ws.off("message", onMessage);
          reject(new EdenSignalingError(msg.reason));
          return;
        }

        if (msg.type === expectedType) {
          clearTimeout(timer);
          ws.off("message", onMessage);
          resolve(msg);
        }
      };

      ws.on("message", onMessage);
      ws.send(JSON.stringify(payload));
    });
  }
}
