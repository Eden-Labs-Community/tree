export const SENTINEL_HEARTBEAT_MAGIC = "__EDEN_SENTINEL_HB__\n";

interface HeartbeatPayload {
  sentinelId: string;
  epoch: number;
  successors: string[];
  ts: number;
}

export interface SentinelElectionOptions {
  peerId: string;
  heartbeatIntervalMs?: number | undefined;
  heartbeatTimeoutMs?: number | undefined;
  cascadeStepMs?: number | undefined;
  onPromoted: () => void;
  onDemoted: () => void;
  sendHeartbeat: (msg: Buffer) => void;
  getSuccessors: () => string[];
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 2000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 6000;
const DEFAULT_CASCADE_STEP_MS = 2000;

export class SentinelElection {
  private readonly peerId: string;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly cascadeStepMs: number;
  private readonly onPromoted: () => void;
  private readonly onDemoted: () => void;
  private readonly sendHeartbeat: (msg: Buffer) => void;
  private readonly getSuccessors: () => string[];

  private sentinel = false;
  private epoch = 0;
  private currentSentinelId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(options: SentinelElectionOptions) {
    this.peerId = options.peerId;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.cascadeStepMs = options.cascadeStepMs ?? DEFAULT_CASCADE_STEP_MS;
    this.onPromoted = options.onPromoted;
    this.onDemoted = options.onDemoted;
    this.sendHeartbeat = options.sendHeartbeat;
    this.getSuccessors = options.getSuccessors;
  }

  startAsSentinel(): void {
    this.stopped = false;
    this.sentinel = true;
    this.epoch = 1;
    this.currentSentinelId = this.peerId;
    this.emitHeartbeat();
    this.heartbeatTimer = setInterval(() => this.emitHeartbeat(), this.heartbeatIntervalMs);
  }

  startAsFollower(): void {
    this.stopped = false;
    this.sentinel = false;
    this.resetTimeout();
  }

  handleHeartbeat(msg: Buffer): void {
    if (this.stopped) return;

    const str = msg.toString();
    if (!str.startsWith(SENTINEL_HEARTBEAT_MAGIC)) return;

    let payload: HeartbeatPayload;
    try {
      payload = JSON.parse(str.slice(SENTINEL_HEARTBEAT_MAGIC.length));
    } catch {
      return;
    }

    // Split-brain resolution
    if (this.sentinel) {
      if (payload.epoch > this.epoch ||
          (payload.epoch === this.epoch && payload.sentinelId < this.peerId)) {
        // Other sentinel wins
        this.demote();
        this.epoch = payload.epoch;
        this.currentSentinelId = payload.sentinelId;
        this.resetTimeout();
      }
      // We win — ignore their heartbeat
      return;
    }

    // Follower receiving heartbeat
    this.epoch = payload.epoch;
    this.currentSentinelId = payload.sentinelId;
    this.resetTimeout(payload.successors);
  }

  peerAdded(_peerId: string): void {
    // Successors list is dynamically fetched via getSuccessors()
    // No action needed — next heartbeat will include the new peer
  }

  peerRemoved(_peerId: string): void {
    // Successors list is dynamically fetched via getSuccessors()
    // No action needed — next heartbeat will reflect removal
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.sentinel = false;

    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.timeoutTimer !== null) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  isSentinelActive(): boolean {
    return this.sentinel;
  }

  getEpoch(): number {
    return this.epoch;
  }

  private emitHeartbeat(): void {
    const payload: HeartbeatPayload = {
      sentinelId: this.peerId,
      epoch: this.epoch,
      successors: this.getSuccessors(),
      ts: Date.now(),
    };
    const msg = Buffer.from(SENTINEL_HEARTBEAT_MAGIC + JSON.stringify(payload));
    this.sendHeartbeat(msg);
  }

  private resetTimeout(successors?: string[]): void {
    if (this.timeoutTimer !== null) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }

    // Calculate cascade delay based on position in successors list
    let cascadeDelay = 0;
    if (successors) {
      const myIndex = successors.indexOf(this.peerId);
      if (myIndex > 0) {
        cascadeDelay = myIndex * this.cascadeStepMs;
      }
    }

    const totalTimeout = this.heartbeatTimeoutMs + cascadeDelay;

    this.timeoutTimer = setTimeout(() => {
      this.timeoutTimer = null;
      if (this.stopped || this.sentinel) return;
      this.promote();
    }, totalTimeout);
  }

  private promote(): void {
    this.sentinel = true;
    this.epoch++;
    this.currentSentinelId = this.peerId;
    this.emitHeartbeat();
    this.heartbeatTimer = setInterval(() => this.emitHeartbeat(), this.heartbeatIntervalMs);
    this.onPromoted();
  }

  private demote(): void {
    this.sentinel = false;

    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.onDemoted();
  }
}
