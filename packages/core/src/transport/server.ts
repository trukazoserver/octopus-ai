import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { EventEmitter } from "eventemitter3";
import WebSocket, { WebSocketServer, type WebSocket as WSWebSocket } from "ws";
import {
  createMessage,
  type ProtocolMessage,
  serializeMessage,
  parseMessage,
  MessageType,
} from "./protocol.js";

interface ServerEvents {
  message: (clientId: string, message: ProtocolMessage<unknown>) => void;
  connect: (clientId: string) => void;
  disconnect: (clientId: string) => void;
}

export interface TransportServerOptions {
  port?: number;
  host?: string;
}

export class TransportServer {
  private port: number;
  private host: string;
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private emitter = new EventEmitter<ServerEvents>();
  private clients = new Map<string, WSWebSocket>();

  constructor(opts: TransportServerOptions = {}) {
    this.port = opts.port ?? 18789;
    this.host = opts.host ?? "127.0.0.1";
  }

  async start(): Promise<void> {
    this.httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on("connection", (ws: WSWebSocket) => {
      const clientId = crypto.randomUUID();
      this.clients.set(clientId, ws);

      ws.on("message", (raw: Buffer) => {
        try {
          const message = parseMessage(raw);
          this.emitter.emit("message", clientId, message);
        } catch {
          const errorMsg = createMessage(MessageType.error, "system", {
            error: "Invalid message format",
          });
          ws.send(serializeMessage(errorMsg));
        }
      });

      ws.on("close", () => {
        this.clients.delete(clientId);
        this.emitter.emit("disconnect", clientId);
      });

      ws.on("error", () => {
        this.clients.delete(clientId);
        this.emitter.emit("disconnect", clientId);
      });

      this.emitter.emit("connect", clientId);
    });

    return new Promise<void>((resolve, reject) => {
      this.httpServer!.on("error", reject);
      this.httpServer!.listen(this.port, this.host, () => {
        this.httpServer!.removeListener("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [, ws] of this.clients) {
      promises.push(
        new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.once("close", resolve);
            ws.close();
          } else {
            resolve();
          }
        }),
      );
    }
    this.clients.clear();

    await Promise.all(promises);

    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = null;
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
  }

  broadcast(channel: string, payload: unknown): void {
    const msg = createMessage(MessageType.event, channel, payload);
    const raw = serializeMessage(msg);
    for (const [, ws] of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(raw);
      }
    }
  }

  send(clientId: string, message: ProtocolMessage<unknown>): boolean {
    const ws = this.clients.get(clientId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    ws.send(serializeMessage(message));
    return true;
  }

  onMessage(handler: (clientId: string, message: ProtocolMessage<unknown>) => void): void {
    this.emitter.on("message", handler);
  }

  onConnect(handler: (clientId: string) => void): void {
    this.emitter.on("connect", handler);
  }

  onDisconnect(handler: (clientId: string) => void): void {
    this.emitter.on("disconnect", handler);
  }
}
