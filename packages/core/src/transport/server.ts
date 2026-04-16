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
import { ConfigLoader } from "../config/loader.js";
import { ConfigValidator } from "../config/validator.js";
import type { OctopusConfig } from "../config/schema.js";

interface ServerEvents {
  message: (clientId: string, message: ProtocolMessage<unknown>) => void;
  connect: (clientId: string) => void;
  disconnect: (clientId: string) => void;
}

export interface TransportServerOptions {
  port?: number;
  host?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SystemContext = { config: OctopusConfig; [key: string]: any };

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function corsHeaders(res: ServerResponse): void {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    res.setHeader(k, v);
  }
}

function jsonRes(res: ServerResponse, status: number, data: unknown): void {
  corsHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function getNestedValue(obj: Record<string, unknown>, keyPath: string): unknown {
  const keys = keyPath.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, keyPath: string, value: unknown): void {
  const keys = keyPath.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]!] = value;
}

function maskApiKeys(config: OctopusConfig): Record<string, unknown> {
  const masked = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const ai = masked.ai as Record<string, unknown>;
  const providers = ai.providers as Record<string, Record<string, unknown>>;
  for (const provider of Object.values(providers)) {
    if (
      provider.apiKey &&
      typeof provider.apiKey === "string" &&
      (provider.apiKey as string).length > 0
    ) {
      const key = provider.apiKey as string;
      provider.apiKey = key.slice(0, 4) + "..." + key.slice(-4);
    }
  }
  if (
    masked.security &&
    typeof masked.security === "object"
  ) {
    const sec = masked.security as Record<string, unknown>;
    if (sec.encryptionKey && typeof sec.encryptionKey === "string" && (sec.encryptionKey as string).length > 0) {
      sec.encryptionKey = "****";
    }
  }
  return masked;
}

export class TransportServer {
  private port: number;
  private host: string;
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private emitter = new EventEmitter<ServerEvents>();
  private clients = new Map<string, WSWebSocket>();
  private system: SystemContext | null = null;

  constructor(opts: TransportServerOptions = {}) {
    this.port = opts.port ?? 18789;
    this.host = opts.host ?? "127.0.0.1";
  }

  setSystemContext(system: SystemContext): void {
    this.system = system;
  }

  async start(): Promise<void> {
    this.httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      corsHeaders(res);

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = url.pathname;

      if (req.method === "GET" && pathname === "/health") {
        jsonRes(res, 200, { status: "ok" });
        return;
      }

      if (req.method === "GET" && pathname === "/api/status") {
        this.handleStatus(res);
        return;
      }

      if (req.method === "GET" && pathname === "/api/config") {
        this.handleGetConfig(res);
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/api/config/")) {
        const keyPath = pathname.slice("/api/config/".length);
        this.handleGetConfigKey(res, keyPath);
        return;
      }

      if (req.method === "PUT" && pathname.startsWith("/api/config/")) {
        const keyPath = pathname.slice("/api/config/".length);
        void this.handlePutConfigKey(req, res, keyPath);
        return;
      }

      if (req.method === "GET" && pathname === "/api/memory/stats") {
        this.handleMemoryStats(res);
        return;
      }

      if (req.method === "GET" && pathname === "/api/memory/search") {
        const q = url.searchParams.get("q") ?? "";
        void this.handleMemorySearch(res, q);
        return;
      }

      if (req.method === "POST" && pathname === "/api/memory/consolidate") {
        void this.handleMemoryConsolidate(res);
        return;
      }

      if (req.method === "GET" && pathname === "/api/skills") {
        void this.handleGetSkills(res);
        return;
      }

      if (req.method === "POST" && pathname.match(/^\/api\/skills\/[^/]+\/toggle$/)) {
        const skillName = pathname.slice("/api/skills/".length).replace("/toggle", "");
        void this.handleToggleSkill(res, skillName);
        return;
      }

      if (req.method === "GET" && pathname === "/api/plugins") {
        this.handleGetPlugins(res);
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

  private handleStatus(res: ServerResponse): void {
    try {
      const config = this.loadConfig();
      const enabledChannels: string[] = [];
      for (const [name, ch] of Object.entries(config.channels)) {
        if (ch.enabled) enabledChannels.push(name);
      }
      jsonRes(res, 200, {
        status: "running",
        provider: config.ai.default,
        fallback: config.ai.fallback,
        thinking: config.ai.thinking,
        maxTokens: config.ai.maxTokens,
        channels: enabledChannels,
        memoryEnabled: config.memory.enabled,
        skillsEnabled: config.skills.enabled,
        server: { port: config.server.port, host: config.server.host, transport: config.server.transport },
        uptime: process.uptime(),
      });
    } catch (err) {
      jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private handleGetConfig(res: ServerResponse): void {
    try {
      const config = this.loadConfig();
      jsonRes(res, 200, maskApiKeys(config));
    } catch (err) {
      jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private handleGetConfigKey(res: ServerResponse, keyPath: string): void {
    try {
      const config = this.loadConfig();
      const value = getNestedValue(config as unknown as Record<string, unknown>, keyPath);
      if (value === undefined) {
        jsonRes(res, 404, { error: `Key '${keyPath}' not found` });
        return;
      }
      const keyLower = keyPath.toLowerCase();
      const isSensitive = keyLower.includes("apikey") || keyLower.includes("encryptionkey");
      jsonRes(res, 200, { key: keyPath, value: isSensitive && typeof value === "string" && value.length > 0 ? value.slice(0, 4) + "..." + value.slice(-4) : value });
    } catch (err) {
      jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handlePutConfigKey(req: IncomingMessage, res: ServerResponse, keyPath: string): Promise<void> {
    try {
      const body = await readBody(req);
      let parsed: { value: unknown };
      try {
        parsed = JSON.parse(body);
      } catch {
        jsonRes(res, 400, { error: "Invalid JSON body" });
        return;
      }

      const loader = new ConfigLoader();
      const config = loader.load();
      const configObj = config as unknown as Record<string, unknown>;

      let valueToSet: unknown = parsed.value;
      if (typeof valueToSet === "string") {
        const strVal = valueToSet;
        try {
          valueToSet = JSON.parse(strVal);
        } catch {
          if (strVal === "true") valueToSet = true;
          else if (strVal === "false") valueToSet = false;
          else if (/^-?\d+(\.\d+)?$/.test(strVal)) valueToSet = parseFloat(strVal);
        }
      }

      setNestedValue(configObj, keyPath, valueToSet);

      const validator = new ConfigValidator();
      const result = validator.validate(configObj as unknown as OctopusConfig);
      if (!result.valid) {
        jsonRes(res, 400, { error: "Validation failed", details: result.errors });
        return;
      }

      loader.save(configObj as unknown as OctopusConfig);

      if (this.system) {
        this.system.config = configObj as unknown as OctopusConfig;
      }

      jsonRes(res, 200, { ok: true, key: keyPath });
    } catch (err) {
      jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private handleMemoryStats(res: ServerResponse): void {
    try {
      const config = this.loadConfig();
      jsonRes(res, 200, {
        enabled: config.memory.enabled,
        shortTerm: config.memory.shortTerm,
        longTerm: config.memory.longTerm,
        consolidation: config.memory.consolidation,
        retrieval: config.memory.retrieval,
      });
    } catch (err) {
      jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleMemorySearch(res: ServerResponse, query: string): Promise<void> {
    if (!query) {
      jsonRes(res, 400, { error: "Missing query parameter 'q'" });
      return;
    }
    try {
      let results: unknown[] = [];
      if (this.system?.ltm?.search) {
        results = await this.system.ltm.search(query, 10);
      }
      jsonRes(res, 200, { query, results });
    } catch (err) {
      jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleMemoryConsolidate(res: ServerResponse): Promise<void> {
    try {
      let result: unknown = null;
      if (this.system?.memoryConsolidator?.consolidate) {
        result = await this.system.memoryConsolidator.consolidate();
      }
      jsonRes(res, 200, { ok: true, result });
    } catch (err) {
      jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleGetSkills(res: ServerResponse): Promise<void> {
    try {
      const config = this.loadConfig();
      let dbSkills: unknown[] = [];
      if (this.system?.skillRegistry?.getAll) {
        try {
          dbSkills = await this.system.skillRegistry.getAll();
        } catch { /* table may not exist yet */ }
      }
      jsonRes(res, 200, {
        enabled: config.skills.enabled,
        autoCreate: config.skills.autoCreate,
        autoImprove: config.skills.autoImprove,
        builtinSkills: config.skills.registry.builtinSkills,
        dbSkills,
      });
    } catch (err) {
      jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleToggleSkill(res: ServerResponse, _skillName: string): Promise<void> {
    jsonRes(res, 200, { ok: true, message: "Skill toggled (placeholder)" });
  }

  private handleGetPlugins(res: ServerResponse): void {
    try {
      const config = this.loadConfig();
      let plugins: unknown[] = [];
      if (this.system?.pluginRegistry?.getAll) {
        try { plugins = this.system.pluginRegistry.getAll(); } catch { /* ignore */ }
      }
      jsonRes(res, 200, {
        directories: config.plugins.directories,
        builtin: config.plugins.builtin,
        loaded: plugins.map((p: any) => ({
          name: p?.manifest?.name ?? "unknown",
          version: p?.manifest?.version ?? "0.0.0",
          description: p?.manifest?.description ?? "",
        })),
      });
    } catch (err) {
      jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private loadConfig(): OctopusConfig {
    if (this.system?.config) return this.system.config;
    return new ConfigLoader().load();
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
