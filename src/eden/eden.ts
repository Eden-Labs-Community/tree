import { Emitter } from "../emitter/emitter.js";
import { Receiver } from "../receiver/receiver.js";
import { Bus } from "../bus/bus.js";
import { UdpTransport } from "../transports/udp/udp-transport.js";
import { EdenTransport } from "../transports/transport.js";
import { EventEnvelope } from "../envelope/envelope.js";

interface RemoteAddress {
  host: string;
  port: number;
}

interface EdenOptions {
  listenPort: number;
  remote: RemoteAddress;
  timeoutMs?: number;
  retryIntervalMs?: number;
  transport?: (target: RemoteAddress) => EdenTransport;
}

type Handler = (envelope: EventEnvelope) => void;
type Unsubscribe = () => void;

export class Eden {
  private readonly bus: Bus;
  private readonly emitter: Emitter;
  private readonly listenSocket: EdenTransport;
  private readonly emitSocket: EdenTransport;
  private readonly ackSocket: EdenTransport;

  constructor(options: EdenOptions) {
    this.bus = new Bus();

    const makeTransport = options.transport ?? ((t) => new UdpTransport(t));

    this.ackSocket = makeTransport({ host: options.remote.host, port: options.remote.port });
    const receiver = new Receiver((envelope) => {
      if ((envelope as unknown as { type: string }).type === "__ack__") {
        this.emitter.acknowledge((envelope as unknown as { id: string }).id);
        return;
      }
      this.bus.publish(envelope);
    }, this.ackSocket);

    this.listenSocket = makeTransport({ host: "127.0.0.1", port: options.listenPort });
    this.listenSocket.bind(options.listenPort, (msg) => receiver.handle(msg));

    this.emitSocket = makeTransport({ host: options.remote.host, port: options.remote.port });

    const emitterOptions = {
      ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
      ...(options.retryIntervalMs !== undefined && { retryIntervalMs: options.retryIntervalMs }),
    };
    this.emitter = new Emitter(this.emitSocket, emitterOptions);
  }

  on(type: string, handler: Handler, options?: { room?: string }): Unsubscribe {
    return this.bus.subscribe(type, handler, options);
  }

  emit(type: string, payload: unknown, options?: { room?: string }): void {
    this.emitter.emit(type, payload, options);
  }

  getPendingCount(): number {
    return this.emitter.getPending().length;
  }

  stop(): void {
    this.emitter.stop();
    this.listenSocket.close();
    this.emitSocket.close();
    this.ackSocket.close();
  }
}
