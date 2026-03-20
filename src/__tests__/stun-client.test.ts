import { jest } from "@jest/globals";
import { StunClient } from "../stun/stun-client.js";
import { EdenStunTimeoutError } from "../errors/errors.js";

// TASK-004: StunClient discovers public endpoint via STUN
describe("StunClient", () => {
  function buildFakeResponse(ip: string, port: number): Buffer {
    const MAGIC = 0x2112a442;
    const xorPort = port ^ (MAGIC >>> 16);
    const parts = ip.split(".").map(Number);
    const ipInt = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
    const xorIp = (ipInt ^ MAGIC) >>> 0;

    const attr = Buffer.alloc(12);
    attr.writeUInt16BE(0x0020, 0);
    attr.writeUInt16BE(8, 2);
    attr.writeUInt8(0x00, 4);
    attr.writeUInt8(0x01, 5);
    attr.writeUInt16BE(xorPort, 6);
    attr.writeUInt32BE(xorIp, 8);

    const header = Buffer.alloc(20);
    header.writeUInt16BE(0x0101, 0);
    header.writeUInt16BE(attr.length, 2);
    header.writeUInt32BE(MAGIC, 4);

    return Buffer.concat([header, attr]);
  }

  function makeFakeSocket(onSend?: (msg: Buffer, port: number, host: string) => void) {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

    const socket = {
      on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners[event] = listeners[event] ?? [];
        listeners[event]!.push(cb);
      }),
      bind: jest.fn((_port: number, cb: () => void) => {
        setImmediate(cb);
      }),
      send: jest.fn((msg: Buffer, port: number, host: string) => {
        onSend?.(msg, port, host);
      }),
      close: jest.fn(),
      emit: (event: string, ...args: unknown[]) => {
        for (const cb of listeners[event] ?? []) cb(...args);
      },
    };

    return socket;
  }

  it("resolves with discovered endpoint when server responds", async () => {
    const socket = makeFakeSocket((_msg, _port, _host) => {
      setImmediate(() => socket.emit("message", buildFakeResponse("203.0.113.42", 54321)));
    });

    const client = new StunClient(
      [{ host: "stun.l.google.com", port: 19302 }],
      { timeoutMs: 1000, createSocket: () => socket as any }
    );

    const endpoint = await client.discover();

    expect(endpoint.host).toBe("203.0.113.42");
    expect(endpoint.port).toBe(54321);
    expect(socket.close).toHaveBeenCalled();
  });

  it("uses the first server that responds when multiple are configured", async () => {
    let calls = 0;
    const socket = makeFakeSocket(() => {
      calls++;
      if (calls === 2) {
        setImmediate(() => socket.emit("message", buildFakeResponse("10.0.0.1", 9999)));
      }
    });

    const client = new StunClient(
      [
        { host: "slow.stun.example", port: 19302 },
        { host: "fast.stun.example", port: 19302 },
      ],
      { timeoutMs: 1000, createSocket: () => socket as any }
    );

    const endpoint = await client.discover();
    expect(endpoint.host).toBe("10.0.0.1");
    expect(endpoint.port).toBe(9999);
  });

  it("throws EdenStunTimeoutError when no server responds", async () => {
    const socket = makeFakeSocket();

    const client = new StunClient(
      [{ host: "unreachable.example", port: 19302 }],
      { timeoutMs: 50, createSocket: () => socket as any }
    );

    await expect(client.discover()).rejects.toThrow(EdenStunTimeoutError);
    expect(socket.close).toHaveBeenCalled();
  });

  it("keepAlive: true does not close the socket after discovery", async () => {
    const socket = makeFakeSocket((_msg, _port, _host) => {
      setImmediate(() => socket.emit("message", buildFakeResponse("1.2.3.4", 5678)));
    });

    const client = new StunClient(
      [{ host: "stun.l.google.com", port: 19302 }],
      { timeoutMs: 1000, createSocket: () => socket as any, keepAlive: true }
    );

    await client.discover();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("prebound: true does not call socket.bind()", async () => {
    const socket = makeFakeSocket((_msg, _port, _host) => {
      setImmediate(() => socket.emit("message", buildFakeResponse("5.6.7.8", 4321)));
    });

    const client = new StunClient(
      [{ host: "stun.l.google.com", port: 19302 }],
      { timeoutMs: 1000, createSocket: () => socket as any, prebound: true }
    );

    await client.discover();
    expect(socket.bind).not.toHaveBeenCalled();
  });

  it("does not resolve twice if multiple servers respond", async () => {
    let resolveCount = 0;
    const socket = makeFakeSocket(() => {
      // two servers respond immediately
      setImmediate(() => socket.emit("message", buildFakeResponse("1.1.1.1", 1111)));
      setImmediate(() => socket.emit("message", buildFakeResponse("2.2.2.2", 2222)));
    });

    const client = new StunClient(
      [
        { host: "a.stun.example", port: 19302 },
        { host: "b.stun.example", port: 19302 },
      ],
      { timeoutMs: 500, createSocket: () => socket as any }
    );

    const endpoint = await client.discover().then((e) => { resolveCount++; return e; });
    expect(resolveCount).toBe(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });
});
