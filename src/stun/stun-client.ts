import dgram from "node:dgram";
import { Endpoint } from "../transports/transport.js";
import { EdenStunTimeoutError } from "../errors/errors.js";
import { buildBindingRequest, parseBindingResponse } from "./stun-message.js";

interface StunServer {
  host: string;
  port: number;
}

type DgramSocket = Pick<dgram.Socket, "send" | "on" | "bind" | "close">;

interface StunClientOptions {
  timeoutMs?: number;
  createSocket?: () => DgramSocket;
  keepAlive?: boolean;   // não fechar socket após descoberta (socket compartilhado)
  prebound?: boolean;    // socket já está bound, pular socket.bind()
}

const DEFAULT_TIMEOUT_MS = 3000;

export class StunClient {
  constructor(
    private readonly servers: StunServer[],
    private readonly options: StunClientOptions = {}
  ) {}

  async discover(): Promise<Endpoint> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const createSocket = this.options.createSocket ?? (() => dgram.createSocket("udp4"));

    const socket = createSocket();

    return new Promise<Endpoint>((resolve, reject) => {
      let resolved = false;

      const done = (result: Endpoint | Error) => {
        if (resolved) return;
        resolved = true;
        if (!this.options.keepAlive) socket.close();
        if (result instanceof Error) {
          reject(result);
        } else {
          resolve(result);
        }
      };

      socket.on("message", (msg: Buffer) => {
        const endpoint = parseBindingResponse(msg);
        if (endpoint) done({ host: endpoint.ip, port: endpoint.port });
      });

      const sendRequests = () => {
        const { message } = buildBindingRequest();
        for (const server of this.servers) {
          socket.send(message, server.port, server.host);
        }
      };

      if (this.options.prebound) {
        sendRequests();
      } else {
        socket.bind(0, sendRequests);
      }

      setTimeout(() => {
        done(new EdenStunTimeoutError(this.servers.map((s) => `${s.host}:${s.port}`)));
      }, timeoutMs);
    });
  }
}
