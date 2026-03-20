export class EdenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdenError";
  }
}

export class EdenInvalidEventTypeError extends EdenError {
  constructor(type: string) {
    super(
      `Invalid event type: "${type}". Expected format: "{namespace}:{domain}:{action}"`
    );
    this.name = "EdenInvalidEventTypeError";
  }
}

export class EdenInvalidEnvelopeError extends EdenError {
  constructor(reason: string) {
    super(`Invalid envelope: ${reason}`);
    this.name = "EdenInvalidEnvelopeError";
  }
}

export class EdenStunTimeoutError extends EdenError {
  constructor(servers: string[]) {
    super(`STUN discovery timed out. Tried: ${servers.join(", ")}`);
    this.name = "EdenStunTimeoutError";
  }
}

export class EdenSignalingError extends EdenError {
  constructor(reason: string) {
    super(`Signaling error: ${reason}`);
    this.name = "EdenSignalingError";
  }
}

export class EdenSentinelError extends EdenError {
  constructor(reason: string) {
    super(`Sentinel error: ${reason}`);
    this.name = "EdenSentinelError";
  }
}
