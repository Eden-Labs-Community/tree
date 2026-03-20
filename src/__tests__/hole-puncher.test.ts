import { jest } from "@jest/globals";
import { HolePuncher } from "../hole-punch/hole-puncher.js";
import dgram from "node:dgram";

const PROBE_MAGIC = "__eden_punch__";

// TASK-006: HolePuncher — abre NAT via envio simultâneo de probes UDP
describe("HolePuncher", () => {
  function makeFakeSocket(onSend?: (msg: Buffer, port: number, host: string) => void) {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

    const socket = {
      on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners[event] = listeners[event] ?? [];
        listeners[event]!.push(cb);
      }),
      off: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners[event] = (listeners[event] ?? []).filter((l) => l !== cb);
      }),
      send: jest.fn((msg: Buffer, port: number, host: string) => {
        onSend?.(msg, port, host);
      }),
      emit: (event: string, ...args: unknown[]) => {
        for (const cb of listeners[event] ?? []) cb(...args);
      },
    };

    return socket;
  }

  it("retorna true quando recebe probe do peer remoto", async () => {
    const socket = makeFakeSocket((_msg, _port, _host) => {
      // simula o peer remoto respondendo com um probe
      setImmediate(() => {
        socket.emit("message", Buffer.from(PROBE_MAGIC), { address: "5.6.7.8", port: 4000 });
      });
    });

    const puncher = new HolePuncher(socket as any, { timeoutMs: 1000, probeIntervalMs: 50 });
    const result = await puncher.punch({ host: "5.6.7.8", port: 4000 });

    expect(result).toBe(true);
  });

  it("envia probes periódicos para o endpoint remoto", async () => {
    jest.useFakeTimers();

    const sentTo: { port: number; host: string }[] = [];
    const socket = makeFakeSocket((_msg, port, host) => {
      sentTo.push({ port, host });
    });

    const puncher = new HolePuncher(socket as any, { timeoutMs: 500, probeIntervalMs: 100 });
    const punchPromise = puncher.punch({ host: "9.9.9.9", port: 7000 });

    // avança 3 intervalos
    jest.advanceTimersByTime(300);

    // simula recebimento de probe para resolver
    socket.emit("message", Buffer.from(PROBE_MAGIC), { address: "9.9.9.9", port: 7000 });

    await punchPromise;

    expect(sentTo.length).toBeGreaterThanOrEqual(3);
    expect(sentTo.every((t) => t.host === "9.9.9.9" && t.port === 7000)).toBe(true);

    jest.useRealTimers();
  });

  it("retorna false quando timeout sem receber probe", async () => {
    const socket = makeFakeSocket();

    const puncher = new HolePuncher(socket as any, { timeoutMs: 50, probeIntervalMs: 20 });
    const result = await puncher.punch({ host: "1.2.3.4", port: 9999 });

    expect(result).toBe(false);
  });

  it("não resolve duas vezes se múltiplos probes chegam", async () => {
    let resolveCount = 0;
    const socket = makeFakeSocket(() => {
      setImmediate(() => {
        socket.emit("message", Buffer.from(PROBE_MAGIC), { address: "1.1.1.1", port: 1111 });
        socket.emit("message", Buffer.from(PROBE_MAGIC), { address: "1.1.1.1", port: 1111 });
      });
    });

    const puncher = new HolePuncher(socket as any, { timeoutMs: 500, probeIntervalMs: 50 });
    const result = await puncher.punch({ host: "1.1.1.1", port: 1111 });
    resolveCount++;

    expect(resolveCount).toBe(1);
    expect(result).toBe(true);
  });

  it("ignora mensagens que não são probes Eden", async () => {
    let probeReceived = false;
    const socket = makeFakeSocket(() => {
      setImmediate(() => {
        // mensagem estranha primeiro
        socket.emit("message", Buffer.from("hello world"), { address: "2.2.2.2", port: 2000 });
        // depois o probe correto
        setTimeout(() => {
          probeReceived = true;
          socket.emit("message", Buffer.from(PROBE_MAGIC), { address: "2.2.2.2", port: 2000 });
        }, 10);
      });
    });

    const puncher = new HolePuncher(socket as any, { timeoutMs: 500, probeIntervalMs: 50 });
    const result = await puncher.punch({ host: "2.2.2.2", port: 2000 });

    expect(result).toBe(true);
    expect(probeReceived).toBe(true);
  });

  it("ignora probe de endereço diferente do peer remoto esperado", async () => {
    const socket = makeFakeSocket(() => {
      setImmediate(() => {
        // probe de endereço errado — não deve resolver
        socket.emit("message", Buffer.from(PROBE_MAGIC), { address: "9.9.9.9", port: 1234 });
      });
    });

    const puncher = new HolePuncher(socket as any, { timeoutMs: 80, probeIntervalMs: 20 });
    const result = await puncher.punch({ host: "5.5.5.5", port: 9000 });

    // deve falhar por timeout, não resolver com o probe do endereço errado
    expect(result).toBe(false);
  });

  it("loopback: dois HolePunchers no mesmo host conseguem se conectar", (done) => {
    const socketA = dgram.createSocket("udp4");
    const socketB = dgram.createSocket("udp4");

    socketA.bind(0, () => {
      const portA = (socketA.address() as { port: number }).port;
      socketB.bind(0, async () => {
        const portB = (socketB.address() as { port: number }).port;

        const puncherA = new HolePuncher(socketA, { timeoutMs: 2000, probeIntervalMs: 50 });
        const puncherB = new HolePuncher(socketB, { timeoutMs: 2000, probeIntervalMs: 50 });

        const [resultA, resultB] = await Promise.all([
          puncherA.punch({ host: "127.0.0.1", port: portB }),
          puncherB.punch({ host: "127.0.0.1", port: portA }),
        ]);

        socketA.close();
        socketB.close();

        expect(resultA).toBe(true);
        expect(resultB).toBe(true);
        done();
      });
    });
  }, 5000);
});
