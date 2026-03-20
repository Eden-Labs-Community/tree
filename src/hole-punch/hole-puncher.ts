import { Endpoint } from "../transports/transport.js";

export const PROBE_MAGIC = "__eden_punch__";

// Após resolver, continua enviando probes por este período para garantir
// que o peer remoto também detecte a resposta (simetria do hole punch)
const SYMMETRY_GRACE_MS = 300;

interface DgramSocket {
  send(msg: Buffer, port: number, host: string): void;
  on(event: "message", handler: (msg: Buffer, rinfo: { address: string; port: number }) => void): void;
  off(event: "message", handler: (msg: Buffer, rinfo: { address: string; port: number }) => void): void;
}

interface HolePuncherOptions {
  timeoutMs?: number;
  probeIntervalMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_PROBE_INTERVAL_MS = 150;

export class HolePuncher {
  constructor(
    private readonly socket: DgramSocket,
    private readonly options: HolePuncherOptions = {}
  ) {}

  punch(remote: Endpoint): Promise<boolean> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const probeIntervalMs = this.options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    const probe = Buffer.from(PROBE_MAGIC);

    return new Promise<boolean>((resolve) => {
      let resolved = false;

      const interval = setInterval(() => {
        try {
          this.socket.send(probe, remote.port, remote.host);
        } catch {
          clearInterval(interval); // socket foi fechado durante o grace period
        }
      }, probeIntervalMs);

      const onMessage = (msg: Buffer, rinfo: { address: string; port: number }) => {
        if (msg.toString() !== PROBE_MAGIC || resolved) return;
        if (rinfo.address !== remote.host || rinfo.port !== remote.port) return;

        resolved = true;
        clearTimeout(timer);
        this.socket.off("message", onMessage);

        // Continua enviando probes brevemente para garantir simetria
        setTimeout(() => clearInterval(interval), SYMMETRY_GRACE_MS);
        resolve(true);
      };

      this.socket.on("message", onMessage);

      try { this.socket.send(probe, remote.port, remote.host); } catch { /* socket fechado */ }

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        this.socket.off("message", onMessage);
        clearInterval(interval);
        resolve(false);
      }, timeoutMs);
    });
  }
}
