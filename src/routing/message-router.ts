export interface ServerConnection {
  isConnected(): boolean;
  send(targetPeerId: string, payload: Buffer): void;
}

export interface MeshConnection {
  emit(msg: Buffer): void;
}

export interface MessageRouterOptions {
  server: ServerConnection;
  mesh: MeshConnection;
}

export class MessageRouter {
  private readonly server: ServerConnection;
  private readonly mesh: MeshConnection;

  constructor(options: MessageRouterOptions) {
    this.server = options.server;
    this.mesh = options.mesh;
  }

  send(targetPeerId: string, payload: Buffer): void {
    if (this.server.isConnected()) {
      try {
        this.server.send(targetPeerId, payload);
        return;
      } catch {
        // server send failed — fall through to mesh
      }
    }
    this.mesh.emit(payload);
  }

  broadcast(payload: Buffer): void {
    this.mesh.emit(payload);
  }
}
