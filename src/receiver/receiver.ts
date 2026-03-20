import { EventEnvelope } from "../envelope/envelope.js";
import { UdpSocket } from "../emitter/emitter.js";
import { EdenInvalidEnvelopeError } from "../errors/errors.js";

type Handler = (envelope: EventEnvelope) => void;

interface AckEnvelope {
  type: "__ack__";
  id: string;
  receivedAt: number;
}

export class Receiver {
  constructor(
    private readonly handler: Handler,
    private readonly socket?: UdpSocket
  ) {}

  handle(msg: Buffer): void {
    const envelope = this.parse(msg);
    this.handler(envelope);

    // Não enviar ACK para mensagens que já são ACKs — evita cascata infinita
    if (this.socket && envelope.type !== "__ack__") {
      const ack: AckEnvelope = { type: "__ack__", id: envelope.id, receivedAt: Date.now() };
      this.socket.send(Buffer.from(JSON.stringify(ack)));
    }
  }

  private parse(msg: Buffer): EventEnvelope {
    let data: unknown;

    try {
      data = JSON.parse(msg.toString());
    } catch {
      throw new EdenInvalidEnvelopeError("message is not valid JSON");
    }

    if (typeof data !== "object" || data === null) {
      throw new EdenInvalidEnvelopeError("envelope must be an object");
    }

    const obj = data as Record<string, unknown>;

    if (typeof obj["id"] !== "string") {
      throw new EdenInvalidEnvelopeError("missing or invalid field: id");
    }

    if (typeof obj["type"] !== "string") {
      throw new EdenInvalidEnvelopeError("missing or invalid field: type");
    }

    return obj as unknown as EventEnvelope;
  }
}
