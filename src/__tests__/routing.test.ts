import { MessageRouter } from "../routing/message-router.js";

function makeMockServer(connected = true) {
  const sent: Array<{ targetPeerId: string; payload: Buffer }> = [];
  return {
    isConnected: () => connected,
    send: (targetPeerId: string, payload: Buffer) => {
      if (!connected) throw new Error("server offline");
      sent.push({ targetPeerId, payload });
    },
    sent,
  };
}

function makeMockMesh() {
  const emitted: Buffer[] = [];
  return {
    emit: (msg: Buffer) => { emitted.push(msg); },
    emitted,
  };
}

describe("MessageRouter", () => {
  it("routes 1:1 message via server when server is up", () => {
    const server = makeMockServer(true);
    const mesh = makeMockMesh();
    const router = new MessageRouter({ server, mesh });

    router.send("peer-bob", Buffer.from("hello"));

    expect(server.sent).toHaveLength(1);
    expect(server.sent[0]!.targetPeerId).toBe("peer-bob");
    expect(mesh.emitted).toHaveLength(0);
  });

  it("falls back to mesh when server is down", () => {
    const server = makeMockServer(false);
    const mesh = makeMockMesh();
    const router = new MessageRouter({ server, mesh });

    router.send("peer-bob", Buffer.from("hello"));

    expect(server.sent).toHaveLength(0);
    expect(mesh.emitted).toHaveLength(1);
  });

  it("falls back to mesh when server.send throws", () => {
    const server = makeMockServer(true);
    // Override send to throw
    server.send = () => { throw new Error("connection lost"); };
    const mesh = makeMockMesh();
    const router = new MessageRouter({ server, mesh });

    router.send("peer-bob", Buffer.from("hello"));

    expect(mesh.emitted).toHaveLength(1);
  });

  it("broadcast always uses mesh", () => {
    const server = makeMockServer(true);
    const mesh = makeMockMesh();
    const router = new MessageRouter({ server, mesh });

    router.broadcast(Buffer.from("hello everyone"));

    expect(server.sent).toHaveLength(0);
    expect(mesh.emitted).toHaveLength(1);
  });

  it("transition is transparent — same API for both paths", () => {
    const serverUp = makeMockServer(true);
    const serverDown = makeMockServer(false);
    const mesh1 = makeMockMesh();
    const mesh2 = makeMockMesh();

    const router1 = new MessageRouter({ server: serverUp, mesh: mesh1 });
    const router2 = new MessageRouter({ server: serverDown, mesh: mesh2 });

    // Same API, different routes
    router1.send("peer-x", Buffer.from("msg"));
    router2.send("peer-x", Buffer.from("msg"));

    expect(serverUp.sent).toHaveLength(1);
    expect(mesh1.emitted).toHaveLength(0);
    expect(mesh2.emitted).toHaveLength(1);
  });
});
