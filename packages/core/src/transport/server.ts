import * as crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import {
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import {
	type IncomingMessage,
	type Server,
	type ServerResponse,
	createServer,
} from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "eventemitter3";
import WebSocket, { WebSocketServer, type WebSocket as WSWebSocket } from "ws";
import { ConfigLoader } from "../config/loader.js";
import type { OctopusConfig } from "../config/schema.js";
import { ConfigValidator } from "../config/validator.js";
import { MCP_CATALOG } from "./mcp-catalog.js";
import {
	MessageType,
	type ProtocolMessage,
	createMessage,
	parseMessage,
	serializeMessage,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
// biome-ignore lint/suspicious/noExplicitAny: Needed for dynamic context injection
type SystemContext = {
	config: OctopusConfig;
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	embedFn?: any;
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	[key: string]: any;
};

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, PATCH, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

export interface MediaItem {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	createdAt: string;
	description?: string;
}

const MEDIA_DIR = join(homedir(), ".octopus", "media");
const MEDIA_META_PATH = join(MEDIA_DIR, "meta.json");

const MIME_EXTENSIONS: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
	"audio/mpeg": ".mp3",
	"audio/wav": ".wav",
	"audio/ogg": ".ogg",
	"audio/mp4": ".m4a",
	"audio/webm": ".weba",
	"video/mp4": ".mp4",
	"video/webm": ".webm",
	"video/ogg": ".ogv",
	"application/pdf": ".pdf",
	"application/json": ".json",
	"text/csv": ".csv",
	"text/plain": ".txt",
};

function ensureMediaDir(): void {
	if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });
}

function loadMediaMeta(): MediaItem[] {
	ensureMediaDir();
	try {
		const data = readFileSync(MEDIA_META_PATH, "utf-8");
		return JSON.parse(data) as MediaItem[];
	} catch {
		return [];
	}
}

function saveMediaMeta(items: MediaItem[]): void {
	ensureMediaDir();
	writeFileSync(MEDIA_META_PATH, JSON.stringify(items, null, 2), "utf-8");
}

function normalizeBase64Data(data: string): string {
	const match = data.match(/^data:[^;]+;base64,(.+)$/s);
	return match?.[1] ?? data;
}

function guessMime(filename: string): string {
	const ext = extname(filename).toLowerCase();
	const mimeMap: Record<string, string> = {
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".webp": "image/webp",
		".svg": "image/svg+xml",
		".mp3": "audio/mpeg",
		".wav": "audio/wav",
		".ogg": "audio/ogg",
		".m4a": "audio/mp4",
		".mp4": "video/mp4",
		".webm": "video/webm",
		".ogv": "video/ogg",
		".pdf": "application/pdf",
		".json": "application/json",
		".csv": "text/csv",
		".txt": "text/plain",
	};
	return mimeMap[ext] ?? "application/octet-stream";
}

function corsHeaders(res: ServerResponse): void {
	for (const [k, v] of Object.entries(CORS_HEADERS)) {
		res.setHeader(k, v);
	}
}

function jsonRes(res: ServerResponse, status: number, data: unknown): void {
	if (res.headersSent) return;
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

function getNestedValue(
	obj: Record<string, unknown>,
	keyPath: string,
): unknown {
	const keys = keyPath.split(".");
	let current: unknown = obj;
	for (const key of keys) {
		if (
			current === null ||
			current === undefined ||
			typeof current !== "object"
		)
			return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function setNestedValue(
	obj: Record<string, unknown>,
	keyPath: string,
	value: unknown,
): void {
	const keys = keyPath.split(".");
	let current: Record<string, unknown> = obj;
	for (let i = 0; i < keys.length - 1; i++) {
		const key = keys[i];
		if (key === undefined) continue;
		if (
			!(key in current) ||
			typeof current[key] !== "object" ||
			current[key] === null
		) {
			current[key] = {};
		}
		current = current[key] as Record<string, unknown>;
	}
	const lastKey = keys[keys.length - 1];
	if (lastKey !== undefined) {
		current[lastKey] = value;
	}
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
			provider.apiKey = `${key.slice(0, 4)}...${key.slice(-4)}`;
		}
	}
	if (masked.security && typeof masked.security === "object") {
		const sec = masked.security as Record<string, unknown>;
		if (
			sec.encryptionKey &&
			typeof sec.encryptionKey === "string" &&
			(sec.encryptionKey as string).length > 0
		) {
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
		this.httpServer = createServer(
			(req: IncomingMessage, res: ServerResponse) => {
				corsHeaders(res);

				if (req.method === "OPTIONS") {
					res.writeHead(204);
					res.end();
					return;
				}

				const url = new URL(
					req.url ?? "/",
					`http://${req.headers.host ?? "localhost"}`,
				);
				const pathname = url.pathname;

				if (
					req.method === "GET" &&
					(pathname === "/health" || pathname === "/api/health")
				) {
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

				if (req.method === "GET" && pathname === "/api/memory/config") {
					this.handleMemoryConfigGet(res);
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

				if (
					req.method === "POST" &&
					pathname.match(/^\/api\/skills\/[^/]+\/toggle$/)
				) {
					const skillName = pathname
						.slice("/api/skills/".length)
						.replace("/toggle", "");
					void this.handleToggleSkill(res, skillName);
					return;
				}

				if (req.method === "GET" && pathname === "/api/plugins") {
					this.handleGetPlugins(res);
					return;
				}

				if (req.method === "POST" && pathname === "/api/code/execute") {
					void this.handleCodeExecute(req, res);
					return;
				}

				if (req.method === "POST" && pathname === "/api/code/create-tool") {
					void this.handleCreateTool(req, res);
					return;
				}

				if (req.method === "GET" && pathname === "/api/code/tools") {
					this.handleGetDynamicTools(res);
					return;
				}

				if (req.method === "GET" && pathname === "/api/tools/registered") {
					this.handleGetRegisteredTools(res);
					return;
				}
				if (
					req.method === "DELETE" &&
					/^\/api\/tools\/dynamic\/[^/]+$/.test(pathname)
				) {
					const toolName = decodeURIComponent(pathname.split("/").pop() ?? "");
					void this.handleDeleteDynamicTool(res, toolName);
					return;
				}

				if (req.method === "POST" && pathname === "/api/skills/create") {
					void this.handleCreateSkill(req, res);
					return;
				}
				if (
					req.method === "PUT" &&
					/^\/api\/skills\/[^/]+$/.test(pathname) &&
					!pathname.includes("/toggle")
				) {
					const skillName = decodeURIComponent(pathname.split("/").pop() ?? "");
					void this.handleUpdateSkill(req, res, skillName);
					return;
				}
				if (
					req.method === "DELETE" &&
					/^\/api\/skills\/[^/]+$/.test(pathname)
				) {
					const skillName = decodeURIComponent(pathname.split("/").pop() ?? "");
					void this.handleDeleteSkill(res, skillName);
					return;
				}

				if (req.method === "GET" && pathname === "/api/memory/stm") {
					this.handleGetSTM(res);
					return;
				}
				if (req.method === "GET" && pathname === "/api/memory/daily") {
					void this.handleGetDailyMemory(res);
					return;
				}
				if (req.method === "GET" && pathname === "/api/memory/profile") {
					void this.handleGetUserProfile(res);
					return;
				}
				if (req.method === "PUT" && pathname === "/api/memory/profile") {
					void this.handleUpdateUserProfile(req, res);
					return;
				}
				if (req.method === "GET" && pathname === "/api/memory/ltm/recent") {
					void this.handleGetRecentLTM(res, url);
					return;
				}

				if (req.method === "GET" && pathname.startsWith("/api/workspace/")) {
					const wsPath = pathname.slice("/api/workspace/".length);
					this.handleWorkspaceGet(res, wsPath);
					return;
				}

				if (req.method === "PUT" && pathname.startsWith("/api/workspace/")) {
					void this.handleWorkspacePut(
						req,
						res,
						pathname.slice("/api/workspace/".length),
					);
					return;
				}

				if (req.method === "GET" && pathname === "/api/conversations") {
					void this.handleListConversations(req, res);
					return;
				}

				if (req.method === "POST" && pathname === "/api/conversations") {
					void this.handleCreateConversation(req, res);
					return;
				}

				if (
					req.method === "GET" &&
					pathname.startsWith("/api/conversations/") &&
					!pathname.includes("/search")
				) {
					const convId = pathname.slice("/api/conversations/".length);
					void this.handleGetConversation(res, convId);
					return;
				}

				if (
					req.method === "DELETE" &&
					pathname.startsWith("/api/conversations/")
				) {
					const convId = pathname.slice("/api/conversations/".length);
					void this.handleDeleteConversation(res, convId);
					return;
				}

				if (
					req.method === "PATCH" &&
					pathname.startsWith("/api/conversations/")
				) {
					const convId = pathname.slice("/api/conversations/".length);
					void this.handleUpdateConversation(req, res, convId);
					return;
				}

				if (req.method === "GET" && pathname === "/api/agents") {
					void this.handleListAgents(res);
					return;
				}
				if (req.method === "POST" && pathname === "/api/agents") {
					void this.handleCreateAgent(res, req);
					return;
				}
				if (
					req.method === "GET" &&
					/^\/api\/agents\/[^/]+$/.test(pathname) &&
					!pathname.includes("/memory")
				) {
					const agentId = pathname.split("/").pop() ?? "";
					void this.handleGetAgent(res, agentId);
					return;
				}
				if (req.method === "PUT" && /^\/api\/agents\/[^/]+$/.test(pathname)) {
					const agentId = pathname.split("/").pop() ?? "";
					void this.handleUpdateAgent(res, req, agentId);
					return;
				}
				if (
					req.method === "DELETE" &&
					/^\/api\/agents\/[^/]+$/.test(pathname)
				) {
					const agentId = pathname.split("/").pop() ?? "";
					void this.handleDeleteAgent(res, agentId);
					return;
				}

				if (req.method === "GET" && pathname === "/api/tasks") {
					void this.handleListTasks(res, url);
					return;
				}
				if (req.method === "POST" && pathname === "/api/tasks") {
					void this.handleCreateTask(res, req);
					return;
				}
				if (req.method === "GET" && pathname === "/api/tasks/stats") {
					void this.handleTaskStats(res);
					return;
				}
				if (req.method === "GET" && /^\/api\/tasks\/[^/]+$/.test(pathname)) {
					const taskId = pathname.split("/").pop() ?? "";
					void this.handleGetTask(res, taskId);
					return;
				}
				if (req.method === "PUT" && /^\/api\/tasks\/[^/]+$/.test(pathname)) {
					const taskId = pathname.split("/").pop() ?? "";
					void this.handleUpdateTask(res, req, taskId);
					return;
				}
				if (req.method === "DELETE" && /^\/api\/tasks\/[^/]+$/.test(pathname)) {
					const taskId = pathname.split("/").pop() ?? "";
					void this.handleDeleteTask(res, taskId);
					return;
				}

				if (req.method === "GET" && pathname === "/api/automations") {
					void this.handleListAutomations(res);
					return;
				}
				if (req.method === "POST" && pathname === "/api/automations") {
					void this.handleCreateAutomation(res, req);
					return;
				}
				if (
					req.method === "GET" &&
					/^\/api\/automations\/[^/]+$/.test(pathname)
				) {
					const autoId = pathname.split("/").pop() ?? "";
					void this.handleGetAutomation(res, autoId);
					return;
				}
				if (
					req.method === "PUT" &&
					/^\/api\/automations\/[^/]+$/.test(pathname)
				) {
					const autoId = pathname.split("/").pop() ?? "";
					void this.handleUpdateAutomation(res, req, autoId);
					return;
				}
				if (
					req.method === "POST" &&
					/^\/api\/automations\/[^/]+\/toggle$/.test(pathname)
				) {
					const parts = pathname.split("/");
					const autoId = parts[3] ?? "";
					void this.handleToggleAutomation(res, autoId);
					return;
				}
				if (
					req.method === "DELETE" &&
					/^\/api\/automations\/[^/]+$/.test(pathname)
				) {
					const autoId = pathname.split("/").pop() ?? "";
					void this.handleDeleteAutomation(res, autoId);
					return;
				}

				if (req.method === "GET" && pathname === "/api/env") {
					void this.handleListEnvVars(res, url);
					return;
				}
				if (req.method === "POST" && pathname === "/api/env") {
					void this.handleSetEnvVar(res, req);
					return;
				}
				if (req.method === "DELETE" && /^\/api\/env\/[^/]+$/.test(pathname)) {
					const key = decodeURIComponent(pathname.split("/").pop() ?? "");
					void this.handleDeleteEnvVar(res, key);
					return;
				}

				if (req.method === "GET" && pathname === "/api/mcp/servers") {
					void this.handleListMCPServers(res);
					return;
				}
				if (req.method === "POST" && pathname === "/api/mcp/servers") {
					void this.handleAddMCPServer(res, req);
					return;
				}
				if (
					req.method === "DELETE" &&
					/^\/api\/mcp\/servers\/[^/]+$/.test(pathname)
				) {
					const serverName = decodeURIComponent(
						pathname.split("/").pop() ?? "",
					);
					void this.handleRemoveMCPServer(res, serverName);
					return;
				}
				if (
					req.method === "POST" &&
					/^\/api\/mcp\/servers\/[^/]+\/restart$/.test(pathname)
				) {
					const parts = pathname.split("/");
					const serverName = decodeURIComponent(parts[4] ?? "");
					void this.handleRestartMCPServer(res, serverName);
					return;
				}

				if (req.method === "PUT" && pathname === "/api/mcp/servers") {
					void this.handleSyncMCPServers(res, req);
					return;
				}

				if (req.method === "GET" && pathname === "/api/mcp/catalog") {
					this.handleMCPCatalog(res);
					return;
				}

				if (req.method === "GET" && pathname === "/api/channels") {
					void this.handleListChannels(res);
					return;
				}
				if (
					req.method === "PUT" &&
					/^\/api\/channels\/[^/]+\/config$/.test(pathname)
				) {
					const parts = pathname.split("/");
					const channelName = parts[3] ?? "";
					void this.handleUpdateChannelConfig(res, req, channelName);
					return;
				}
				if (
					req.method === "POST" &&
					/^\/api\/channels\/[^/]+\/toggle$/.test(pathname)
				) {
					const parts = pathname.split("/");
					const channelName = parts[3] ?? "";
					void this.handleToggleChannel(res, channelName);
					return;
				}
				if (
					req.method === "POST" &&
					pathname === "/api/channels/telegram/test"
				) {
					void this.handleTestTelegramConnection(res);
					return;
				}
				// Media library endpoints
				if (req.method === "GET" && pathname === "/api/media") {
					this.handleListMedia(res);
					return;
				}
				if (req.method === "POST" && pathname === "/api/media/upload") {
					void this.handleUploadMedia(req, res);
					return;
				}
				if (req.method === "POST" && pathname === "/api/media/save") {
					void this.handleSaveMedia(req, res);
					return;
				}
				if (req.method === "GET" && pathname.startsWith("/api/media/file/")) {
					const mediaId = pathname.slice("/api/media/file/".length);
					this.handleServeMediaFile(res, mediaId);
					return;
				}
				if (
					req.method === "DELETE" &&
					pathname.startsWith("/api/media/") &&
					!pathname.includes("/file/")
				) {
					const mediaId = pathname.slice("/api/media/".length);
					void this.handleDeleteMedia(res, mediaId);
					return;
				}

				const webDistCandidates = [
					resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist"),
					resolve(dirname(fileURLToPath(import.meta.url)), "../../../web/dist"),
					resolve(process.cwd(), "packages/web/dist"),
				];
				const webDist =
					webDistCandidates.find((p) => {
						try {
							return existsSync(join(p, "index.html"));
						} catch {
							return false;
						}
					}) ?? (webDistCandidates[0] as string);

				const mimeTypes: Record<string, string> = {
					html: "text/html",
					js: "application/javascript",
					mjs: "application/javascript",
					css: "text/css",
					json: "application/json",
					png: "image/png",
					svg: "image/svg+xml",
					ico: "image/x-icon",
					wasm: "application/wasm",
				};
				let staticPath = pathname;
				if (staticPath === "/" || !staticPath.includes("."))
					staticPath = "/index.html";
				const fp = join(webDist, staticPath);
				if (fp.startsWith(webDist)) {
					try {
						const ext = staticPath.split(".").pop()?.toLowerCase() ?? "";
						const data = readFileSync(fp);
						res.writeHead(200, {
							"Content-Type": mimeTypes[ext] ?? "application/octet-stream",
						});
						res.end(data);
						return;
					} catch {}
				}
				if (!res.headersSent) {
					res.writeHead(404);
					res.end();
				}
			},
		);

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
			this.httpServer?.on("error", reject);
			this.httpServer?.listen(this.port, this.host, () => {
				this.httpServer?.removeListener("error", reject);
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
				server: {
					port: config.server.port,
					host: config.server.host,
					transport: config.server.transport,
				},
				uptime: process.uptime(),
			});
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private handleGetConfig(res: ServerResponse): void {
		try {
			const config = this.loadConfig();
			jsonRes(res, 200, maskApiKeys(config));
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private handleGetConfigKey(res: ServerResponse, keyPath: string): void {
		try {
			const config = this.loadConfig();
			const value = getNestedValue(
				config as unknown as Record<string, unknown>,
				keyPath,
			);
			if (value === undefined) {
				jsonRes(res, 404, { error: `Key '${keyPath}' not found` });
				return;
			}
			const keyLower = keyPath.toLowerCase();
			const isSensitive =
				keyLower.includes("apikey") || keyLower.includes("encryptionkey");
			jsonRes(res, 200, {
				key: keyPath,
				value:
					isSensitive && typeof value === "string" && value.length > 0
						? `${value.slice(0, 4)}...${value.slice(-4)}`
						: value,
			});
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handlePutConfigKey(
		req: IncomingMessage,
		res: ServerResponse,
		keyPath: string,
	): Promise<void> {
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
					else if (/^-?\d+(\.\d+)?$/.test(strVal))
						valueToSet = Number.parseFloat(strVal);
				}
			}

			setNestedValue(configObj, keyPath, valueToSet);

			const validator = new ConfigValidator();
			const result = validator.validate(configObj as unknown as OctopusConfig);
			if (!result.valid) {
				jsonRes(res, 400, {
					error: "Validation failed",
					details: result.errors,
				});
				return;
			}

			loader.save(configObj as unknown as OctopusConfig);

			if (this.system) {
				this.system.config = configObj as unknown as OctopusConfig;
			}

			jsonRes(res, 200, { ok: true, key: keyPath });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
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
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private handleMemoryConfigGet(res: ServerResponse): void {
		this.handleMemoryStats(res);
	}

	private async handleMemorySearch(
		res: ServerResponse,
		query: string,
	): Promise<void> {
		if (!query) {
			jsonRes(res, 400, { error: "Missing query parameter 'q'" });
			return;
		}
		try {
			let results: unknown[] = [];
			if (this.system?.ltm?.search && this.system.embedFn) {
				results = await this.system.ltm.search(query, this.system.embedFn);
			}
			jsonRes(res, 200, { query, results });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleMemoryConsolidate(res: ServerResponse): Promise<void> {
		try {
			let result: unknown = null;
			if (this.system?.memoryConsolidator?.consolidate && this.system?.agentRuntime?.stm) {
				result = await this.system.memoryConsolidator.consolidate(this.system.agentRuntime.stm);
			} else {
				jsonRes(res, 200, {
					ok: true,
					result: null,
					message:
						"Memory consolidation not available (memory may be disabled)",
				});
				return;
			}
			jsonRes(res, 200, { ok: true, result });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleGetSkills(res: ServerResponse): Promise<void> {
		try {
			const config = this.loadConfig();
			let dbSkills: unknown[] = [];
			if (this.system?.skillRegistry?.list) {
				try {
					dbSkills = await this.system.skillRegistry.list();
				} catch {
					/* table may not exist yet */
				}
			}
			jsonRes(res, 200, {
				enabled: config.skills.enabled,
				autoCreate: config.skills.autoCreate,
				autoImprove: config.skills.autoImprove,
				builtinSkills: config.skills.registry.builtinSkills,
				dbSkills,
			});
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleToggleSkill(
		res: ServerResponse,
		skillName: string,
	): Promise<void> {
		try {
			if (this.system?.skillRegistry) {
				const allSkills = await this.system.skillRegistry.list();
				const skill = allSkills.find(
					(s: { name: string }) => s.name === skillName,
				);
				if (!skill) {
					jsonRes(res, 404, { error: `Skill '${skillName}' not found` });
					return;
				}
				jsonRes(res, 200, {
					ok: true,
					skill: { name: skill.name, version: skill.version },
					message: `Skill '${skillName}' toggled successfully`,
				});
			} else {
				jsonRes(res, 200, {
					ok: true,
					message: "Skill toggled (no registry connected)",
				});
			}
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private handleGetPlugins(res: ServerResponse): void {
		try {
			const config = this.loadConfig();
			let plugins: unknown[] = [];
			if (this.system?.pluginRegistry?.getAll) {
				try {
					plugins = this.system.pluginRegistry.getAll();
				} catch {
					/* ignore */
				}
			}
			jsonRes(res, 200, {
				directories: config.plugins.directories,
				builtin: config.plugins.builtin,
				// biome-ignore lint/suspicious/noExplicitAny: Required for arbitrary plugin shapes
				loaded: plugins.map((p: any) => ({
					name: p?.manifest?.name ?? "unknown",
					version: p?.manifest?.version ?? "0.0.0",
					description: p?.manifest?.description ?? "",
				})),
			});
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleCodeExecute(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			const body = await readBody(req);
			let parsed: { code: string; language: string; timeout?: number };
			try {
				parsed = JSON.parse(body);
			} catch {
				jsonRes(res, 400, { error: "Invalid JSON body" });
				return;
			}

			if (!parsed.code || !parsed.language) {
				jsonRes(res, 400, { error: "Missing 'code' or 'language' field" });
				return;
			}

			if (this.system?.codeExecutor) {
				const result = await this.system.codeExecutor.executeCode(
					parsed.code,
					parsed.language,
					{ timeout: parsed.timeout },
				);
				jsonRes(res, 200, result);
			} else {
				jsonRes(res, 503, { error: "Code executor not available" });
			}
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleCreateTool(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			const body = await readBody(req);
			let parsed: {
				name: string;
				description: string;
				code: string;
				language?: string;
				parameters_schema?: string;
			};
			try {
				parsed = JSON.parse(body);
			} catch {
				jsonRes(res, 400, { error: "Invalid JSON body" });
				return;
			}

			if (!parsed.name || !parsed.description || !parsed.code) {
				jsonRes(res, 400, {
					error: "Missing required fields: name, description, code",
				});
				return;
			}

			if (this.system?.codeExecutor) {
				const tools = this.system.codeExecutor.createTools();
				const createTool = tools.find(
					(t: { name: string }) => t.name === "create_tool",
				);
				if (createTool) {
					const result = await createTool.handler({
						name: parsed.name,
						description: parsed.description,
						code: parsed.code,
						language: parsed.language ?? "javascript",
						parameters_schema: parsed.parameters_schema,
					});
					jsonRes(res, 200, result);
				} else {
					jsonRes(res, 503, { error: "Create tool handler not available" });
				}
			} else {
				jsonRes(res, 503, { error: "Code executor not available" });
			}
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private handleGetDynamicTools(res: ServerResponse): void {
		try {
			const dir = join(homedir(), ".octopus", "tools");
			const tools: unknown[] = [];

			try {
				const entries = readdirSync(dir, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isDirectory()) {
						const manifestPath = join(dir, entry.name, "manifest.json");
						try {
							const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
							tools.push(manifest);
						} catch {
							/* ignore invalid manifests */
						}
					}
				}
			} catch {
				/* tools dir doesn't exist yet */
			}

			jsonRes(res, 200, { tools });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private handleGetRegisteredTools(res: ServerResponse): void {
		try {
			const registered: { name: string; description: string; paramCount: number }[] = [];
			if (this.system?.toolRegistry?.list) {
				const tools = this.system.toolRegistry.list();
				for (const t of tools) {
					registered.push({
						name: t.name,
						description: t.description,
						paramCount: Object.keys(t.parameters ?? {}).length,
					});
				}
			}
			jsonRes(res, 200, { tools: registered });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleDeleteDynamicTool(
		res: ServerResponse,
		toolName: string,
	): Promise<void> {
		try {
			const dir = join(homedir(), ".octopus", "tools", toolName);
			if (!existsSync(dir)) {
				jsonRes(res, 404, { error: `Tool '${toolName}' not found` });
				return;
			}
			// Remove directory recursively
			const { rmSync } = await import("node:fs");
			rmSync(dir, { recursive: true, force: true });
			// Unregister from runtime if possible
			if (this.system?.toolRegistry?.unregister) {
				this.system.toolRegistry.unregister(toolName);
			}
			jsonRes(res, 200, { ok: true, message: `Tool '${toolName}' deleted` });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleCreateSkill(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			const body = await readBody(req);
			const parsed = JSON.parse(body) as {
				name: string;
				description: string;
				content: string;
				domain?: string;
			};
			if (!parsed.name || !parsed.content) {
				jsonRes(res, 400, { error: "Missing 'name' or 'content'" });
				return;
			}
			if (this.system?.skillRegistry?.store) {
				await this.system.skillRegistry.store({
					name: parsed.name,
					description: parsed.description ?? "",
					content: parsed.content,
					domain: parsed.domain ?? "general",
					version: 1,
					successRate: 1,
					usageCount: 0,
					createdAt: new Date(),
					updatedAt: new Date(),
				});
				jsonRes(res, 200, { ok: true, message: `Skill '${parsed.name}' created` });
			} else {
				jsonRes(res, 503, { error: "Skill registry not available" });
			}
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleUpdateSkill(
		req: IncomingMessage,
		res: ServerResponse,
		skillName: string,
	): Promise<void> {
		try {
			const body = await readBody(req);
			const parsed = JSON.parse(body) as {
				description?: string;
				content?: string;
				domain?: string;
			};
			if (this.system?.skillRegistry?.store) {
				const existing = (await this.system.skillRegistry.list()).find(
					(s: { name: string }) => s.name === skillName,
				);
				if (!existing) {
					jsonRes(res, 404, { error: `Skill '${skillName}' not found` });
					return;
				}
				await this.system.skillRegistry.store({
					...existing,
					...(parsed.description !== undefined ? { description: parsed.description } : {}),
					...(parsed.content !== undefined ? { content: parsed.content } : {}),
					...(parsed.domain !== undefined ? { domain: parsed.domain } : {}),
					updatedAt: new Date(),
				});
				jsonRes(res, 200, { ok: true, message: `Skill '${skillName}' updated` });
			} else {
				jsonRes(res, 503, { error: "Skill registry not available" });
			}
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleDeleteSkill(
		res: ServerResponse,
		skillName: string,
	): Promise<void> {
		try {
			if (this.system?.skillRegistry?.delete) {
				await this.system.skillRegistry.delete(skillName);
				jsonRes(res, 200, { ok: true, message: `Skill '${skillName}' deleted` });
			} else if (this.system?.db) {
				await this.system.db.run(
					"DELETE FROM skills WHERE name = ?",
					[skillName],
				);
				jsonRes(res, 200, { ok: true, message: `Skill '${skillName}' deleted` });
			} else {
				jsonRes(res, 503, { error: "Skill deletion not available" });
			}
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private handleGetSTM(res: ServerResponse): void {
		try {
			if (this.system?.agentRuntime?.stm) {
				const turns = this.system.agentRuntime.stm.getContext();
				const recentTurns = turns.slice(-30).map(
					(t: { role: string; content: string; timestamp: Date; metadata?: Record<string, unknown> }) => ({
						role: t.role,
						content: t.content.length > 500 ? `${t.content.substring(0, 500)}...` : t.content,
						timestamp: t.timestamp?.toISOString?.() ?? null,
						channel: t.metadata?.conversationId ?? null,
					}),
				);
				jsonRes(res, 200, { turns: recentTurns, total: turns.length });
			} else {
				jsonRes(res, 200, { turns: [], total: 0 });
			}
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleGetDailyMemory(res: ServerResponse): Promise<void> {
		try {
			if (this.system?.dailyMemory) {
				const ctx = await this.system.dailyMemory.getCurrentContext();
				const structured = await this.system.dailyMemory.getStructuredData?.();
				const messageCount = (await this.system.dailyMemory.getMessageCount?.()) ?? 0;
				jsonRes(res, 200, {
					context: ctx,
					structured: structured ?? null,
					messageCount,
					date: new Date().toISOString().split("T")[0],
				});
			} else {
				jsonRes(res, 200, { context: "", structured: null, messageCount: 0, date: new Date().toISOString().split("T")[0] });
			}
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleGetUserProfile(res: ServerResponse): Promise<void> {
		try {
			if (this.system?.userProfileManager) {
				const profile = await this.system.userProfileManager.getProfile("owner");
				jsonRes(res, 200, { profile });
			} else {
				jsonRes(res, 200, { profile: null });
			}
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleUpdateUserProfile(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			const body = await readBody(req);
			const parsed = JSON.parse(body) as {
				displayName?: string;
				preferences?: Record<string, string>;
				communicationStyle?: string;
				preferredLanguage?: string;
			};
			if (this.system?.userProfileManager) {
				const profile = await this.system.userProfileManager.getProfile("owner");
				if (parsed.displayName !== undefined) profile.displayName = parsed.displayName;
				if (parsed.communicationStyle) profile.communicationStyle = parsed.communicationStyle;
				if (parsed.preferredLanguage) profile.preferredLanguage = parsed.preferredLanguage;
				if (parsed.preferences) {
					for (const [k, v] of Object.entries(parsed.preferences)) {
						profile.preferences[k] = v;
					}
				}
				profile.updatedAt = new Date().toISOString();
				// Force save via private method workaround - re-store
				await this.system.userProfileManager.updateManual?.(profile);
				jsonRes(res, 200, { ok: true, profile });
			} else {
				jsonRes(res, 503, { error: "User profile manager not available" });
			}
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleGetRecentLTM(
		res: ServerResponse,
		url: URL,
	): Promise<void> {
		try {
			const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
			if (this.system?.db) {
				const rows = await this.system.db.all(
					"SELECT * FROM memories ORDER BY created_at DESC LIMIT ?",
					[limit],
				);
				jsonRes(res, 200, { memories: rows ?? [] });
			} else {
				jsonRes(res, 200, { memories: [] });
			}
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private handleWorkspaceGet(res: ServerResponse, relPath: string): void {
		try {
			const workspaceRoot = join(homedir(), ".octopus", "workspace");
			const fullPath = resolve(workspaceRoot, relPath);

			if (!fullPath.startsWith(workspaceRoot)) {
				jsonRes(res, 403, { error: "Access denied" });
				return;
			}

			const stat = statSync(fullPath);
			if (stat.isDirectory()) {
				const entries = readdirSync(fullPath, { withFileTypes: true });
				jsonRes(res, 200, {
					type: "directory",
					entries: entries.map((e) => ({
						name: e.name,
						type: e.isDirectory() ? "dir" : "file",
					})),
				});
			} else {
				const content = readFileSync(fullPath, "utf-8");
				jsonRes(res, 200, { type: "file", content });
			}
		} catch (err) {
			jsonRes(res, 404, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleWorkspacePut(
		req: IncomingMessage,
		res: ServerResponse,
		relPath: string,
	): Promise<void> {
		try {
			const workspaceRoot = join(homedir(), ".octopus", "workspace");
			const fullPath = resolve(workspaceRoot, relPath);

			if (!fullPath.startsWith(workspaceRoot)) {
				jsonRes(res, 403, { error: "Access denied" });
				return;
			}

			const body = await readBody(req);
			let parsed: { content: string };
			try {
				parsed = JSON.parse(body);
			} catch {
				jsonRes(res, 400, { error: "Invalid JSON body" });
				return;
			}

			const { writeFile, mkdir } = await import("node:fs/promises");
			await mkdir(dirname(fullPath), { recursive: true });
			await writeFile(fullPath, parsed.content, "utf-8");
			jsonRes(res, 200, { ok: true, path: relPath });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleListConversations(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			const url = new URL(
				req.url ?? "/",
				`http://${req.headers.host ?? "localhost"}`,
			);
			const limit = Number(url.searchParams.get("limit")) || 50;
			const offset = Number(url.searchParams.get("offset")) || 0;
			if (!this.system?.chatManager) {
				jsonRes(res, 503, { error: "Chat manager not available" });
				return;
			}
			const conversations = await this.system.chatManager.listConversations({
				limit,
				offset,
			});
			jsonRes(res, 200, conversations);
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleCreateConversation(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			if (!this.system?.chatManager) {
				jsonRes(res, 503, { error: "Chat manager not available" });
				return;
			}
			const body = await readBody(req);
			let parsed: { title?: string; agentId?: string } = {};
			if (body) {
				try {
					parsed = JSON.parse(body);
				} catch {
					jsonRes(res, 400, { error: "Invalid JSON body" });
					return;
				}
			}
			const conversation = await this.system.chatManager.createConversation(
				parsed.title,
				parsed.agentId,
			);
			jsonRes(res, 201, { conversation });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleGetConversation(
		res: ServerResponse,
		id: string,
	): Promise<void> {
		try {
			if (!this.system?.chatManager) {
				jsonRes(res, 503, { error: "Chat manager not available" });
				return;
			}
			const conversation = await this.system.chatManager.getConversation(id);
			if (!conversation) {
				jsonRes(res, 404, { error: "Conversation not found" });
				return;
			}
			jsonRes(res, 200, { conversation });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleDeleteConversation(
		res: ServerResponse,
		id: string,
	): Promise<void> {
		try {
			if (!this.system?.chatManager) {
				jsonRes(res, 503, { error: "Chat manager not available" });
				return;
			}
			await this.system.chatManager.deleteConversation(id);
			jsonRes(res, 200, { ok: true });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleUpdateConversation(
		req: IncomingMessage,
		res: ServerResponse,
		id: string,
	): Promise<void> {
		try {
			if (!this.system?.chatManager) {
				jsonRes(res, 503, { error: "Chat manager not available" });
				return;
			}
			const body = await readBody(req);
			let parsed: { title?: string; agent_id?: string } = {};
			try {
				parsed = JSON.parse(body);
			} catch {
				jsonRes(res, 400, { error: "Invalid JSON body" });
				return;
			}
			await this.system.chatManager.updateConversation(id, parsed);
			jsonRes(res, 200, { ok: true });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleListAgents(res: ServerResponse): Promise<void> {
		try {
			if (!this.system?.agentManager) {
				jsonRes(res, 200, []);
				return;
			}
			jsonRes(res, 200, await this.system.agentManager.listAgents());
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleCreateAgent(
		res: ServerResponse,
		req: IncomingMessage,
	): Promise<void> {
		try {
			if (!this.system?.agentManager) {
				jsonRes(res, 503, { error: "Agent manager not available" });
				return;
			}
			const body = JSON.parse(await readBody(req));
			const agent = await this.system.agentManager.createAgent(body);
			jsonRes(res, 201, agent);
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleGetAgent(res: ServerResponse, id: string): Promise<void> {
		try {
			if (!this.system?.agentManager) {
				jsonRes(res, 503, { error: "Agent manager not available" });
				return;
			}
			const agent = await this.system.agentManager.getAgent(id);
			if (!agent) {
				jsonRes(res, 404, { error: "Agent not found" });
				return;
			}
			jsonRes(res, 200, agent);
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleUpdateAgent(
		res: ServerResponse,
		req: IncomingMessage,
		id: string,
	): Promise<void> {
		try {
			if (!this.system?.agentManager) {
				jsonRes(res, 503, { error: "Agent manager not available" });
				return;
			}
			const body = JSON.parse(await readBody(req));
			const ok = await this.system.agentManager.updateAgent(id, body);
			jsonRes(res, ok ? 200 : 404, { ok });
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleDeleteAgent(
		res: ServerResponse,
		id: string,
	): Promise<void> {
		try {
			if (!this.system?.agentManager) {
				jsonRes(res, 503, { error: "Agent manager not available" });
				return;
			}
			const ok = await this.system.agentManager.deleteAgent(id);
			jsonRes(res, ok ? 200 : 404, { ok });
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleListTasks(res: ServerResponse, url: URL): Promise<void> {
		try {
			if (!this.system?.taskManager) {
				jsonRes(res, 200, []);
				return;
			}
			const status = url.searchParams.get("status") ?? undefined;
			const agentId = url.searchParams.get("agentId") ?? undefined;
			const limit = Number.parseInt(url.searchParams.get("limit") ?? "50");
			const offset = Number.parseInt(url.searchParams.get("offset") ?? "0");
			jsonRes(
				res,
				200,
				await this.system.taskManager.listTasks({
					status,
					agentId,
					limit,
					offset,
				}),
			);
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleCreateTask(
		res: ServerResponse,
		req: IncomingMessage,
	): Promise<void> {
		try {
			if (!this.system?.taskManager) {
				jsonRes(res, 503, { error: "Task manager not available" });
				return;
			}
			const body = JSON.parse(await readBody(req));
			jsonRes(res, 201, await this.system.taskManager.createTask(body));
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleTaskStats(res: ServerResponse): Promise<void> {
		try {
			if (!this.system?.taskManager) {
				jsonRes(res, 200, {
					pending: 0,
					running: 0,
					completed: 0,
					failed: 0,
					total: 0,
				});
				return;
			}
			jsonRes(res, 200, await this.system.taskManager.getTaskStats());
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleGetTask(res: ServerResponse, id: string): Promise<void> {
		try {
			if (!this.system?.taskManager) {
				jsonRes(res, 503, { error: "Task manager not available" });
				return;
			}
			const task = await this.system.taskManager.getTask(id);
			if (!task) {
				jsonRes(res, 404, { error: "Task not found" });
				return;
			}
			jsonRes(res, 200, task);
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleUpdateTask(
		res: ServerResponse,
		req: IncomingMessage,
		id: string,
	): Promise<void> {
		try {
			if (!this.system?.taskManager) {
				jsonRes(res, 503, { error: "Task manager not available" });
				return;
			}
			const body = JSON.parse(await readBody(req));
			const ok = await this.system.taskManager.updateTask(id, body);
			jsonRes(res, ok ? 200 : 404, { ok });
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleDeleteTask(
		res: ServerResponse,
		id: string,
	): Promise<void> {
		try {
			if (!this.system?.taskManager) {
				jsonRes(res, 503, { error: "Task manager not available" });
				return;
			}
			const ok = await this.system.taskManager.deleteTask(id);
			jsonRes(res, ok ? 200 : 404, { ok });
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleListAutomations(res: ServerResponse): Promise<void> {
		try {
			if (!this.system?.automationManager) {
				jsonRes(res, 200, []);
				return;
			}
			jsonRes(res, 200, await this.system.automationManager.listAutomations());
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleCreateAutomation(
		res: ServerResponse,
		req: IncomingMessage,
	): Promise<void> {
		try {
			if (!this.system?.automationManager) {
				jsonRes(res, 503, { error: "Not available" });
				return;
			}
			const body = JSON.parse(await readBody(req));
			jsonRes(
				res,
				201,
				await this.system.automationManager.createAutomation(body),
			);
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleGetAutomation(
		res: ServerResponse,
		id: string,
	): Promise<void> {
		try {
			if (!this.system?.automationManager) {
				jsonRes(res, 503, { error: "Not available" });
				return;
			}
			const a = await this.system.automationManager.getAutomation(id);
			if (!a) {
				jsonRes(res, 404, { error: "Not found" });
				return;
			}
			jsonRes(res, 200, a);
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleUpdateAutomation(
		res: ServerResponse,
		req: IncomingMessage,
		id: string,
	): Promise<void> {
		try {
			if (!this.system?.automationManager) {
				jsonRes(res, 503, { error: "Not available" });
				return;
			}
			const body = JSON.parse(await readBody(req));
			const ok = await this.system.automationManager.updateAutomation(id, body);
			jsonRes(res, ok ? 200 : 404, { ok });
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleToggleAutomation(
		res: ServerResponse,
		id: string,
	): Promise<void> {
		try {
			if (!this.system?.automationManager) {
				jsonRes(res, 503, { error: "Not available" });
				return;
			}
			const ok = await this.system.automationManager.toggleAutomation(id);
			jsonRes(res, ok ? 200 : 404, { ok });
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleDeleteAutomation(
		res: ServerResponse,
		id: string,
	): Promise<void> {
		try {
			if (!this.system?.automationManager) {
				jsonRes(res, 503, { error: "Not available" });
				return;
			}
			const ok = await this.system.automationManager.deleteAutomation(id);
			jsonRes(res, ok ? 200 : 404, { ok });
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleListEnvVars(
		res: ServerResponse,
		url: URL,
	): Promise<void> {
		try {
			if (!this.system?.envVarManager) {
				jsonRes(res, 200, []);
				return;
			}
			const showSecrets = url.searchParams.get("showSecrets") === "true";
			jsonRes(res, 200, await this.system.envVarManager.list(showSecrets));
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleSetEnvVar(
		res: ServerResponse,
		req: IncomingMessage,
	): Promise<void> {
		try {
			if (!this.system?.envVarManager) {
				jsonRes(res, 503, { error: "Not available" });
				return;
			}
			const body = JSON.parse(await readBody(req));
			const result = await this.system.envVarManager.set(body.key, body.value, {
				isSecret: body.isSecret,
				description: body.description,
			});
			if (body?.key && body?.value !== undefined) {
				process.env[String(body.key)] = String(body.value);
			}
			jsonRes(res, 200, result);
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleDeleteEnvVar(
		res: ServerResponse,
		key: string,
	): Promise<void> {
		try {
			if (!this.system?.envVarManager) {
				jsonRes(res, 503, { error: "Not available" });
				return;
			}
			const ok = await this.system.envVarManager.delete(key);
			if (ok) {
				delete process.env[key];
			}
			jsonRes(res, ok ? 200 : 404, { ok });
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleListMCPServers(res: ServerResponse): Promise<void> {
		try {
			if (!this.system?.mcpManager) {
				jsonRes(res, 200, []);
				return;
			}
			jsonRes(res, 200, this.system.mcpManager.listServers());
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleAddMCPServer(
		res: ServerResponse,
		req: IncomingMessage,
	): Promise<void> {
		try {
			if (!this.system?.mcpManager) {
				jsonRes(res, 503, { error: "Not available" });
				return;
			}
			const body = JSON.parse(await readBody(req));
			const server = await this.system.mcpManager.addServer(body.name, {
				command: body.command,
				args: body.args ?? [],
				env: body.env,
			});
			jsonRes(res, 201, server);
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleRemoveMCPServer(
		res: ServerResponse,
		name: string,
	): Promise<void> {
		try {
			if (!this.system?.mcpManager) {
				jsonRes(res, 503, { error: "Not available" });
				return;
			}
			const ok = await this.system.mcpManager.removeServer(name);
			jsonRes(res, ok ? 200 : 404, { ok });
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleRestartMCPServer(
		res: ServerResponse,
		name: string,
	): Promise<void> {
		try {
			if (!this.system?.mcpManager) {
				jsonRes(res, 503, { error: "Not available" });
				return;
			}
			const server = await this.system.mcpManager.restartServer(name);
			if (!server) {
				jsonRes(res, 404, { error: "Server not found" });
				return;
			}
			jsonRes(res, 200, server);
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleSyncMCPServers(
		res: ServerResponse,
		req: IncomingMessage,
	): Promise<void> {
		try {
			if (!this.system?.mcpManager) {
				jsonRes(res, 503, { error: "Not available" });
				return;
			}
			const body = JSON.parse(await readBody(req));
			await this.system.mcpManager.syncServers(body);
			jsonRes(res, 200, { ok: true });
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private handleMCPCatalog(_res: ServerResponse): void {
		jsonRes(_res, 200, MCP_CATALOG);
	}

	private async handleListChannels(res: ServerResponse): Promise<void> {
		try {
			const config = this.loadConfig();
			const channels = Object.entries(config.channels).map(([name, ch]) => {
				const { enabled, ...rest } = ch as {
					enabled: boolean;
					[k: string]: unknown;
				};
				return { name, enabled, type: name, config: rest };
			});
			jsonRes(res, 200, channels);
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleUpdateChannelConfig(
		res: ServerResponse,
		req: IncomingMessage,
		channelName: string,
	): Promise<void> {
		try {
			const raw = JSON.parse(await readBody(req));
			const body =
				raw && typeof raw === "object" && "value" in raw ? raw.value : raw;
			const loader = new ConfigLoader();
			const config = loader.load();
			const channel =
				config.channels[channelName as keyof typeof config.channels];
			if (!channel) {
				jsonRes(res, 404, { error: "Channel not found" });
				return;
			}
			(config.channels as Record<string, Record<string, unknown>>)[
				channelName
			] = {
				enabled: channel.enabled,
				...(typeof body === "object" && body !== null ? body : {}),
			};
			loader.save(config);
			if (this.system) this.system.config = config;
			jsonRes(res, 200, { ok: true, channel: channelName });
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleToggleChannel(
		res: ServerResponse,
		channelName: string,
	): Promise<void> {
		try {
			const loader = new ConfigLoader();
			const config = loader.load();
			const channels = config.channels as Record<string, { enabled: boolean }>;
			const channel = channels[channelName];
			if (!channel) {
				jsonRes(res, 404, { error: "Channel not found" });
				return;
			}
			channel.enabled = !channel.enabled;
			loader.save(config);
			if (this.system) this.system.config = config;
			jsonRes(res, 200, {
				ok: true,
				channel: channelName,
				enabled: channel.enabled,
			});
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleTestTelegramConnection(
		res: ServerResponse,
	): Promise<void> {
		try {
			const config = this.loadConfig();
			const botToken = config.channels?.telegram?.botToken as
				| string
				| undefined;

			if (!botToken) {
				jsonRes(res, 400, {
					success: false,
					error: "Bot token not configured",
				});
				return;
			}

			// Probar la conexión con la API de Telegram
			const response = await fetch(
				`https://api.telegram.org/bot${botToken}/getMe`,
			);
			const data = (await response.json()) as {
				ok: boolean;
				result?: { id: number; first_name: string; username: string };
			};

			if (data.ok && data.result) {
				jsonRes(res, 200, {
					success: true,
					bot: {
						id: data.result.id,
						first_name: data.result.first_name,
						username: data.result.username,
					},
				});
			} else {
				jsonRes(res, 400, { success: false, error: "Invalid bot token" });
			}
		} catch (err) {
			jsonRes(res, 500, { success: false, error: String(err) });
		}
	}

	private handleListMedia(res: ServerResponse): void {
		try {
			const items = loadMediaMeta();
			jsonRes(res, 200, items);
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleUploadMedia(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			const boundary = (req.headers["content-type"] ?? "").split(
				"boundary=",
			)[1];
			if (!boundary) {
				jsonRes(res, 400, { error: "Missing multipart boundary" });
				return;
			}
			const chunks: Buffer[] = [];
			await new Promise<void>((resolve, reject) => {
				req.on("data", (c: Buffer) => chunks.push(c));
				req.on("end", resolve);
				req.on("error", reject);
			});
			const raw = Buffer.concat(chunks);
			const boundaryStr = `--${boundary}`;
			const parts: {
				name: string;
				filename: string;
				data: Buffer;
				mime: string;
			}[] = [];
			let offset = 0;
			while (offset < raw.length) {
				const bStart = raw.indexOf(boundaryStr, offset);
				if (bStart === -1) break;
				const headerEnd = raw.indexOf("\r\n\r\n", bStart);
				if (headerEnd === -1) break;
				const header = raw.slice(bStart, headerEnd).toString("utf-8");
				const nameMatch = header.match(/name="([^"]+)"/);
				const fileMatch = header.match(/filename="([^"]+)"/);
				if (!nameMatch || !fileMatch) {
					offset = headerEnd + 4;
					continue;
				}
				const dataStart = headerEnd + 4;
				const nextBoundary = raw.indexOf(boundaryStr, dataStart);
				const dataEnd = nextBoundary === -1 ? raw.length - 2 : nextBoundary - 2;
				const data = raw.slice(dataStart, dataEnd);
				const mime = guessMime(fileMatch[1]);
				parts.push({ name: nameMatch[1], filename: fileMatch[1], data, mime });
				offset = nextBoundary === -1 ? raw.length : nextBoundary;
			}
			if (parts.length === 0) {
				jsonRes(res, 400, { error: "No file found in upload" });
				return;
			}
			const items = loadMediaMeta();
			const saved: MediaItem[] = [];
			for (const part of parts) {
				const id = randomUUID();
				const ext = extname(part.filename) || MIME_EXTENSIONS[part.mime] || "";
				const storedName = id + ext;
				const filePath = join(MEDIA_DIR, storedName);
				ensureMediaDir();
				writeFileSync(filePath, part.data);
				const item: MediaItem = {
					id,
					filename: part.filename,
					mimetype: part.mime,
					size: part.data.length,
					createdAt: new Date().toISOString(),
				};
				items.push(item);
				saved.push(item);
			}
			saveMediaMeta(items);
			jsonRes(res, 201, saved.length === 1 ? saved[0] : saved);
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleSaveMedia(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			const body = await readBody(req);
			let parsed: {
				filename: string;
				data: string;
				mimetype?: string;
				description?: string;
			};
			try {
				parsed = JSON.parse(body);
			} catch {
				jsonRes(res, 400, { error: "Invalid JSON" });
				return;
			}
			if (!parsed.filename || !parsed.data) {
				jsonRes(res, 400, { error: "Missing filename or data (base64)" });
				return;
			}
			const id = randomUUID();
			const mime = parsed.mimetype || guessMime(parsed.filename);
			const ext = extname(parsed.filename) || MIME_EXTENSIONS[mime] || "";
			const storedName = id + ext;
			const filePath = join(MEDIA_DIR, storedName);
			ensureMediaDir();
			const fileData = Buffer.from(normalizeBase64Data(parsed.data), "base64");
			writeFileSync(filePath, fileData);
			const items = loadMediaMeta();
			const item: MediaItem = {
				id,
				filename: parsed.filename,
				mimetype: mime,
				size: fileData.length,
				createdAt: new Date().toISOString(),
				description: parsed.description,
			};
			items.push(item);
			saveMediaMeta(items);
			jsonRes(res, 201, { ...item, url: `/api/media/file/${id}${ext}` });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private handleServeMediaFile(res: ServerResponse, id: string): void {
		try {
			// Strip any extension from the id (e.g. "uuid.png" -> "uuid")
			const pureId = id.replace(/\.[^.]+$/, "");
			const items = loadMediaMeta();
			const item = items.find((m) => m.id === pureId);
			if (!item) {
				jsonRes(res, 404, { error: "Media not found" });
				return;
			}
			const ext =
				extname(item.filename) || MIME_EXTENSIONS[item.mimetype] || "";
			const filePath = join(MEDIA_DIR, pureId + ext);
			if (!existsSync(filePath)) {
				jsonRes(res, 404, { error: "File not found on disk" });
				return;
			}
			const stat = statSync(filePath);
			corsHeaders(res);
			res.writeHead(200, {
				"Content-Type": item.mimetype,
				"Content-Length": stat.size,
				"Cache-Control": "public, max-age=86400",
			});
			createReadStream(filePath).pipe(res);
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleDeleteMedia(
		res: ServerResponse,
		id: string,
	): Promise<void> {
		try {
			const items = loadMediaMeta();
			const idx = items.findIndex((m) => m.id === id);
			if (idx === -1) {
				jsonRes(res, 404, { error: "Media not found" });
				return;
			}
			const item = items[idx];
			if (!item) return;
			const ext =
				extname(item.filename) || MIME_EXTENSIONS[item.mimetype] || "";
			const filePath = join(MEDIA_DIR, id + ext);
			try {
				unlinkSync(filePath);
			} catch {
				/* file may already be gone */
			}
			items.splice(idx, 1);
			saveMediaMeta(items);
			jsonRes(res, 200, { ok: true });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
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
			await new Promise<void>((resolve) => this.wss?.close(() => resolve()));
			this.wss = null;
		}

		if (this.httpServer) {
			await new Promise<void>((resolve) =>
				this.httpServer?.close(() => resolve()),
			);
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

	onMessage(
		handler: (clientId: string, message: ProtocolMessage<unknown>) => void,
	): void {
		this.emitter.on("message", handler);
	}

	onConnect(handler: (clientId: string) => void): void {
		this.emitter.on("connect", handler);
	}

	onDisconnect(handler: (clientId: string) => void): void {
		this.emitter.on("disconnect", handler);
	}
}
