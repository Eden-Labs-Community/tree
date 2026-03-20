import { SentinelElection, SENTINEL_HEARTBEAT_MAGIC } from "../sentinel/sentinel-election.js";

describe("SentinelElection", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function createElection(overrides: Partial<{
    peerId: string;
    heartbeatIntervalMs: number;
    heartbeatTimeoutMs: number;
    cascadeStepMs: number;
    onPromoted: () => void;
    onDemoted: () => void;
    sendHeartbeat: (msg: Buffer) => void;
    getSuccessors: () => string[];
  }> = {}) {
    const sent: Buffer[] = [];
    const callbacks = { promoted: 0, demoted: 0 };

    const election = new SentinelElection({
      peerId: overrides.peerId ?? "peer-A",
      heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 200,
      heartbeatTimeoutMs: overrides.heartbeatTimeoutMs ?? 600,
      cascadeStepMs: overrides.cascadeStepMs ?? 200,
      onPromoted: overrides.onPromoted ?? (() => { callbacks.promoted++; }),
      onDemoted: overrides.onDemoted ?? (() => { callbacks.demoted++; }),
      sendHeartbeat: overrides.sendHeartbeat ?? ((msg) => sent.push(msg)),
      getSuccessors: overrides.getSuccessors ?? (() => []),
    });

    return { election, sent, callbacks };
  }

  function parseHeartbeat(buf: Buffer) {
    const str = buf.toString();
    return JSON.parse(str.slice(SENTINEL_HEARTBEAT_MAGIC.length));
  }

  function makeHeartbeatMsg(payload: {
    sentinelId: string;
    epoch: number;
    successors: string[];
    ts?: number;
  }): Buffer {
    return Buffer.from(
      SENTINEL_HEARTBEAT_MAGIC +
        JSON.stringify({ ts: Date.now(), ...payload })
    );
  }

  // 1. startAsSentinel() chama sendHeartbeat imediatamente
  it("startAsSentinel() sends heartbeat immediately", () => {
    const { election, sent } = createElection();
    election.startAsSentinel();
    expect(sent.length).toBe(1);
    election.stop();
  });

  // 2. heartbeat contém epoch, sentinelId, successors corretos
  it("heartbeat contains correct epoch, sentinelId, successors", () => {
    const { election, sent } = createElection({
      peerId: "peer-X",
      getSuccessors: () => ["peer-Y", "peer-Z"],
    });
    election.startAsSentinel();
    const hb = parseHeartbeat(sent[0]!);
    expect(hb.sentinelId).toBe("peer-X");
    expect(hb.epoch).toBe(1);
    expect(hb.successors).toEqual(["peer-Y", "peer-Z"]);
    expect(typeof hb.ts).toBe("number");
    election.stop();
  });

  // 3. startAsFollower() não envia heartbeats (before timeout)
  it("startAsFollower() does not send heartbeats before timeout", () => {
    const { election, sent } = createElection({ heartbeatTimeoutMs: 600 });
    election.startAsFollower();
    // Advance to just before timeout — no heartbeats sent
    jest.advanceTimersByTime(500);
    expect(sent.length).toBe(0);
    election.stop();
  });

  // 4. follower recebendo heartbeat reseta timeout e armazena sentinelId
  it("follower receiving heartbeat resets timeout", () => {
    const { election, callbacks } = createElection({
      peerId: "peer-B",
      heartbeatTimeoutMs: 600,
    });
    election.startAsFollower();

    // Advance to just before timeout
    jest.advanceTimersByTime(500);
    expect(callbacks.promoted).toBe(0);

    // Send heartbeat — resets the timer
    election.handleHeartbeat(
      makeHeartbeatMsg({ sentinelId: "peer-A", epoch: 1, successors: ["peer-B"] })
    );

    // Advance another 500ms — would have timed out without the reset
    jest.advanceTimersByTime(500);
    expect(callbacks.promoted).toBe(0);

    // Now let it fully timeout
    jest.advanceTimersByTime(200);
    expect(callbacks.promoted).toBe(1);

    election.stop();
  });

  // 5. follower promove após timeout (sem heartbeats) → chama onPromoted
  it("follower promotes after timeout with no heartbeats", () => {
    const { election, callbacks, sent } = createElection({
      peerId: "peer-B",
      heartbeatTimeoutMs: 600,
    });
    election.startAsFollower();

    expect(election.isSentinelActive()).toBe(false);

    jest.advanceTimersByTime(600);

    expect(callbacks.promoted).toBe(1);
    expect(election.isSentinelActive()).toBe(true);
    // Should have sent a heartbeat upon promotion
    expect(sent.length).toBeGreaterThanOrEqual(1);

    election.stop();
  });

  // 6. cascade: successor #1 espera mais que #0
  it("cascade: successor #1 waits longer than #0", () => {
    const callbacksA = { promoted: 0 };
    const callbacksB = { promoted: 0 };

    const electionA = new SentinelElection({
      peerId: "peer-A",
      heartbeatIntervalMs: 200,
      heartbeatTimeoutMs: 600,
      cascadeStepMs: 200,
      onPromoted: () => { callbacksA.promoted++; },
      onDemoted: () => {},
      sendHeartbeat: () => {},
      getSuccessors: () => [],
    });

    const electionB = new SentinelElection({
      peerId: "peer-B",
      heartbeatIntervalMs: 200,
      heartbeatTimeoutMs: 600,
      cascadeStepMs: 200,
      onPromoted: () => { callbacksB.promoted++; },
      onDemoted: () => {},
      sendHeartbeat: () => {},
      getSuccessors: () => [],
    });

    electionA.startAsFollower();
    electionB.startAsFollower();

    // Both receive heartbeat with successors order: [peer-A, peer-B]
    const hb = makeHeartbeatMsg({
      sentinelId: "sentinel-0",
      epoch: 1,
      successors: ["peer-A", "peer-B"],
    });
    electionA.handleHeartbeat(hb);
    electionB.handleHeartbeat(hb);

    // After 600ms (timeout), peer-A (#0) should promote
    jest.advanceTimersByTime(600);
    expect(callbacksA.promoted).toBe(1);
    expect(callbacksB.promoted).toBe(0);

    // After 600 + 200ms (timeout + 1*cascadeStep), peer-B (#1) should promote
    jest.advanceTimersByTime(200);
    expect(callbacksB.promoted).toBe(1);

    electionA.stop();
    electionB.stop();
  });

  // 7. heartbeat durante cascade cancela promoção
  it("heartbeat during cascade cancels promotion", () => {
    const { election, callbacks } = createElection({
      peerId: "peer-B",
      heartbeatTimeoutMs: 600,
      cascadeStepMs: 200,
    });
    election.startAsFollower();

    // Receive initial heartbeat positioning us as successor #1
    election.handleHeartbeat(
      makeHeartbeatMsg({
        sentinelId: "sentinel-0",
        epoch: 1,
        successors: ["peer-A", "peer-B"],
      })
    );

    // Advance partway through cascade timeout (600 + 200 = 800)
    jest.advanceTimersByTime(700);
    expect(callbacks.promoted).toBe(0);

    // New sentinel sends heartbeat — cancel cascade
    election.handleHeartbeat(
      makeHeartbeatMsg({
        sentinelId: "peer-A",
        epoch: 2,
        successors: ["peer-B"],
      })
    );

    // Original timeout would have fired, but heartbeat reset it
    jest.advanceTimersByTime(200);
    expect(callbacks.promoted).toBe(0);

    election.stop();
  });

  // 8. split-brain: epoch maior vence → onDemoted
  it("split-brain: higher epoch wins, lower epoch demotes", () => {
    const { election: electionA, callbacks: cbA } = createElection({
      peerId: "peer-A",
    });

    electionA.startAsSentinel();
    expect(electionA.getEpoch()).toBe(1);

    // Receive heartbeat from another sentinel with higher epoch
    electionA.handleHeartbeat(
      makeHeartbeatMsg({
        sentinelId: "peer-B",
        epoch: 5,
        successors: ["peer-A"],
      })
    );

    expect(cbA.demoted).toBe(1);
    expect(electionA.isSentinelActive()).toBe(false);
    expect(electionA.getEpoch()).toBe(5);

    electionA.stop();
  });

  // 9. split-brain: mesmo epoch, peerId menor vence
  it("split-brain: same epoch, lower peerId wins", () => {
    const { election: electionB, callbacks: cbB } = createElection({
      peerId: "peer-B",
    });

    electionB.startAsSentinel();

    // Receive heartbeat from peer-A (lexicographically smaller) with same epoch
    electionB.handleHeartbeat(
      makeHeartbeatMsg({
        sentinelId: "peer-A",
        epoch: 1,
        successors: ["peer-B"],
      })
    );

    expect(cbB.demoted).toBe(1);
    expect(electionB.isSentinelActive()).toBe(false);

    electionB.stop();
  });

  // Split-brain: same epoch, higher peerId does NOT demote
  it("split-brain: same epoch, higher peerId does not cause self-demotion", () => {
    const { election: electionA, callbacks: cbA } = createElection({
      peerId: "peer-A",
    });

    electionA.startAsSentinel();

    // Receive heartbeat from peer-B (lexicographically larger) with same epoch
    electionA.handleHeartbeat(
      makeHeartbeatMsg({
        sentinelId: "peer-B",
        epoch: 1,
        successors: ["peer-A"],
      })
    );

    expect(cbA.demoted).toBe(0);
    expect(electionA.isSentinelActive()).toBe(true);

    electionA.stop();
  });

  // 10. peerAdded() atualiza successors no próximo heartbeat
  it("peerAdded() updates successors in next heartbeat", () => {
    const successors = ["peer-B"];
    const { election, sent } = createElection({
      getSuccessors: () => [...successors],
    });

    election.startAsSentinel();
    const hb1 = parseHeartbeat(sent[0]!);
    expect(hb1.successors).toEqual(["peer-B"]);

    // Add new peer
    successors.push("peer-C");
    election.peerAdded("peer-C");

    // Advance to next heartbeat
    jest.advanceTimersByTime(200);
    const hb2 = parseHeartbeat(sent[sent.length - 1]!);
    expect(hb2.successors).toEqual(["peer-B", "peer-C"]);

    election.stop();
  });

  // 11. stop() limpa todos os timers
  it("stop() clears all timers", () => {
    const { election, sent } = createElection();
    election.startAsSentinel();
    sent.length = 0;

    election.stop();

    jest.advanceTimersByTime(1000);
    expect(sent.length).toBe(0);
    expect(election.isSentinelActive()).toBe(false);
  });

  // 12. stop() é idempotente
  it("stop() is idempotent", () => {
    const { election } = createElection();
    election.startAsSentinel();

    expect(() => election.stop()).not.toThrow();
    expect(() => election.stop()).not.toThrow();
  });

  // Heartbeat sends periodically
  it("sentinel sends periodic heartbeats", () => {
    const { election, sent } = createElection({
      heartbeatIntervalMs: 200,
    });
    election.startAsSentinel();
    expect(sent.length).toBe(1);

    jest.advanceTimersByTime(200);
    expect(sent.length).toBe(2);

    jest.advanceTimersByTime(200);
    expect(sent.length).toBe(3);

    election.stop();
  });

  // Promoted follower increments epoch
  it("promoted follower increments epoch from last known", () => {
    const { election } = createElection({
      peerId: "peer-B",
      heartbeatTimeoutMs: 600,
    });
    election.startAsFollower();

    // Receive heartbeat with epoch=3
    election.handleHeartbeat(
      makeHeartbeatMsg({ sentinelId: "peer-A", epoch: 3, successors: ["peer-B"] })
    );

    // Timeout and promote
    jest.advanceTimersByTime(600);
    expect(election.isSentinelActive()).toBe(true);
    expect(election.getEpoch()).toBe(4);

    election.stop();
  });

  // Heartbeat magic prefix
  it("SENTINEL_HEARTBEAT_MAGIC has correct format", () => {
    expect(SENTINEL_HEARTBEAT_MAGIC).toBe("__EDEN_SENTINEL_HB__\n");
  });

  // handleHeartbeat ignores non-heartbeat messages
  it("handleHeartbeat ignores non-heartbeat messages", () => {
    const { election, callbacks } = createElection({ heartbeatTimeoutMs: 600 });
    election.startAsFollower();

    election.handleHeartbeat(Buffer.from("some random message"));

    jest.advanceTimersByTime(600);
    expect(callbacks.promoted).toBe(1);

    election.stop();
  });
});
