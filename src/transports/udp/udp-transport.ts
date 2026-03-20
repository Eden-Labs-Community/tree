import dgram from "node:dgram";
import { EdenTransport, Endpoint } from "../transport.js";

export class UdpTransport implements EdenTransport {
  private readonly socket: dgram.Socket;

  constructor(private readonly target: Endpoint) {
    this.socket = dgram.createSocket("udp4");
  }

  send(msg: Buffer): void {
    this.socket.send(msg, this.target.port, this.target.host);
  }

  bind(port: number, onMessage: (msg: Buffer) => void): void {
    this.socket.bind(port);
    this.socket.on("message", onMessage);
  }

  close(): void {
    try { this.socket.close(); } catch { /* already closed */ }
  }
}
