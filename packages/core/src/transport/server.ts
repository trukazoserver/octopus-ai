import { spawnSync } from "node:child_process";
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
import type { AgentReasoningEffort } from "../agent/types.js";
import {
	coerceReasoningEffort,
	getModelCapabilities,
	getModelCapabilitiesFromRef,
} from "../ai/model-capabilities.js";
import { listCodexModels } from "../ai/providers/codex.js";
import { resolveProviderQuotas } from "../ai/quota-service.js";
import {
	type LLMRouter,
	getProviderRegistry,
	resolveProviderConfig,
} from "../ai/router.js";
import type { ProviderConfig, UsageStats } from "../ai/types.js";
import {
	closeBrowserAuth,
	getAuthResult,
	getAuthStatus,
	startBrowserAuth,
} from "../auth/browser-session.js";
import {
	getCodexResult,
	getCodexStatus,
	startCodexLogin,
} from "../auth/codex-oauth.js";
import {
	findGcloudBinary,
	getActiveGcloudAccount,
	getGcloudLoginStatus,
	readAdcCredentials,
	resetGcloudLoginSession,
	resolveGcloudAccessToken,
	spawnGcloudLogin,
} from "../auth/gcloud-adc.js";
import { prepareVertexProject } from "../auth/google-cloud.js";
import {
	createAuthorizationUrl,
	exchangeCodeForToken,
	refreshAccessToken,
	renderOAuthCallbackPage,
} from "../auth/oauth.js";
import { ConfigLoader } from "../config/loader.js";
import type { OctopusConfig } from "../config/schema.js";
import { ConfigValidator } from "../config/validator.js";
import type {
	ActiveForgettingOptions,
	MemoryActionLogEntry,
	MemoryAuditEntry,
	MemoryFeedbackType,
	MemoryGraphTraversalOptions,
	MemoryReadContext,
	MemoryRelationType,
} from "../memory/types.js";
import type { MCPManagedServer } from "../plugins/mcp/manager.js";
import {
	getZaiMCPConfigs,
	resolveZaiMCPAuth,
} from "../plugins/mcp/zai-servers.js";
import { SecretRedactor } from "../security/secret-redactor.js";
import type { Skill } from "../skills/types.js";
import { resolveRelativePathInside } from "../utils/path-safety.js";
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

type SystemContext = {
	config: OctopusConfig;
	router?: LLMRouter;
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	embedFn?: any;
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	[key: string]: any;
};

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, PATCH, OPTIONS",
	"Access-Control-Allow-Headers":
		"Content-Type, Range, Authorization, X-Octopus-Api-Key",
	"Access-Control-Expose-Headers":
		"Content-Length, Content-Range, Accept-Ranges",
};

const MEMORY_FEEDBACK_TYPES = new Set<Exclude<MemoryFeedbackType, "none">>([
	"explicit_approve",
	"explicit_correct",
	"explicit_delete",
	"implicit_positive",
	"implicit_negative",
	"implicit_neutral",
]);

const MEMORY_RELATION_TYPES = new Set<MemoryRelationType>([
	"associated",
	"mentions",
	"supports",
	"contradicts",
	"supersedes",
	"derived_from",
	"depends_on",
	"caused",
	"blocked_by",
	"entity_of",
	"same_entity_as",
	"prefers",
	"uses",
	"created",
	"updated",
	"confirmed_by",
]);

const SENSITIVE_API_PREFIXES = [
	"/api/automations",
	"/api/channels",
	"/api/config",
	"/api/env",
	"/api/kanban",
	"/api/learning",
	"/api/mcp",
	"/api/memory",
	"/api/skills",
	"/api/tasks",
	"/api/workflows",
];

const CHANNEL_SECRET_CONFIG_KEYS = new Set([
	"botToken",
	"signingSecret",
	"appToken",
]);

const ENV_VAR_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const BROWSER_TOOL_ENV_KEYS = new Set([
	"BRIGHTDATA_WS_URL",
	"TWOCAPTCHA_API_KEY",
	"TWO_CAPTCHA_API_KEY",
	"TWOCAPTCHA_PROXY_ADDRESS",
	"TWOCAPTCHA_PROXY_PORT",
	"TWOCAPTCHA_PROXY_LOGIN",
	"TWOCAPTCHA_PROXY_PASSWORD",
	"DECODO_PROXY_URL",
	"DECODO_PROXY_SERVER",
	"DECODO_PROXY_PROTOCOL",
	"DECODO_PROXY_USERNAME",
	"DECODO_PROXY_USER",
	"DECODO_PROXY_PASSWORD",
	"DECODO_PROXY_PASS",
	"DECODO_PROXY_COUNTRY",
	"DECODO_PROXY_CITY",
	"DECODO_PROXY_STATE",
	"DECODO_PROXY_ZIP",
	"DECODO_PROXY_SESSION",
	"DECODO_PROXY_SESSION_DURATION",
	"DECODO_SCRAPER_TOKEN",
	"DECODO_API_TOKEN",
	"DECODO_SCRAPER_USERNAME",
	"DECODO_API_USERNAME",
	"DECODO_SCRAPER_PASSWORD",
	"DECODO_API_PASSWORD",
]);

const API_CONFIG_REDACTOR = new SecretRedactor({ mask: "****" });

function getSecretPreview(value: string): string {
	if (value.length <= 8) return "configured";
	return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function redactChannelConfig(
	config: Record<string, unknown>,
): Record<string, unknown> {
	const redacted: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		if (!CHANNEL_SECRET_CONFIG_KEYS.has(key)) {
			redacted[key] = value;
			continue;
		}

		const configured = typeof value === "string" && value.trim().length > 0;
		redacted[`${key}Configured`] = configured;
		if (configured) redacted[`${key}Preview`] = getSecretPreview(value.trim());
	}
	return redacted;
}

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
const MEDIA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

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
	"text/markdown": ".md",
	"text/html": ".html",
	"text/xml": ".xml",
	"application/xml": ".xml",
	"application/yaml": ".yaml",
	"text/yaml": ".yaml",
	"text/x-yaml": ".yaml",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		".docx",
	"application/msword": ".doc",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
	"application/vnd.ms-excel": ".xls",
	"application/vnd.oasis.opendocument.spreadsheet": ".ods",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation":
		".pptx",
	"application/vnd.ms-powerpoint": ".ppt",
	"application/vnd.oasis.opendocument.text": ".odt",
	"application/vnd.oasis.opendocument.presentation": ".odp",
	"application/rtf": ".rtf",
	"application/zip": ".zip",
	"application/x-zip-compressed": ".zip",
	"application/x-rar-compressed": ".rar",
	"application/x-7z-compressed": ".7z",
	"application/gzip": ".gz",
	"application/x-tar": ".tar",
	"text/javascript": ".js",
	"application/javascript": ".js",
	"text/typescript": ".ts",
	"text/x-python": ".py",
	"application/x-sh": ".sh",
	"text/x-sql": ".sql",
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

function mediaCreatedAtMs(item: MediaItem): number {
	const time = Date.parse(item.createdAt);
	return Number.isFinite(time) ? time : 0;
}

function sortMediaNewestFirst(items: MediaItem[]): MediaItem[] {
	return [...items].sort((a, b) => mediaCreatedAtMs(b) - mediaCreatedAtMs(a));
}

function parseStoredJsonObject(value: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
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
		".bmp": "image/bmp",
		".ico": "image/x-icon",
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
		".tsv": "text/tab-separated-values",
		".txt": "text/plain",
		".md": "text/markdown",
		".markdown": "text/markdown",
		".html": "text/html",
		".htm": "text/html",
		".xml": "application/xml",
		".yaml": "application/yaml",
		".yml": "application/yaml",
		".log": "text/plain",
		".ini": "text/plain",
		".toml": "text/plain",
		".docx":
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		".doc": "application/msword",
		".xlsx":
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		".xls": "application/vnd.ms-excel",
		".ods": "application/vnd.oasis.opendocument.spreadsheet",
		".pptx":
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		".ppt": "application/vnd.ms-powerpoint",
		".odt": "application/vnd.oasis.opendocument.text",
		".odp": "application/vnd.oasis.opendocument.presentation",
		".rtf": "application/rtf",
		".zip": "application/zip",
		".rar": "application/x-rar-compressed",
		".7z": "application/x-7z-compressed",
		".gz": "application/gzip",
		".tar": "application/x-tar",
		".js": "text/javascript",
		".mjs": "text/javascript",
		".cjs": "text/javascript",
		".ts": "text/typescript",
		".tsx": "text/typescript",
		".jsx": "text/javascript",
		".py": "text/x-python",
		".sh": "application/x-sh",
		".sql": "text/x-sql",
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

function parseMemoryIds(params: URLSearchParams): string[] {
	const ids = params.get("ids") ?? params.get("id") ?? "";
	return ids
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const KANBAN_MAX_GOAL_LENGTH = 4000;
const KANBAN_MAX_TEXT_LENGTH = 4000;
const KANBAN_MAX_COMMENT_TYPE_LENGTH = 64;
const KANBAN_MAX_TASKS_PER_PLAN = 200;

function badRequest(message: string): Error {
	return new Error(`BAD_REQUEST:${message}`);
}

function badRequestMessage(err: unknown): string | null {
	const message = err instanceof Error ? err.message : String(err);
	return message.startsWith("BAD_REQUEST:")
		? message.slice("BAD_REQUEST:".length)
		: null;
}

function parseJsonRecord(raw: string): Record<string, unknown> {
	try {
		const parsed = raw ? (JSON.parse(raw) as unknown) : {};
		if (!isRecord(parsed)) throw badRequest("JSON body must be an object");
		return parsed;
	} catch (err) {
		if (badRequestMessage(err)) throw err;
		throw badRequest("Invalid JSON body");
	}
}

function boundedString(
	value: unknown,
	field: string,
	maxLength: number,
	options: { required?: boolean; fallback?: string } = {},
): string | undefined {
	if (value === undefined || value === null) {
		if (options.required) throw badRequest(`${field} is required`);
		return options.fallback;
	}
	if (typeof value !== "string") throw badRequest(`${field} must be a string`);
	const trimmed = value.trim();
	if (options.required && trimmed.length === 0) {
		throw badRequest(`${field} is required`);
	}
	if (trimmed.length > maxLength) {
		throw badRequest(`${field} must be ${maxLength} characters or less`);
	}
	return trimmed || options.fallback;
}

function normalizeMemorySourceTrust(value: unknown): string {
	return value === "system" ||
		value === "agent" ||
		value === "user_explicit" ||
		value === "user_inferred" ||
		value === "external"
		? value
		: "user_explicit";
}

function normalizeMemoryType(value: unknown): string {
	return value === "episodic" ||
		value === "semantic" ||
		value === "procedural" ||
		value === "user" ||
		value === "org" ||
		value === "agent" ||
		value === "prospective" ||
		value === "meta"
		? value
		: "semantic";
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

function maskUrlCredentials(value: unknown, seen = new WeakSet()): unknown {
	if (typeof value === "string") {
		if (value.length === 0) return value;
		try {
			const url = new URL(value);
			if (url.username || url.password) {
				url.username = "****";
				url.password = "****";
			}
			return url.toString();
		} catch {
			return value;
		}
	}
	if (!value || typeof value !== "object") return value;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	if (Array.isArray(value)) {
		return value.map((item) => maskUrlCredentials(item, seen));
	}

	const masked: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		masked[key] = maskUrlCredentials(item, seen);
	}
	return masked;
}

function maskApiKeys(config: OctopusConfig): Record<string, unknown> {
	const cloned = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
	return API_CONFIG_REDACTOR.redact(maskUrlCredentials(cloned)) as Record<
		string,
		unknown
	>;
}

function configuredApiKey(config: OctopusConfig | undefined): string {
	return (
		config?.security.memoryApiKey?.trim() ||
		process.env.OCTOPUS_MEMORY_API_KEY?.trim() ||
		process.env.OCTOPUS_API_KEY?.trim() ||
		""
	);
}

function isLoopbackHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	return (
		normalized === "localhost" ||
		normalized === "127.0.0.1" ||
		normalized === "::1" ||
		normalized === "[::1]"
	);
}

function isSensitiveApiPath(pathname: string): boolean {
	return SENSITIVE_API_PREFIXES.some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
	);
}

function headerValue(value: string | string[] | undefined): string {
	return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function extractApiKey(req: IncomingMessage): string {
	const explicitKey = headerValue(req.headers["x-octopus-api-key"]).trim();
	if (explicitKey) return explicitKey;
	const authorization = headerValue(req.headers.authorization).trim();
	const match = authorization.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() ?? "";
}

function timingSafeTokenEquals(actual: string, expected: string): boolean {
	if (!actual || !expected) return false;
	const actualHash = crypto.createHash("sha256").update(actual).digest();
	const expectedHash = crypto.createHash("sha256").update(expected).digest();
	return crypto.timingSafeEqual(actualHash, expectedHash);
}

function emptyUsageAggregate() {
	return {
		totalTokens: 0,
		promptTokens: 0,
		completionTokens: 0,
		reasoningTokens: 0,
		totalCost: 0,
		requests: 0,
		byProvider: {} as Record<string, unknown>,
	};
}

function describeModelRef(
	config: OctopusConfig,
	router: LLMRouter | undefined,
	modelRef: string | undefined,
): { provider?: string; providerDisplayName?: string; model?: string } {
	if (!modelRef) return {};
	const registry = getProviderRegistry();
	const slashIndex = modelRef.indexOf("/");
	if (slashIndex !== -1) {
		const provider = modelRef.slice(0, slashIndex);
		return {
			provider,
			providerDisplayName: registry[provider]?.displayName ?? provider,
			model: modelRef.slice(slashIndex + 1),
		};
	}

	for (const [provider, providerConfig] of Object.entries(
		config.ai.providers,
	)) {
		const models =
			"models" in providerConfig && Array.isArray(providerConfig.models)
				? providerConfig.models
				: [];
		if (models.includes(modelRef)) {
			return {
				provider,
				providerDisplayName: registry[provider]?.displayName ?? provider,
				model: modelRef,
			};
		}
	}

	for (const [provider, entry] of Object.entries(registry)) {
		if (entry.defaultModels.includes(modelRef)) {
			return {
				provider,
				providerDisplayName: entry.displayName,
				model: modelRef,
			};
		}
	}

	const activeProvider = router?.getAvailableProviders()[0];
	return {
		provider: activeProvider,
		providerDisplayName: activeProvider
			? (registry[activeProvider]?.displayName ?? activeProvider)
			: undefined,
		model: modelRef,
	};
}

export class TransportServer {
	private port: number;
	private host: string;
	private httpServer: Server | null = null;
	private wss: WebSocketServer | null = null;
	private emitter = new EventEmitter<ServerEvents>();
	private clients = new Map<string, WSWebSocket>();
	private conversationSubscriptions = new Map<string, Set<string>>();
	private system: SystemContext | null = null;

	constructor(opts: TransportServerOptions = {}) {
		this.port = opts.port ?? 18789;
		this.host = opts.host ?? "127.0.0.1";
	}

	setSystemContext(system: SystemContext): void {
		this.system = system;
	}

	private authorizeSensitiveApiRequest(
		req: IncomingMessage,
		res: ServerResponse,
	): boolean {
		const expectedKey = configuredApiKey(this.system?.config);
		if (!expectedKey) {
			if (isLoopbackHost(this.host)) return true;
			jsonRes(res, 403, {
				error:
					"Sensitive API requests require OCTOPUS_API_KEY when listening on a non-loopback host",
			});
			return false;
		}
		const providedKey = extractApiKey(req);
		if (timingSafeTokenEquals(providedKey, expectedKey)) return true;
		res.setHeader("WWW-Authenticate", 'Bearer realm="octopus-api"');
		jsonRes(res, 401, { error: "Unauthorized API request" });
		return false;
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

				if (req.method === "GET" && pathname === "/api/models") {
					this.handleGetModels(res);
					return;
				}

				if (req.method === "GET" && pathname === "/api/usage") {
					void this.handleGetUsage(res, url);
					return;
				}

				if (req.method === "GET" && pathname === "/api/quotas") {
					void this.handleGetQuotas(res);
					return;
				}

				if (
					isSensitiveApiPath(pathname) &&
					!this.authorizeSensitiveApiRequest(req, res)
				) {
					return;
				}

				if (req.method === "GET" && pathname === "/api/config") {
					this.handleGetConfig(res);
					return;
				}

				if (
					req.method === "POST" &&
					pathname === "/api/config/apply/embeddings"
				) {
					void this.handleApplyEmbeddingConfig(res);
					return;
				}

				if (req.method === "GET" && pathname.startsWith("/api/config/")) {
					const keyPath = pathname.slice("/api/config/".length);
					this.handleGetConfigKey(res, keyPath);
					return;
				}

				if (
					req.method === "POST" &&
					/^\/api\/auth\/(google|openai|anthropic|deepseek|xai)\/start$/.test(
						pathname,
					)
				) {
					const provider = pathname.split("/")[3];
					void this.handleOAuthStart(req, res, provider);
					return;
				}

				if (
					req.method === "POST" &&
					/^\/api\/auth\/(google|openai|anthropic|deepseek|xai)\/refresh$/.test(
						pathname,
					)
				) {
					const provider = pathname.split("/")[3];
					void this.handleOAuthRefresh(req, res, provider);
					return;
				}

				if (
					req.method === "POST" &&
					pathname === "/api/auth/google/vertex-setup"
				) {
					void this.handleGoogleVertexSetup(req, res);
					return;
				}
				if (
					req.method === "POST" &&
					pathname === "/api/auth/google/gcloud-login"
				) {
					this.handleGcloudLoginStart(res);
					return;
				}
				if (
					req.method === "GET" &&
					pathname === "/api/auth/google/gcloud-status"
				) {
					this.handleGcloudLoginStatus(res);
					return;
				}
				if (req.method === "POST" && pathname === "/api/auth/google/connect") {
					void this.handleGoogleConnect(req, res);
					return;
				}
				if (
					req.method === "POST" &&
					/^\/api\/providers\/[a-z]+\/test$/.test(pathname)
				) {
					const provider = pathname.split("/")[3];
					void this.handleProviderTest(req, res, provider);
					return;
				}
				if (
					req.method === "POST" &&
					/^\/api\/providers\/[a-z]+\/disconnect$/.test(pathname)
				) {
					const provider = pathname.split("/")[3];
					void this.handleProviderDisconnect(req, res, provider);
					return;
				}

				if (
					req.method === "POST" &&
					/^\/api\/auth\/(openai|anthropic|google|deepseek|xai)\/browser-start$/.test(
						pathname,
					)
				) {
					const provider = pathname.split("/")[3];
					void this.handleBrowserAuthStart(req, res, provider);
					return;
				}

				if (
					req.method === "GET" &&
					/^\/api\/auth\/(openai|anthropic|google|deepseek|xai)\/browser-status$/.test(
						pathname,
					)
				) {
					const provider = pathname.split("/")[3];
					void this.handleBrowserAuthStatus(req, res, provider);
					return;
				}

				if (
					req.method === "POST" &&
					/^\/api\/auth\/(openai|anthropic|google|deepseek|xai)\/browser-result$/.test(
						pathname,
					)
				) {
					const provider = pathname.split("/")[3];
					void this.handleBrowserAuthResult(req, res, provider);
					return;
				}

				if (req.method === "PUT" && pathname.startsWith("/api/config/")) {
					const keyPath = pathname.slice("/api/config/".length);
					void this.handlePutConfigKey(req, res, keyPath);
					return;
				}

				if (req.method === "GET" && pathname === "/api/memory/stats") {
					void this.handleMemoryStats(res);
					return;
				}

				if (req.method === "GET" && pathname === "/api/memory/config") {
					this.handleMemoryConfigGet(res);
					return;
				}

				if (pathname.startsWith("/api/memory/knowledge")) {
					void this.handleKnowledgeApi(req, res, url, pathname);
					return;
				}

				if (req.method === "GET" && pathname === "/api/memory/search") {
					const q = url.searchParams.get("q") ?? "";
					void this.handleMemorySearch(res, q);
					return;
				}

				if (
					req.method === "POST" &&
					pathname === "/api/memory/context/retrieve"
				) {
					void this.handleMemoryContextRetrieve(req, res);
					return;
				}

				if (req.method === "POST" && pathname === "/api/memory/create") {
					void this.handleMemoryCreate(req, res);
					return;
				}

				if (req.method === "POST" && pathname === "/api/memory/feedback") {
					void this.handleMemoryFeedback(req, res);
					return;
				}

				if (req.method === "POST" && pathname === "/api/memory/forget") {
					void this.handleMemoryForget(req, res);
					return;
				}

				if (req.method === "POST" && pathname === "/api/memory/backfill") {
					void this.handleMemoryBackfill(req, res);
					return;
				}

				if (req.method === "POST" && pathname === "/api/memory/retention/run") {
					void this.handleMemoryRetentionRun(req, res);
					return;
				}

				if (req.method === "GET" && pathname === "/api/memory/sources") {
					void this.handleMemorySources(res, url.searchParams);
					return;
				}

				if (req.method === "GET" && pathname === "/api/memory/graph") {
					void this.handleMemoryGraph(res, url.searchParams);
					return;
				}

				if (
					req.method === "POST" &&
					pathname === "/api/memory/graph/traverse"
				) {
					void this.handleMemoryGraphTraverse(req, res);
					return;
				}

				if (
					req.method === "GET" &&
					pathname === "/api/memory/audit/integrity"
				) {
					void this.handleMemoryAuditIntegrity(res);
					return;
				}

				if (req.method === "GET" && pathname === "/api/memory/audit") {
					void this.handleMemoryAudit(res, url.searchParams);
					return;
				}

				if (req.method === "GET" && pathname === "/api/memory/actions") {
					void this.handleMemoryActions(res, url.searchParams);
					return;
				}

				if (req.method === "GET" && pathname === "/api/memory/verify") {
					const id = url.searchParams.get("id") ?? "";
					void this.handleMemoryVerify(res, id ? [id] : [], url.searchParams);
					return;
				}

				if (req.method === "POST" && pathname === "/api/memory/verify") {
					void this.handleMemoryVerifyPost(req, res);
					return;
				}

				if (req.method === "POST" && pathname === "/api/memory/consolidate") {
					void this.handleMemoryConsolidate(res);
					return;
				}

				if (req.method === "GET" && pathname === "/api/learning/insights") {
					void this.handleLearningInsights(res, url.searchParams);
					return;
				}

				if (req.method === "GET" && pathname === "/api/learning/experiences") {
					void this.handleLearningExperiences(res, url.searchParams);
					return;
				}

				if (req.method === "POST" && pathname === "/api/learning/feedback") {
					void this.handleLearningFeedback(req, res);
					return;
				}

				if (
					req.method === "DELETE" &&
					/^\/api\/learning\/insights\/[^/]+$/.test(pathname)
				) {
					const id = decodeURIComponent(pathname.split("/").pop() ?? "");
					void this.handleForgetLearningInsight(res, id);
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

				if (req.method === "GET" && pathname === "/api/tools") {
					this.handleGetToolsUnified(res);
					return;
				}

				if (
					req.method === "POST" &&
					pathname.startsWith("/api/tools/system/") &&
					pathname.endsWith("/toggle")
				) {
					const toolName = decodeURIComponent(pathname.split("/")[4] ?? "");
					void this.handleToggleSystemTool(res, toolName);
					return;
				}

				if (
					req.method === "GET" &&
					/^\/api\/tools\/dynamic\/[^/]+$/.test(pathname)
				) {
					const toolName = decodeURIComponent(pathname.split("/").pop() ?? "");
					this.handleGetDynamicToolDetail(res, toolName);
					return;
				}

				if (
					req.method === "PUT" &&
					/^\/api\/tools\/dynamic\/[^/]+$/.test(pathname)
				) {
					const toolName = decodeURIComponent(pathname.split("/").pop() ?? "");
					void this.handleUpdateDynamicTool(req, res, toolName);
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

				if (req.method === "GET" && pathname === "/api/chat/executions") {
					void this.handleListActiveChatExecutions(res);
					return;
				}

				if (req.method === "POST" && pathname === "/api/conversations") {
					void this.handleCreateConversation(req, res);
					return;
				}

				if (
					req.method === "GET" &&
					pathname.startsWith("/api/conversations/") &&
					pathname.endsWith("/tool-actions")
				) {
					const convId = pathname
						.slice("/api/conversations/".length)
						.replace(/\/tool-actions$/, "");
					void this.handleGetConversationToolActions(res, convId, url);
					return;
				}

				if (
					req.method === "GET" &&
					pathname.startsWith("/api/conversations/") &&
					pathname.endsWith("/execution")
				) {
					const convId = pathname
						.slice("/api/conversations/".length)
						.replace(/\/execution$/, "");
					void this.handleGetConversationExecution(res, convId);
					return;
				}

				if (
					req.method === "POST" &&
					pathname.startsWith("/api/conversations/") &&
					pathname.endsWith("/stop")
				) {
					const convId = pathname
						.slice("/api/conversations/".length)
						.replace(/\/stop$/, "");
					void this.handleStopConversationExecution(res, convId);
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
				if (req.method === "POST" && pathname === "/api/agents/messages") {
					void this.handleSendAgentMessage(res, req);
					return;
				}
				if (
					req.method === "GET" &&
					/^\/api\/agents\/[^/]+\/messages$/.test(pathname)
				) {
					const agentId = pathname.split("/")[3] ?? "";
					void this.handleListAgentMessages(res, url, agentId);
					return;
				}
				if (
					req.method === "POST" &&
					/^\/api\/agents\/[^/]+\/messages\/read$/.test(pathname)
				) {
					const agentId = pathname.split("/")[3] ?? "";
					void this.handleMarkAgentMessagesRead(res, req, agentId);
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
				if (req.method === "GET" && pathname === "/api/workflows") {
					void this.handleListWorkflows(res, url);
					return;
				}
				if (
					req.method === "GET" &&
					pathname === "/api/kanban/dispatcher/status"
				) {
					void this.handleKanbanDispatcherStatus(res);
					return;
				}
				if (
					req.method === "POST" &&
					pathname === "/api/kanban/dispatcher/tick"
				) {
					void this.handleKanbanDispatcherTick(res);
					return;
				}
				if (
					req.method === "POST" &&
					/^\/api\/kanban\/dispatcher\/(pause|resume)$/.test(pathname)
				) {
					void this.handleKanbanDispatcherControl(
						res,
						pathname.endsWith("/resume"),
					);
					return;
				}
				if (req.method === "POST" && pathname === "/api/kanban/plan") {
					void this.handleCreateKanbanPlan(res, req);
					return;
				}
				if (
					req.method === "GET" &&
					/^\/api\/kanban\/runs\/[^/]+$/.test(pathname)
				) {
					const workflowId = pathname.split("/").pop() ?? "";
					void this.handleGetWorkflow(res, workflowId);
					return;
				}
				if (
					req.method === "GET" &&
					/^\/api\/kanban\/tasks\/[^/]+\/context$/.test(pathname)
				) {
					const parts = pathname.split("/");
					const taskId = parts[4] ?? "";
					void this.handleGetKanbanTaskContext(res, taskId);
					return;
				}
				if (
					req.method === "POST" &&
					/^\/api\/kanban\/requirements\/[^/]+\/(satisfy|reset)$/.test(pathname)
				) {
					const parts = pathname.split("/");
					const requirementId = parts[4] ?? "";
					const action = parts[5] ?? "";
					void this.handleKanbanRequirementAction(
						res,
						req,
						requirementId,
						action,
					);
					return;
				}
				if (
					req.method === "POST" &&
					/^\/api\/kanban\/tasks\/[^/]+\/(retry|approve|reject|unblock|block|comment)$/.test(
						pathname,
					)
				) {
					const parts = pathname.split("/");
					const taskId = parts[4] ?? "";
					const action = parts[5] ?? "";
					void this.handleKanbanTaskAction(res, req, taskId, action);
					return;
				}
				if (req.method === "GET" && pathname === "/api/kanban/workers/active") {
					void this.handleKanbanWorkersActive(res);
					return;
				}
				if (
					req.method === "GET" &&
					/^\/api\/kanban\/runs\/[^/]+\/board$/.test(pathname)
				) {
					const parts = pathname.split("/");
					const runId = parts[4] ?? "";
					void this.handleKanbanRunBoard(res, runId);
					return;
				}
				if (req.method === "GET" && pathname === "/api/kanban/blackboard") {
					void this.handleKanbanBlackboardGet(res);
					return;
				}
				if (req.method === "POST" && pathname === "/api/kanban/blackboard") {
					void this.handleKanbanBlackboardSet(req, res);
					return;
				}
				if (req.method === "GET" && pathname === "/api/kanban/inspect") {
					void this.handleKanbanInspect(res);
					return;
				}
				if (req.method === "POST" && pathname === "/api/workflows/recover") {
					void this.handleRecoverWorkflows(res);
					return;
				}
				if (
					req.method === "POST" &&
					/^\/api\/workflows\/[^/]+\/(retry|cancel)$/.test(pathname)
				) {
					const parts = pathname.split("/");
					const workflowId = parts[3] ?? "";
					const action = parts[4] ?? "";
					void this.handleWorkflowAction(res, req, workflowId, action);
					return;
				}
				if (
					req.method === "GET" &&
					/^\/api\/workflows\/[^/]+$/.test(pathname)
				) {
					const workflowId = pathname.split("/").pop() ?? "";
					void this.handleGetWorkflow(res, workflowId);
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
				if (req.method === "GET" && /^\/api\/env\/[^/]+$/.test(pathname)) {
					const key = decodeURIComponent(pathname.split("/").pop() ?? "");
					void this.handleGetEnvVar(res, key);
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

				if (
					req.method === "POST" &&
					/^\/api\/mcp\/servers\/[^/]+\/toggle$/.test(pathname)
				) {
					const parts = pathname.split("/");
					const serverName = decodeURIComponent(parts[4] ?? "");
					void this.handleToggleMCPServer(res, serverName);
					return;
				}

				if (
					req.method === "GET" &&
					/^\/api\/mcp\/servers\/[^/]+$/.test(pathname)
				) {
					const serverName = decodeURIComponent(
						pathname.split("/").pop() ?? "",
					);
					void this.handleGetMCPServer(res, serverName);
					return;
				}

				if (
					req.method === "PUT" &&
					/^\/api\/mcp\/servers\/[^/]+$/.test(pathname)
				) {
					const serverName = decodeURIComponent(
						pathname.split("/").pop() ?? "",
					);
					void this.handleUpdateMCPServer(req, res, serverName);
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
				if (
					req.method === "GET" &&
					pathname.startsWith("/api/media/thumbnail/")
				) {
					const mediaId = pathname.slice("/api/media/thumbnail/".length);
					this.handleServeMediaThumbnail(res, mediaId);
					return;
				}
				if (req.method === "GET" && pathname.startsWith("/api/media/file/")) {
					const mediaId = pathname.slice("/api/media/file/".length);
					this.handleServeMediaFile(req, res, mediaId);
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

				if (
					req.method === "GET" &&
					/^\/api\/auth\/(google|openai|anthropic|deepseek|xai)\/callback$/.test(
						pathname,
					)
				) {
					const provider = pathname.split("/")[3];
					void this.handleOAuthCallback(req, res, provider);
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
					jpg: "image/jpeg",
					jpeg: "image/jpeg",
					webp: "image/webp",
					svg: "image/svg+xml",
					ico: "image/x-icon",
					wasm: "application/wasm",
				};
				if (pathname.startsWith("/mascotas/")) {
					const mascotFilename = basename(decodeURIComponent(pathname));
					const mascotCandidates = [
						resolve(
							dirname(fileURLToPath(import.meta.url)),
							"../../../../assets/mascotas",
							mascotFilename,
						),
						resolve(
							dirname(fileURLToPath(import.meta.url)),
							"../../../assets/mascotas",
							mascotFilename,
						),
					];
					const mascotPath = mascotCandidates.find((candidate) => {
						try {
							return existsSync(candidate) && statSync(candidate).isFile();
						} catch {
							return false;
						}
					});
					if (mascotPath) {
						const ext = mascotFilename.split(".").pop()?.toLowerCase() ?? "";
						res.writeHead(200, {
							"Content-Type": mimeTypes[ext] ?? "application/octet-stream",
							"Cache-Control": "public, max-age=86400",
						});
						createReadStream(mascotPath).pipe(res);
						return;
					}
				}
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
				this.unsubscribeClientFromAllConversations(clientId);
				this.emitter.emit("disconnect", clientId);
			});

			ws.on("error", () => {
				this.clients.delete(clientId);
				this.unsubscribeClientFromAllConversations(clientId);
				this.emitter.emit("disconnect", clientId);
			});

			this.emitter.emit("connect", clientId);
		});

		this.httpServer.requestTimeout = 600_000;
		this.httpServer.headersTimeout = 120_000;
		this.httpServer.keepAliveTimeout = 30_000;

		return new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				this.httpServer?.removeListener("error", onError);
				this.wss?.removeListener("error", onError);
			};
			const onError = (err: Error) => {
				cleanup();
				reject(err);
			};

			this.httpServer?.once("error", onError);
			this.wss?.once("error", onError);
			this.httpServer?.listen(this.port, this.host, () => {
				cleanup();
				resolve();
			});
		});
	}

	private handleStatus(res: ServerResponse): void {
		try {
			const config = this.loadConfig();
			const router = this.system?.router;
			const mainRuntime = this.system?.agentRuntime;
			// Effective model/reasoning come from the main agent's runtime config
			// (the source of truth), not the raw `config.ai.default` alias.
			const effectiveModel =
				mainRuntime?.getConfig().model ?? config.ai.default;
			const active = describeModelRef(config, router, effectiveModel);
			const fallback = describeModelRef(config, router, config.ai.fallback);
			const usage: UsageStats | undefined = router?.getUsage();
			const enabledChannels: string[] = [];
			for (const [name, ch] of Object.entries(config.channels)) {
				if (ch.enabled) enabledChannels.push(name);
			}
			const agent = mainRuntime
				? {
						id: mainRuntime.getConfig().id,
						name: mainRuntime.getConfig().name,
						model: active.model ?? effectiveModel,
						provider: active.provider,
						providerDisplayName: active.providerDisplayName,
						reasoningEffort: mainRuntime.getConfig().reasoningEffort ?? "none",
					}
				: undefined;
			jsonRes(res, 200, {
				status: "running",
				provider: active.provider,
				providerDisplayName: active.providerDisplayName,
				model: active.model ?? effectiveModel,
				agent,
				fallback: config.ai.fallback,
				fallbackProvider: fallback.provider,
				fallbackModel: fallback.model,
				// Compatibility alias — mirrors the effective agent reasoning now.
				thinking:
					mainRuntime?.getConfig().reasoningEffort ?? config.ai.thinking,
				maxTokens: config.ai.maxTokens,
				availableProviders: router?.getAvailableProviders() ?? [],
				configuredProviders:
					new ConfigLoader().getExplicitlyConfiguredProviderKeys(),
				authStatus: router?.getAuthStatus() ?? {},
				usage,
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

	private async handleGetModels(res: ServerResponse): Promise<void> {
		try {
			const config = this.loadConfig();
			const router = this.system?.router;
			const registry = getProviderRegistry();
			const availableProviders = new Set(router?.getAvailableProviders() ?? []);
			const entries: Array<{
				provider: string;
				providerDisplayName: string;
				models: string[];
			}> = [];
			for (const [provider, providerConfig] of Object.entries(
				config.ai.providers,
			)) {
				if (!availableProviders.has(provider)) continue;
				const pc = providerConfig as Record<string, unknown>;
				const configuredModels =
					"models" in providerConfig && Array.isArray(providerConfig.models)
						? (providerConfig.models as string[])
						: [];
				let models: string[];
				// Codex (ChatGPT account): fetch the live model list from the backend
				// (= `codex models`) instead of the static api-key defaults.
				if (
					provider === "openai" &&
					pc.authMode === "codex" &&
					typeof pc.accessToken === "string" &&
					pc.accessToken
				) {
					const live = await listCodexModels(pc.accessToken);
					models = [...new Set([...configuredModels, ...live])];
					// Fallback to the registry defaults if the live fetch failed.
					if (models.length === 0) {
						models = [...(registry[provider]?.defaultModels ?? [])];
					}
				} else {
					const defaultModels = registry[provider]?.defaultModels ?? [];
					models = [...new Set([...configuredModels, ...defaultModels])];
				}
				if (models.length > 0) {
					entries.push({
						provider,
						providerDisplayName: registry[provider]?.displayName ?? provider,
						models,
					});
				}
			}
			// Rich per-model metadata (reasoning capabilities) for the UI selectors.
			// Kept as a separate field so existing `providers` consumers are unaffected.
			const modelCapabilities = entries.flatMap((entry) =>
				entry.models.map((model) =>
					getModelCapabilities(entry.provider, model),
				),
			);
			jsonRes(res, 200, { providers: entries, modelCapabilities });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleGetUsage(res: ServerResponse, url: URL): Promise<void> {
		try {
			const usageStore = this.system?.usageStore;
			if (!usageStore) {
				jsonRes(res, 200, {
					total: emptyUsageAggregate(),
					byProvider: [],
					byAgent: [],
					persisted: false,
				});
				return;
			}
			const filters = {
				from: url.searchParams.get("from") ?? undefined,
				to: url.searchParams.get("to") ?? undefined,
				agentId: url.searchParams.get("agentId") ?? undefined,
				provider: url.searchParams.get("provider") ?? undefined,
			};
			const [total, byProvider, byAgent] = await Promise.all([
				usageStore.aggregate(filters),
				usageStore.byProvider(filters),
				usageStore.byAgent(filters),
			]);
			jsonRes(res, 200, {
				total,
				byProvider,
				byAgent,
				filters,
				persisted: true,
			});
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleGetQuotas(res: ServerResponse): Promise<void> {
		try {
			const quotas = await resolveProviderQuotas(
				this.loadConfig(),
				this.system?.router,
				this.system?.usageStore,
			);
			jsonRes(res, 200, {
				providers: quotas,
				updatedAt: new Date().toISOString(),
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

	private async handleOAuthStart(
		req: IncomingMessage,
		res: ServerResponse,
		provider: string,
	): Promise<void> {
		try {
			const body = await readBody(req);
			let parsed: { clientId?: string; clientSecret?: string };
			try {
				parsed = JSON.parse(body);
			} catch {
				jsonRes(res, 400, { error: "Invalid JSON body" });
				return;
			}

			if (!parsed.clientId) {
				jsonRes(res, 400, { error: "clientId is required" });
				return;
			}

			const host =
				req.headers.host ??
				`127.0.0.1:${this.system?.config?.server?.port ?? 18789}`;
			const protocol =
				host.startsWith("127.0.0.1") || host.startsWith("localhost")
					? "http"
					: "https";
			const redirectUri = `${protocol}://${host}/api/auth/${provider}/callback`;

			const { url } = createAuthorizationUrl(
				provider,
				redirectUri,
				parsed.clientId,
				parsed.clientSecret,
			);

			const loader = new ConfigLoader();
			const config = loader.load();
			const configObj = config as unknown as Record<string, unknown>;
			const providerConfig = (configObj.ai as Record<string, unknown>)
				.providers as Record<string, unknown>;
			const prov = (providerConfig[provider] as Record<string, unknown>) ?? {};
			prov.oauthClientId = parsed.clientId;
			if (parsed.clientSecret) prov.oauthClientSecret = parsed.clientSecret;
			providerConfig[provider] = prov;
			loader.save(config);

			jsonRes(res, 200, { authorizationUrl: url });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : "OAuth start failed",
			});
		}
	}

	private async handleOAuthRefresh(
		req: IncomingMessage,
		res: ServerResponse,
		provider: string,
	): Promise<void> {
		try {
			const loader = new ConfigLoader();
			const config = loader.load();
			const configObj = config as unknown as Record<string, unknown>;
			const providerConfig = (configObj.ai as Record<string, unknown>)
				.providers as Record<string, unknown>;
			const prov = (providerConfig[provider] as Record<string, unknown>) ?? {};

			const refreshToken = prov.oauthRefreshToken as string | undefined;
			const clientId = prov.oauthClientId as string | undefined;
			const clientSecret = prov.oauthClientSecret as string | undefined;

			if (!refreshToken || !clientId) {
				jsonRes(res, 400, { error: "No stored refresh token or client ID" });
				return;
			}

			const tokens = await refreshAccessToken(
				provider,
				refreshToken,
				clientId,
				clientSecret,
			);

			prov.oauthAccessToken = tokens.access_token;
			if (tokens.refresh_token) prov.oauthRefreshToken = tokens.refresh_token;
			prov.oauthExpiresAt = Date.now() + tokens.expires_in * 1000;
			providerConfig[provider] = prov;
			loader.save(config);

			jsonRes(res, 200, {
				accessToken: tokens.access_token,
				expiresIn: tokens.expires_in,
			});
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : "Token refresh failed",
			});
		}
	}

	private async handleOAuthCallback(
		req: IncomingMessage,
		res: ServerResponse,
		provider: string,
	): Promise<void> {
		try {
			const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
			const code = url.searchParams.get("code");
			const stateParam = url.searchParams.get("state");
			const error = url.searchParams.get("error");

			if (error) {
				renderOAuthCallbackPage(
					res,
					false,
					url.searchParams.get("error_description") ?? error,
				);
				return;
			}

			if (!code || !stateParam) {
				renderOAuthCallbackPage(res, false, "Missing code or state");
				return;
			}

			const tokens = await exchangeCodeForToken(provider, code, stateParam);

			const loader = new ConfigLoader();
			const config = loader.load();
			const configObj = config as unknown as Record<string, unknown>;
			const providerConfig = (configObj.ai as Record<string, unknown>)
				.providers as Record<string, unknown>;
			const prov = (providerConfig[provider] as Record<string, unknown>) ?? {};

			prov.oauthAccessToken = tokens.access_token;
			if (tokens.refresh_token) prov.oauthRefreshToken = tokens.refresh_token;
			prov.oauthExpiresAt = Date.now() + tokens.expires_in * 1000;
			prov.authMode = "oauth";

			providerConfig[provider] = prov;
			loader.save(config);

			if (this.system?.router) {
				await this.system.router.reconfigure(config.ai);
			}

			renderOAuthCallbackPage(res, true);
		} catch (err) {
			renderOAuthCallbackPage(
				res,
				false,
				err instanceof Error ? err.message : "Unknown error",
			);
		}
	}

	private async handleGoogleVertexSetup(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			const body = await readBody(req);
			let parsed: {
				projectId?: string;
				projectName?: string;
				billingAccountName?: string;
				location?: string;
			};
			try {
				parsed = body.trim() ? JSON.parse(body) : {};
			} catch {
				jsonRes(res, 400, { error: "Invalid JSON body" });
				return;
			}

			const loader = new ConfigLoader();
			const config = loader.load();
			const configObj = config as unknown as Record<string, unknown>;
			const providerConfig = (configObj.ai as Record<string, unknown>)
				.providers as Record<string, unknown>;
			const prov = (providerConfig.vertex as Record<string, unknown>) ?? {};

			let accessToken =
				typeof prov.oauthAccessToken === "string"
					? prov.oauthAccessToken.trim()
					: "";
			const refreshToken = prov.oauthRefreshToken as string | undefined;
			const clientId = prov.oauthClientId as string | undefined;
			const clientSecret = prov.oauthClientSecret as string | undefined;
			const expiresAt = prov.oauthExpiresAt as number | undefined;

			if (accessToken && expiresAt && Date.now() > expiresAt - 60_000) {
				if (!refreshToken || !clientId) {
					jsonRes(res, 400, {
						error:
							"El token OAuth de Google expiro. Vuelve a iniciar sesion en OAuth antes de preparar Vertex.",
					});
					return;
				}
				const tokens = await refreshAccessToken(
					"google",
					refreshToken,
					clientId,
					clientSecret,
				);
				accessToken = tokens.access_token;
				prov.oauthAccessToken = tokens.access_token;
				if (tokens.refresh_token) prov.oauthRefreshToken = tokens.refresh_token;
				prov.oauthExpiresAt = Date.now() + tokens.expires_in * 1000;
			}

			if (!accessToken) {
				jsonRes(res, 400, {
					error:
						"Primero inicia sesion con Google OAuth para conceder cloud-platform y facturacion.",
				});
				return;
			}

			const result = await prepareVertexProject({
				accessToken,
				projectId: parsed.projectId,
				projectName: parsed.projectName,
				billingAccountName: parsed.billingAccountName,
			});

			prov.projectId = result.projectId;
			prov.location = parsed.location?.trim() || prov.location || "us-central1";

			// Prefer a self-contained service-account JSON key (stable, no
			// dependency on the user's OAuth token refresh) when one was created.
			// Save it under ~/.octopus/credentials and point the provider at it.
			let credentialsFilePath: string | undefined;
			if (result.serviceAccountKey) {
				const credsDir = join(homedir(), ".octopus", "credentials");
				if (!existsSync(credsDir)) mkdirSync(credsDir, { recursive: true });
				credentialsFilePath = join(credsDir, "google-service-account.json");
				writeFileSync(credentialsFilePath, result.serviceAccountKey, {
					encoding: "utf-8",
					mode: 0o600,
				});
				prov.credentialsFile = credentialsFilePath;
				prov.credentialsJson = undefined;
				// Drop the user OAuth token so the provider uses the SA JWT path.
				prov.oauthAccessToken = undefined;
				prov.accessToken = undefined;
			} else {
				// Fallback: no service account key — use the user OAuth token.
				prov.oauthAccessToken = accessToken;
			}
			providerConfig.vertex = prov;
			const embeddings = config.memory.embeddings;
			if (
				embeddings.provider === "google" &&
				embeddings.authMode === "vertex"
			) {
				embeddings.projectId = String(prov.projectId ?? "");
				embeddings.location = String(prov.location ?? "global");
				embeddings.credentialsFile = String(prov.credentialsFile ?? "");
				embeddings.credentialsJson = "";
			}
			loader.save(config);

			if (this.system?.router) {
				await this.system.router.reconfigure(config.ai);
			}
			await this.system?.refreshEmbeddingProvider?.(config);

			// Never echo the raw key JSON back to the client.
			const { serviceAccountKey: _omitted, ...safeResult } = result;
			jsonRes(res, 200, {
				...safeResult,
				credentialsFile: credentialsFilePath,
			});
		} catch (err) {
			jsonRes(res, 500, {
				error:
					err instanceof Error ? err.message : "Google Vertex setup failed",
			});
		}
	}

	private handleGcloudLoginStart(res: ServerResponse): void {
		try {
			const result = spawnGcloudLogin();
			jsonRes(res, result.ok ? 200 : 400, result);
		} catch (err) {
			jsonRes(res, 500, {
				ok: false,
				error:
					err instanceof Error
						? err.message
						: "No se pudo iniciar el login de gcloud",
			});
		}
	}

	private handleGcloudLoginStatus(res: ServerResponse): void {
		jsonRes(res, 200, {
			...getGcloudLoginStatus(),
			gcloudInstalled: findGcloudBinary() !== undefined,
			adcPresent: readAdcCredentials() !== null,
		});
	}

	/**
	 * One-click Google Cloud connect via gcloud ADC. Probes gcloud + ADC,
	 * exchanges the ADC refresh token for a cloud-platform access token, runs
	 * prepareVertexProject with all defaults, then writes back the resulting
	 * service-account key (runtime becomes self-contained via SA JWT — the
	 * OAuth/ADC tokens are dropped so they never short-circuit SA JWT).
	 */
	private async handleGoogleConnect(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			const gcloudBin = findGcloudBinary();
			const creds = readAdcCredentials();
			if (!gcloudBin && !creds) {
				jsonRes(res, 200, {
					ok: false,
					code: "gcloud-missing",
					installUrl: "https://cloud.google.com/sdk/docs/install",
					error:
						"No se encontró gcloud CLI ni credenciales ADC. Instala gcloud y reinicia Octopus AI.",
				});
				return;
			}

			// Prefer `gcloud auth print-access-token` (reliable — Google blocks
			// third-party ADC refresh); fall back to a manual ADC refresh.
			let accessToken: string | undefined;
			let resolveError: unknown;
			try {
				accessToken = (await resolveGcloudAccessToken()).accessToken;
			} catch (err) {
				resolveError = err;
			}
			if (!accessToken) {
				const msg =
					resolveError instanceof Error
						? resolveError.message
						: "No se pudo obtener el token de acceso de Google";
				// No ADC to fall back on -> user must log in (gcloud auth login).
				if (!creds) {
					jsonRes(res, 200, {
						ok: false,
						code: "needs-login",
						error: `Ejecuta "gcloud auth login" y vuelve a intentar. ${msg}`,
					});
					return;
				}
				jsonRes(res, 200, {
					ok: false,
					code: "token-exchange-failed",
					error: msg,
				});
				return;
			}

			// Optional overrides from the body. `projectId` lets the user reuse an
			// EXISTING project that already has billing (e.g. on their Workspace
			// account) instead of minting a new one.
			let requestedLocation: string | undefined;
			let requestedProjectId: string | undefined;
			try {
				const body = await readBody(req);
				if (body.trim()) {
					const parsed = JSON.parse(body) as {
						location?: string;
						projectId?: string;
					};
					requestedLocation = parsed.location?.trim() || undefined;
					requestedProjectId = parsed.projectId?.trim() || undefined;
				}
			} catch {
				// Body is optional; ignore parse failures.
			}

			const loader = new ConfigLoader();
			const config = loader.load();
			const configObj = config as unknown as Record<string, unknown>;
			const providerConfig = (configObj.ai as Record<string, unknown>)
				.providers as Record<string, unknown>;
			const prov = (providerConfig.vertex as Record<string, unknown>) ?? {};

			const result = await prepareVertexProject({
				accessToken,
				projectId: requestedProjectId,
			});

			prov.projectId = result.projectId;
			// Force "global" on (re)connect — Gemini on Vertex requires the global
			// location, and a stale "us-central1" from an older session must not win.
			prov.location = requestedLocation || "global";

			let credentialsFilePath: string | undefined;
			if (result.serviceAccountKey) {
				const credsDir = join(homedir(), ".octopus", "credentials");
				if (!existsSync(credsDir)) mkdirSync(credsDir, { recursive: true });
				credentialsFilePath = join(credsDir, "google-service-account.json");
				writeFileSync(credentialsFilePath, result.serviceAccountKey, {
					encoding: "utf-8",
					mode: 0o600,
				});
				prov.credentialsFile = credentialsFilePath;
				prov.credentialsJson = undefined;
				// CRITICAL: clear OAuth/ADC access tokens so the provider uses the
				// self-refreshing SA JWT path instead of a dying OAuth token.
				prov.oauthAccessToken = undefined;
				prov.accessToken = undefined;
			}
			providerConfig.vertex = prov;
			const embeddings = config.memory.embeddings;
			if (
				embeddings.provider === "google" &&
				embeddings.authMode === "vertex"
			) {
				embeddings.projectId = String(prov.projectId ?? "");
				embeddings.location = String(prov.location ?? "global");
				embeddings.credentialsFile = String(prov.credentialsFile ?? "");
				embeddings.credentialsJson = "";
			}
			loader.save(config);

			if (this.system?.router) {
				await this.system.router.reconfigure(config.ai);
			}
			await this.system?.refreshEmbeddingProvider?.(config);

			resetGcloudLoginSession();

			// Never echo the raw key JSON back to the client.
			const { serviceAccountKey: _omitted, ...safeResult } = result;
			const billingLinked = Boolean(result.linkedBillingAccount);
			jsonRes(res, 200, {
				ok: true,
				...safeResult,
				credentialsFile: credentialsFilePath,
				account: getActiveGcloudAccount() ?? creds?.account,
				billingLinked,
				code: billingLinked ? undefined : "billing-warning",
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const code = /billing/i.test(msg)
				? "billing-error"
				: /permission|forbidden|403/i.test(msg)
					? "permission-denied"
					: /quota/i.test(msg)
						? "quota-exceeded"
						: "unknown";
			jsonRes(res, 500, { ok: false, code, error: msg });
		}
	}

	/**
	 * Validate a provider credential (API key or access token) WITHOUT persisting
	 * it. The frontend calls this at "Conectar" time; it persists via PUT /api/config
	 * only if verification succeeds.
	 */
	private async handleProviderTest(
		req: IncomingMessage,
		res: ServerResponse,
		provider: string,
	): Promise<void> {
		try {
			const registry = getProviderRegistry();
			if (!registry[provider]) {
				jsonRes(res, 404, { ok: false, error: "Proveedor desconocido" });
				return;
			}
			if (provider === "local") {
				jsonRes(res, 200, { ok: true });
				return;
			}
			if (provider === "vertex") {
				jsonRes(res, 400, {
					ok: false,
					error:
						"Vertex se valida al conectar con Google Cloud, no por API key.",
				});
				return;
			}

			let parsed: { apiKey?: string; accessToken?: string } = {};
			try {
				const body = await readBody(req);
				parsed = body.trim() ? JSON.parse(body) : {};
			} catch {
				// empty/invalid body — validate whatever is already saved
			}

			const loader = new ConfigLoader();
			const config = loader.load();
			const providers = config.ai.providers as unknown as Record<
				string,
				Record<string, unknown>
			>;
			const saved = providers[provider] ?? {};
			const merged: Record<string, unknown> = { ...saved };
			if (typeof parsed.apiKey === "string" && parsed.apiKey.trim()) {
				merged.apiKey = parsed.apiKey.trim();
			}
			if (typeof parsed.accessToken === "string" && parsed.accessToken.trim()) {
				merged.accessToken = parsed.accessToken.trim();
			}
			// Resolve env+defaults exactly like the router, then instantiate ad-hoc.
			const resolved = resolveProviderConfig(
				provider,
				merged as ProviderConfig,
			);
			const prov = registry[provider].factory(resolved);
			const result = await prov.verifyKey();
			jsonRes(res, 200, result);
		} catch (err) {
			jsonRes(res, 500, {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Wipe ALL credentials for a provider and reconfigure the router. For vertex
	 * also deletes the canonical on-disk service-account key (a user-supplied
	 * manual credentialsFile is left untouched).
	 */
	private async handleProviderDisconnect(
		_req: IncomingMessage,
		res: ServerResponse,
		provider: string,
	): Promise<void> {
		try {
			const registry = getProviderRegistry();
			if (!registry[provider]) {
				jsonRes(res, 404, { ok: false, error: "Proveedor desconocido" });
				return;
			}
			if (provider === "local") {
				jsonRes(res, 200, { ok: true });
				return;
			}

			const loader = new ConfigLoader();
			const config = loader.load();
			const providers = config.ai.providers as unknown as Record<
				string,
				Record<string, unknown>
			>;
			const prov = providers[provider] ?? {};

			if (provider === "vertex") {
				const canonical = join(
					homedir(),
					".octopus",
					"credentials",
					"google-service-account.json",
				);
				if (
					typeof prov.credentialsFile === "string" &&
					resolve(prov.credentialsFile) === resolve(canonical) &&
					existsSync(canonical)
				) {
					try {
						unlinkSync(canonical);
					} catch {
						// best-effort
					}
				}
				try {
					resetGcloudLoginSession();
				} catch {
					// best-effort
				}
			}

			clearProviderCredentials(prov, provider);
			providers[provider] = prov;
			loader.save(config);
			// Update the in-memory config so /api/config reflects the disconnect
			// immediately (not just the file on disk).
			if (this.system) this.system.config = config;

			if (this.system?.router) {
				await this.system.router.reconfigure(config.ai);
			}
			jsonRes(res, 200, { ok: true });
		} catch (err) {
			jsonRes(res, 500, {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleBrowserAuthStart(
		req: IncomingMessage,
		res: ServerResponse,
		provider: string,
	): Promise<void> {
		try {
			// OpenAI uses the Codex OAuth loopback flow (opens the user's default
			// browser) instead of the controlled-Chromium interception flow.
			if (provider === "openai") {
				const result = await startCodexLogin();
				jsonRes(res, result.ok ? 200 : 400, result);
				return;
			}
			const result = await startBrowserAuth(provider);
			jsonRes(res, result.ok ? 200 : 400, result);
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : "Browser auth failed",
			});
		}
	}

	private handleBrowserAuthStatus(
		_req: IncomingMessage,
		res: ServerResponse,
		provider: string,
	): void {
		if (provider === "openai") {
			jsonRes(res, 200, getCodexStatus());
			return;
		}
		const status = getAuthStatus(provider);
		jsonRes(res, 200, status);
	}

	private async handleBrowserAuthResult(
		req: IncomingMessage,
		res: ServerResponse,
		provider: string,
	): Promise<void> {
		try {
			// OpenAI Codex OAuth loopback result. Prefer the API key from the
			// token-exchange (works against api.openai.com/v1); fall back to the
			// OAuth access_token for accounts where the exchange fails (e.g. no
			// organization).
			if (provider === "openai") {
				const codex = getCodexResult();
				if (!codex || (!codex.apiKey && !codex.accessToken)) {
					jsonRes(res, 400, { error: "No auth result available" });
					return;
				}
				const loader = new ConfigLoader();
				const config = loader.load();
				const configObj = config as unknown as Record<string, unknown>;
				const providerConfig = (configObj.ai as Record<string, unknown>)
					.providers as Record<string, unknown>;
				const prov = (providerConfig.openai as Record<string, unknown>) ?? {};
				if (codex.apiKey) {
					prov.apiKey = codex.apiKey;
					prov.authMode = "api-key";
					prov.accessToken = undefined;
				} else {
					prov.accessToken = codex.accessToken;
					prov.authMode = "codex";
					prov.apiKey = ""; // apiKey is a required string in the schema
					if (codex.refreshToken) prov.oauthRefreshToken = codex.refreshToken;
				}
				// chatgpt_account_id needed by the Codex backend (Responses/images).
				if (codex.accountId) prov.accountId = codex.accountId;
				// Clear stale credentials from the old browser-interception flow.
				prov.browserCookies = undefined;
				prov.browserUserAgent = undefined;
				providerConfig.openai = prov;
				loader.save(config);
				if (this.system?.router) {
					await this.system.router.reconfigure(config.ai);
				}
				jsonRes(res, 200, { success: true, hasToken: true });
				return;
			}

			const result = getAuthResult(provider);
			if (!result || !result.success) {
				jsonRes(res, 400, {
					error: result?.error ?? "No auth result available",
				});
				return;
			}

			const loader = new ConfigLoader();
			const config = loader.load();
			const configObj = config as unknown as Record<string, unknown>;
			const providerConfig = (configObj.ai as Record<string, unknown>)
				.providers as Record<string, unknown>;
			const prov = (providerConfig[provider] as Record<string, unknown>) ?? {};

			if (result.interceptedToken) {
				prov.accessToken = result.interceptedToken.replace(/^Bearer\s+/i, "");
			}
			if (result.cookies.length > 0) {
				prov.browserCookies = JSON.stringify(result.cookies);
			}
			if (result.userAgent) {
				prov.browserUserAgent = result.userAgent;
			}
			prov.authMode =
				provider === "openai" && result.interceptedToken ? "codex" : "browser";
			providerConfig[provider] = prov;
			loader.save(config);

			if (this.system?.router) {
				await this.system.router.reconfigure(config.ai);
			}

			jsonRes(res, 200, {
				success: true,
				cookieCount: result.cookies.length,
				hasToken: Boolean(result.interceptedToken),
				hasCookies: result.cookies.length > 0,
			});
		} catch (err) {
			jsonRes(res, 500, {
				error:
					err instanceof Error ? err.message : "Failed to save browser auth",
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

			const nextConfig = configObj as unknown as OctopusConfig;
			const changesEmbeddings =
				keyPath === "memory.embeddings" ||
				keyPath.startsWith("memory.embeddings.");
			if (changesEmbeddings) {
				try {
					await this.system?.refreshEmbeddingProvider?.(nextConfig);
				} catch (err) {
					jsonRes(res, 400, {
						error: err instanceof Error ? err.message : String(err),
						applied: false,
					});
					return;
				}
			}

			loader.save(nextConfig);

			if (this.system) {
				this.system.config = nextConfig;
				if (keyPath === "ai" || keyPath.startsWith("ai.")) {
					await this.system.router?.reconfigure({
						default: nextConfig.ai.default,
						fallback: nextConfig.ai.fallback,
						providers: nextConfig.ai.providers,
						thinking: nextConfig.ai.thinking,
					});
				}
				if (keyPath === "browser" || keyPath.startsWith("browser.")) {
					await this.system.refreshBrowserTools?.(this.system.config);
				}
				if (keyPath === "tools" || keyPath.startsWith("tools.iterationLimit")) {
					this.system.agentRuntime?.setToolIterationLimit?.(
						this.system.config.tools.iterationLimit,
					);
				}
				if (
					keyPath === "tools" ||
					keyPath.startsWith("tools.timeouts") ||
					keyPath.startsWith("tools.rateLimits")
				) {
					this.system.toolExecutor?.updateConfig?.({
						timeouts: this.system.config.tools.timeouts,
						rateLimits: this.system.config.tools.rateLimits,
					});
				}
				if (keyPath === "learning" || keyPath.startsWith("learning.")) {
					this.system.learningEngine?.updateConfig?.({
						...this.system.config.learning,
						autoCreateSkills:
							this.system.config.learning.autoCreateSkills &&
							this.system.config.skills.autoCreate,
					});
				}
				if (keyPath === "skills" || keyPath.startsWith("skills.")) {
					this.system.skillLoader?.updateConfig?.({
						enabled: this.system.config.skills.enabled,
						...this.system.config.skills.loading,
					});
					this.system.skillImprover?.updateConfig?.({
						enabled: this.system.config.skills.autoImprove,
						...this.system.config.skills.improvement,
					});
					this.system.learningEngine?.updateConfig?.({
						...this.system.config.learning,
						autoCreateSkills:
							this.system.config.learning.autoCreateSkills &&
							this.system.config.skills.autoCreate,
					});
				}
			}

			jsonRes(res, 200, { ok: true, key: keyPath, applied: changesEmbeddings });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleApplyEmbeddingConfig(res: ServerResponse): Promise<void> {
		try {
			if (!this.system?.refreshEmbeddingProvider) {
				jsonRes(res, 501, {
					error: "Embedding provider refresh is not available in this runtime",
				});
				return;
			}
			const loader = new ConfigLoader();
			const config = loader.load();
			this.system.config = config;
			await this.system.refreshEmbeddingProvider(config);
			jsonRes(res, 200, {
				ok: true,
				message: "Embedding provider applied without restart",
			});
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleMemoryStats(res: ServerResponse): Promise<void> {
		try {
			const config = this.loadConfig();
			const stm = this.system?.agentRuntime?.stm;
			const ltmCount = this.system?.ltm?.count
				? await this.system.ltm.count().catch(() => 0)
				: 0;
			const dailyCount = this.system?.dailyMemory?.getMessageCount
				? await this.system.dailyMemory.getMessageCount().catch(() => 0)
				: 0;
			const advanced = await this.getAdvancedMemoryStats();
			const profile = this.system?.userProfileManager?.getProfile
				? await this.system.userProfileManager
						.getProfile("owner")
						.catch(() => null)
				: null;
			jsonRes(res, 200, {
				enabled: config.memory.enabled,
				shortTerm: {
					...config.memory.shortTerm,
					count: stm?.getContext?.().length ?? 0,
					load: stm?.getLoad?.() ?? 0,
					tokens: stm?.getTokenCount?.() ?? 0,
					condensedCount: stm?.getCondensedHistory?.().length ?? 0,
				},
				longTerm: { ...config.memory.longTerm, count: ltmCount },
				consolidation: config.memory.consolidation,
				retrieval: config.memory.retrieval,
				daily: { rawMessageCount: dailyCount },
				advanced,
				profile: {
					exists: Boolean(profile),
					conversationCount: profile?.conversationCount ?? 0,
				},
			});
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async getAdvancedMemoryStats(): Promise<Record<string, number>> {
		const db = this.system?.db;
		if (!db?.get) return {};
		const tables = [
			"memory_sources",
			"memory_nodes",
			"memory_relations",
			"memory_permissions",
			"memory_action_logs",
			"memory_audit_logs",
			"memory_usage",
		];
		const stats: Record<string, number> = {};
		for (const table of tables) {
			const row = (await db
				.get(`SELECT COUNT(*) as count FROM ${table}`)
				.catch(() => ({ count: 0 }))) as { count?: number } | undefined;
			stats[table] = row?.count ?? 0;
		}
		stats.memory_requires_confirmation = await this.countMemoryRows(
			"SELECT COUNT(*) as count FROM memory_permissions WHERE requires_user_confirmation_before_use = 1",
		);
		stats.memory_contradictions =
			(await this.countMemoryRows(
				"SELECT COUNT(*) as count FROM memory_edges WHERE type = 'contradicts'",
			)) +
			(await this.countMemoryRows(
				"SELECT COUNT(*) as count FROM memory_relations WHERE edge_type = 'contradicts'",
			));

		const sensitivityRows = await this.queryMemoryRows<{
			sensitivity: string;
			count: number;
		}>(
			"SELECT sensitivity, COUNT(*) as count FROM memory_permissions GROUP BY sensitivity",
		);
		for (const row of sensitivityRows) {
			stats[`memory_sensitivity_${this.safeMetricKey(row.sensitivity)}`] =
				Number(row.count ?? 0);
		}

		const feedbackRows = await this.queryMemoryRows<{
			feedback_type: string;
			count: number;
		}>(
			"SELECT feedback_type, COUNT(*) as count FROM memory_usage WHERE feedback_type != 'none' GROUP BY feedback_type",
		);
		for (const row of feedbackRows) {
			const count = Number(row.count ?? 0);
			stats.memory_feedback_total = (stats.memory_feedback_total ?? 0) + count;
			stats[`memory_feedback_${this.safeMetricKey(row.feedback_type)}`] = count;
		}
		stats.memory_feedback_total ??= 0;

		const actionRows = await this.queryMemoryRows<{
			action_type: string;
			output: string;
		}>(
			`SELECT action_type, output FROM memory_action_logs
				WHERE action_type IN ('memory.read', 'memory.access_denied')
				ORDER BY created_at DESC LIMIT 5000`,
		);
		const retrievalDurations: number[] = [];
		for (const row of actionRows) {
			const output = parseStoredJsonObject(row.output);
			if (row.action_type === "memory.read") {
				stats.memory_retrieval_count = (stats.memory_retrieval_count ?? 0) + 1;
				stats.memory_redacted_total =
					(stats.memory_redacted_total ?? 0) +
					this.metricNumber(output.redactedCount);
				const durationMs = this.metricNumber(output.durationMs);
				if (durationMs > 0) retrievalDurations.push(durationMs);
			}
			if (row.action_type === "memory.access_denied") {
				stats.memory_access_denied_total =
					(stats.memory_access_denied_total ?? 0) +
					this.metricNumber(output.deniedCount);
				stats.memory_sensitive_access_denied_total =
					(stats.memory_sensitive_access_denied_total ?? 0) +
					this.metricNumber(output.sensitiveDeniedCount);
				stats.memory_confirmation_denied_total =
					(stats.memory_confirmation_denied_total ?? 0) +
					this.metricNumber(output.confirmationDeniedCount);
			}
		}
		stats.memory_retrieval_count ??= 0;
		stats.memory_redacted_total ??= 0;
		stats.memory_access_denied_total ??= 0;
		stats.memory_sensitive_access_denied_total ??= 0;
		stats.memory_confirmation_denied_total ??= 0;
		if (retrievalDurations.length > 0) {
			stats.memory_retrieval_latency_avg_ms = Math.round(
				retrievalDurations.reduce((sum, value) => sum + value, 0) /
					retrievalDurations.length,
			);
			stats.memory_retrieval_latency_max_ms = Math.max(...retrievalDurations);
		}
		return stats;
	}

	private async countMemoryRows(sql: string): Promise<number> {
		const db = this.system?.db;
		if (!db?.get) return 0;
		const row = (await db.get(sql).catch(() => ({ count: 0 }))) as
			| { count?: number }
			| undefined;
		return Number(row?.count ?? 0);
	}

	private async queryMemoryRows<T>(sql: string): Promise<T[]> {
		const db = this.system?.db;
		if (!db?.all) return [];
		return (await db.all(sql).catch(() => [])) as T[];
	}

	private safeMetricKey(value: string): string {
		return value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_|_$/g, "");
	}

	private metricNumber(value: unknown): number {
		return typeof value === "number" && Number.isFinite(value) ? value : 0;
	}

	private memoryContextFromParams(params: URLSearchParams): MemoryReadContext {
		return {
			tenantId: params.get("tenantId") ?? "local",
			userId: params.get("userId") ?? "owner",
			projectId: params.get("projectId") ?? process.cwd(),
			agentRole: params.get("agentRole") ?? params.get("agentId") ?? undefined,
			includeSources: params.get("includeSources") === "true",
			includeGraph: params.get("includeGraph") === "true",
			userConfirmed: params.get("userConfirmed") === "true",
			trackUsage: false,
		};
	}

	private memoryContextFromBody(
		body: Record<string, unknown>,
	): MemoryReadContext {
		return {
			tenantId: typeof body.tenantId === "string" ? body.tenantId : "local",
			userId: typeof body.userId === "string" ? body.userId : "owner",
			projectId:
				typeof body.projectId === "string" ? body.projectId : process.cwd(),
			agentRole:
				typeof body.agentRole === "string"
					? body.agentRole
					: typeof body.agentId === "string"
						? body.agentId
						: undefined,
			includeSources: body.includeSources === true,
			includeGraph: body.includeGraph === true,
			userConfirmed: body.userConfirmed === true,
			trackUsage: false,
		};
	}

	private memoryGraphOptionsFromParams(
		params: URLSearchParams,
	): MemoryGraphTraversalOptions {
		return {
			maxDepth: this.optionalNumber(params.get("maxDepth")),
			maxNodes: this.optionalNumber(params.get("maxNodes")),
			relationTypes: this.parseRelationTypes(params.get("relationTypes")),
		};
	}

	private memoryGraphOptionsFromBody(
		body: Record<string, unknown>,
	): MemoryGraphTraversalOptions {
		return {
			maxDepth: typeof body.maxDepth === "number" ? body.maxDepth : undefined,
			maxNodes: typeof body.maxNodes === "number" ? body.maxNodes : undefined,
			relationTypes: this.parseRelationTypes(body.relationTypes),
		};
	}

	private optionalNumber(value: string | null): number | undefined {
		if (value === null || value.trim() === "") return undefined;
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	private parseRelationTypes(value: unknown): MemoryRelationType[] | undefined {
		const raw = Array.isArray(value)
			? value
			: typeof value === "string"
				? value.split(",")
				: [];
		const relationTypes = raw
			.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
			.filter((entry): entry is MemoryRelationType =>
				MEMORY_RELATION_TYPES.has(entry as MemoryRelationType),
			);
		return relationTypes.length > 0 ? relationTypes : undefined;
	}

	private async filterReadableMemoryIds(
		memoryIds: string[],
		context: MemoryReadContext,
	): Promise<string[]> {
		return this.system?.memoryOrchestrator?.filterReadableMemoryIds
			? await this.system.memoryOrchestrator.filterReadableMemoryIds(
					memoryIds,
					context,
				)
			: [];
	}

	private sanitizeAuditEntries(audit: MemoryAuditEntry[]): MemoryAuditEntry[] {
		return audit.map((entry) => ({
			...entry,
			before: this.sanitizeAuditSnapshot(entry.before),
			after: this.sanitizeAuditSnapshot(entry.after),
		}));
	}

	private sanitizeAuditSnapshot(
		snapshot: Record<string, unknown> | undefined,
	): Record<string, unknown> | undefined {
		if (!snapshot) return undefined;
		return {
			id: snapshot.id,
			type: snapshot.type,
			confidence: snapshot.confidence,
			status: snapshot.status,
			redacted: true,
		};
	}

	private sanitizeActionLogs(
		actions: MemoryActionLogEntry[],
	): MemoryActionLogEntry[] {
		return actions.map((entry) => ({
			...entry,
			input: this.sanitizeLogPayload(entry.input),
			output: this.sanitizeLogPayload(entry.output),
		}));
	}

	private sanitizeLogPayload(
		payload: Record<string, unknown>,
	): Record<string, unknown> {
		return {
			memoryId:
				typeof payload.memoryId === "string" ? payload.memoryId : undefined,
			type: typeof payload.type === "string" ? payload.type : undefined,
			status: typeof payload.status === "string" ? payload.status : undefined,
			redacted: Object.keys(payload).length > 0,
		};
	}

	private sanitizeMemoryPackForTransport<T>(
		pack: T,
		userConfirmed: boolean,
	): T {
		if (!isRecord(pack)) return pack;
		const sanitized: Record<string, unknown> = { ...pack };
		for (const key of [
			"memories",
			"userMemory",
			"projectMemory",
			"similarEpisodes",
			"agentLessons",
			"prospectiveReminders",
		]) {
			const value = sanitized[key];
			if (Array.isArray(value)) {
				sanitized[key] = value.map((entry) =>
					this.sanitizeScoredMemoryForTransport(entry, userConfirmed),
				);
			}
		}
		return sanitized as T;
	}

	private sanitizeScoredMemoryForTransport(
		entry: unknown,
		userConfirmed: boolean,
	): unknown {
		if (!isRecord(entry) || !isRecord(entry.item)) return entry;
		const item = entry.item;
		const metadata = isRecord(item.metadata) ? item.metadata : {};
		const permissions = isRecord(metadata.permissions)
			? metadata.permissions
			: {};
		const restricted =
			metadata.redacted === true ||
			metadata.sensitivity === "restricted" ||
			permissions.sensitivity === "restricted" ||
			permissions.requiresUserConfirmationBeforeUse === true;
		if (!restricted || userConfirmed) return entry;

		return {
			...entry,
			item: {
				id: typeof item.id === "string" ? item.id : undefined,
				type: typeof item.type === "string" ? item.type : undefined,
				content: "[Memory withheld: requires_user_confirmation_before_use]",
				importance:
					typeof item.importance === "number" ? item.importance : undefined,
				accessCount:
					typeof item.accessCount === "number" ? item.accessCount : undefined,
				createdAt: item.createdAt,
				lastAccessed: item.lastAccessed,
				associations: Array.isArray(item.associations) ? item.associations : [],
				source: this.sanitizeRestrictedMemorySource(item.source),
				metadata: this.sanitizeRestrictedMemoryMetadata(metadata),
			},
		};
	}

	private sanitizeRestrictedMemorySource(
		source: unknown,
	): Record<string, unknown> {
		if (!isRecord(source)) return {};
		return {
			sourceId:
				typeof source.sourceId === "string" ? source.sourceId : undefined,
			sourceType:
				typeof source.sourceType === "string" ? source.sourceType : undefined,
		};
	}

	private sanitizeRestrictedMemoryMetadata(
		metadata: Record<string, unknown>,
	): Record<string, unknown> {
		return {
			tenantId: metadata.tenantId,
			userId: metadata.userId,
			projectId: metadata.projectId,
			agentRole: metadata.agentRole,
			sourceTrust: metadata.sourceTrust,
			confidence: metadata.confidence,
			status: metadata.status,
			sensitivity: metadata.sensitivity ?? "restricted",
			permissions: metadata.permissions,
			redacted: true,
			redactionReason: "requires_user_confirmation_before_use",
		};
	}

	private handleMemoryConfigGet(res: ServerResponse): void {
		void this.handleMemoryStats(res);
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
			// biome-ignore lint/suspicious/noExplicitAny: memory orchestrator is injected by the CLI runtime.
			let memoryPack: any = null;
			if (this.system?.memoryOrchestrator?.read) {
				memoryPack = await this.system.memoryOrchestrator.read(
					query,
					{
						tenantId: "local",
						userId: "owner",
						projectId: process.cwd(),
						includeSources: true,
						includeGraph: true,
						userConfirmed: false,
						trackUsage: false,
					},
					2000,
				);
				memoryPack = this.sanitizeMemoryPackForTransport(memoryPack, false);
				results = memoryPack.memories ?? [];
			} else if (this.system?.ltm?.search && this.system.embedFn) {
				results = await this.system.ltm.search(query, this.system.embedFn);
			}
			jsonRes(res, 200, { query, results, memoryPack });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleMemoryContextRetrieve(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(await readBody(req)) as Record<string, unknown>;
			} catch {
				jsonRes(res, 400, { error: "Invalid JSON body" });
				return;
			}
			const goal = typeof body.goal === "string" ? body.goal : "";
			if (!goal.trim()) {
				jsonRes(res, 400, { error: "Missing 'goal'" });
				return;
			}
			const budgetTokens =
				typeof body.maxTokens === "number" ? body.maxTokens : 3000;
			const context = {
				tenantId: typeof body.tenantId === "string" ? body.tenantId : "local",
				userId: typeof body.userId === "string" ? body.userId : "owner",
				projectId:
					typeof body.projectId === "string" ? body.projectId : process.cwd(),
				agentRole: typeof body.agentId === "string" ? body.agentId : undefined,
				includeSources: body.includeSources !== false,
				includeGraph: body.includeGraph !== false,
				userConfirmed: body.userConfirmed === true,
				trackUsage: body.trackUsage === true,
			};
			if (this.system?.contextAssembler?.assemble) {
				const assembled = await this.system.contextAssembler.assemble({
					objective: goal,
					...context,
					budgetTokens,
				});
				const contextPack = this.sanitizeMemoryPackForTransport(
					assembled.memoryPack,
					context.userConfirmed,
				);
				jsonRes(res, 200, {
					goal,
					contextPack,
					assembled: { ...assembled, memoryPack: contextPack },
				});
				return;
			}
			if (this.system?.memoryOrchestrator?.read) {
				const contextPack = await this.system.memoryOrchestrator.read(
					goal,
					context,
					budgetTokens,
				);
				jsonRes(res, 200, {
					goal,
					contextPack: this.sanitizeMemoryPackForTransport(
						contextPack,
						context.userConfirmed,
					),
				});
				return;
			}
			jsonRes(res, 503, { error: "Advanced memory is not available" });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleKnowledgeApi(
		req: IncomingMessage,
		res: ServerResponse,
		url: URL,
		pathname: string,
	): Promise<void> {
		try {
			const manager = this.system?.knowledgeManager;
			if (!manager) {
				jsonRes(res, 503, { error: "Knowledge manager is not available" });
				return;
			}

			if (
				req.method === "GET" &&
				pathname === "/api/memory/knowledge/collections"
			) {
				jsonRes(res, 200, await manager.listCollections());
				return;
			}

			if (
				req.method === "POST" &&
				pathname === "/api/memory/knowledge/collections"
			) {
				const body = await this.readJsonBody(req, res);
				if (!body) return;
				jsonRes(
					res,
					201,
					await manager.createCollection({
						name: String(body.name ?? ""),
						description:
							typeof body.description === "string"
								? body.description
								: undefined,
						metadata: isRecord(body.metadata) ? body.metadata : undefined,
					}),
				);
				return;
			}

			if (
				req.method === "GET" &&
				/^\/api\/memory\/knowledge\/collections\/[^/]+$/.test(pathname)
			) {
				const id = pathname.split("/").pop() ?? "";
				const collection = await manager.getCollection(id);
				if (!collection) {
					jsonRes(res, 404, { error: "Knowledge collection not found" });
					return;
				}
				jsonRes(res, 200, {
					collection,
					items: await manager.listItems({ collectionId: id }),
				});
				return;
			}

			if (
				req.method === "DELETE" &&
				/^\/api\/memory\/knowledge\/collections\/[^/]+$/.test(pathname)
			) {
				await manager.deleteCollection(pathname.split("/").pop() ?? "");
				jsonRes(res, 200, { ok: true });
				return;
			}

			if (req.method === "GET" && pathname === "/api/memory/knowledge/items") {
				jsonRes(
					res,
					200,
					await manager.listItems({
						collectionId: url.searchParams.get("collectionId") ?? undefined,
					}),
				);
				return;
			}

			if (
				req.method === "POST" &&
				pathname === "/api/memory/knowledge/items/text"
			) {
				const body = await this.readJsonBody(req, res);
				if (!body) return;
				jsonRes(
					res,
					201,
					await manager.createTextItem({
						collectionId: String(body.collectionId ?? ""),
						title: typeof body.title === "string" ? body.title : undefined,
						content: String(body.content ?? ""),
						sourceUri:
							typeof body.sourceUri === "string" ? body.sourceUri : undefined,
						metadata: isRecord(body.metadata) ? body.metadata : undefined,
					}),
				);
				return;
			}

			if (
				req.method === "POST" &&
				pathname === "/api/memory/knowledge/items/media"
			) {
				const body = await this.readJsonBody(req, res);
				if (!body) return;
				jsonRes(
					res,
					201,
					await manager.createMediaItem({
						collectionId: String(body.collectionId ?? ""),
						mediaId:
							typeof body.mediaId === "string" ? body.mediaId : undefined,
						sourceUri: String(body.sourceUri ?? ""),
						title: typeof body.title === "string" ? body.title : undefined,
						modality:
							typeof body.modality === "string" ? body.modality : undefined,
						description:
							typeof body.description === "string"
								? body.description
								: undefined,
						metadata: isRecord(body.metadata) ? body.metadata : undefined,
					}),
				);
				return;
			}

			if (
				req.method === "POST" &&
				pathname === "/api/memory/knowledge/items/file"
			) {
				const body = await this.readJsonBody(req, res);
				if (!body) return;
				jsonRes(
					res,
					201,
					await manager.createFileItem({
						collectionId: String(body.collectionId ?? ""),
						filePath: String(body.filePath ?? ""),
						title: typeof body.title === "string" ? body.title : undefined,
						sourceUri:
							typeof body.sourceUri === "string" ? body.sourceUri : undefined,
						metadata: isRecord(body.metadata) ? body.metadata : undefined,
					}),
				);
				return;
			}

			if (req.method === "GET" && pathname === "/api/memory/knowledge/search") {
				jsonRes(
					res,
					200,
					await manager.searchChunks({
						query: url.searchParams.get("q") ?? "",
						collectionId: url.searchParams.get("collectionId") ?? undefined,
						limit: Number.parseInt(url.searchParams.get("limit") ?? "20"),
					}),
				);
				return;
			}

			if (
				req.method === "GET" &&
				/^\/api\/memory\/knowledge\/items\/[^/]+$/.test(pathname)
			) {
				const id = pathname.split("/").pop() ?? "";
				const item = await manager.getItem(id);
				if (!item) {
					jsonRes(res, 404, { error: "Knowledge item not found" });
					return;
				}
				jsonRes(res, 200, { item, chunks: await manager.listChunks(id) });
				return;
			}

			if (
				req.method === "DELETE" &&
				/^\/api\/memory\/knowledge\/items\/[^/]+$/.test(pathname)
			) {
				await manager.deleteItem(pathname.split("/").pop() ?? "");
				jsonRes(res, 200, { ok: true });
				return;
			}

			jsonRes(res, 404, { error: "Knowledge endpoint not found" });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async readJsonBody(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<Record<string, unknown> | null> {
		try {
			const raw = await readBody(req);
			const parsed = raw ? (JSON.parse(raw) as unknown) : {};
			if (!isRecord(parsed)) {
				jsonRes(res, 400, { error: "Invalid JSON body" });
				return null;
			}
			return parsed;
		} catch {
			jsonRes(res, 400, { error: "Invalid JSON body" });
			return null;
		}
	}

	private async handleMemoryCreate(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(await readBody(req)) as Record<string, unknown>;
			} catch {
				jsonRes(res, 400, { error: "Invalid JSON body" });
				return;
			}
			if (!this.system?.memoryOrchestrator?.write) {
				jsonRes(res, 503, { error: "Memory orchestrator is not available" });
				return;
			}
			const content =
				typeof body.content === "string" ? body.content.trim() : "";
			if (!content) {
				jsonRes(res, 400, { error: "Missing 'content'" });
				return;
			}
			const scopeBody = isRecord(body.scope) ? body.scope : {};
			const result = await this.system.memoryOrchestrator.write({
				type: normalizeMemoryType(body.memory_type ?? body.type),
				content,
				sourceTrust: normalizeMemorySourceTrust(body.sourceTrust),
				scope: {
					tenantId:
						typeof scopeBody.tenantId === "string"
							? scopeBody.tenantId
							: "local",
					userId:
						typeof scopeBody.userId === "string" ? scopeBody.userId : "owner",
					projectId:
						typeof scopeBody.projectId === "string"
							? scopeBody.projectId
							: process.cwd(),
					agentRole:
						typeof scopeBody.agentRole === "string"
							? scopeBody.agentRole
							: undefined,
					sessionId:
						typeof scopeBody.sessionId === "string"
							? scopeBody.sessionId
							: undefined,
					taskId:
						typeof scopeBody.taskId === "string" ? scopeBody.taskId : undefined,
				},
				confidence:
					typeof body.confidence === "number" ? body.confidence : undefined,
				importance:
					typeof body.importance === "number" ? body.importance : undefined,
				source: isRecord(body.source) ? body.source : undefined,
				permissions: isRecord(body.permissions) ? body.permissions : undefined,
				metadata: isRecord(body.metadata) ? body.metadata : undefined,
				evidence: isRecord(body.evidence) ? body.evidence : undefined,
			});
			jsonRes(res, result.accepted ? 200 : 400, {
				ok: result.accepted,
				result,
			});
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleMemoryFeedback(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(await readBody(req)) as Record<string, unknown>;
			} catch {
				jsonRes(res, 400, { error: "Invalid JSON body" });
				return;
			}
			if (!this.system?.memoryOrchestrator?.applyFeedback) {
				jsonRes(res, 503, { error: "Memory orchestrator is not available" });
				return;
			}
			const memoryId = typeof body.memoryId === "string" ? body.memoryId : "";
			const feedbackType =
				typeof body.feedbackType === "string" ? body.feedbackType : "";
			if (!memoryId || !feedbackType) {
				jsonRes(res, 400, { error: "Missing 'memoryId' or 'feedbackType'" });
				return;
			}
			if (
				!MEMORY_FEEDBACK_TYPES.has(
					feedbackType as Exclude<MemoryFeedbackType, "none">,
				)
			) {
				jsonRes(res, 400, { error: "Invalid 'feedbackType'" });
				return;
			}
			const result = await this.system.memoryOrchestrator.applyFeedback({
				memoryId,
				feedbackType: feedbackType as Exclude<MemoryFeedbackType, "none">,
				sessionId:
					typeof body.sessionId === "string" ? body.sessionId : undefined,
				taskId: typeof body.taskId === "string" ? body.taskId : undefined,
				agentRole:
					typeof body.agentRole === "string" ? body.agentRole : undefined,
				outcome: typeof body.outcome === "string" ? body.outcome : undefined,
				correction:
					typeof body.correction === "string" ? body.correction : undefined,
				changedBy:
					body.changedBy === "system" ||
					body.changedBy === "agent" ||
					body.changedBy === "user"
						? body.changedBy
						: "user",
			});
			jsonRes(res, result ? 200 : 404, { ok: Boolean(result), result });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleMemoryForget(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(await readBody(req)) as Record<string, unknown>;
			} catch {
				jsonRes(res, 400, { error: "Invalid JSON body" });
				return;
			}
			if (!this.system?.memoryOrchestrator?.forget) {
				jsonRes(res, 503, { error: "Memory orchestrator is not available" });
				return;
			}
			const memoryId = typeof body.memoryId === "string" ? body.memoryId : "";
			if (!memoryId) {
				jsonRes(res, 400, { error: "Missing 'memoryId'" });
				return;
			}
			await this.system.memoryOrchestrator.forget(
				memoryId,
				typeof body.reason === "string" ? body.reason : "api_forget",
			);
			jsonRes(res, 200, { ok: true, memoryId });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleMemoryBackfill(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			let body: Record<string, unknown> = {};
			const raw = await readBody(req);
			if (raw.trim()) {
				try {
					body = JSON.parse(raw) as Record<string, unknown>;
				} catch {
					jsonRes(res, 400, { error: "Invalid JSON body" });
					return;
				}
			}
			if (!this.system?.memoryOrchestrator?.backfillAdvancedMemory) {
				jsonRes(res, 503, { error: "Memory orchestrator is not available" });
				return;
			}
			const limit = typeof body.limit === "number" ? body.limit : 1000;
			const report =
				await this.system.memoryOrchestrator.backfillAdvancedMemory(limit);
			jsonRes(res, 200, { ok: true, report });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleMemoryRetentionRun(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			const body = await this.readOptionalJsonBody(req, res);
			if (!body) return;
			if (!this.system?.memoryOrchestrator?.runActiveForgetting) {
				jsonRes(res, 503, { error: "Memory orchestrator is not available" });
				return;
			}
			const now = typeof body.now === "string" ? new Date(body.now) : undefined;
			if (now && Number.isNaN(now.getTime())) {
				jsonRes(res, 400, { error: "Invalid 'now' timestamp" });
				return;
			}
			const options: ActiveForgettingOptions = {
				now,
				unusedDays:
					typeof body.unusedDays === "number" ? body.unusedDays : undefined,
				lowImportanceThreshold:
					typeof body.lowImportanceThreshold === "number"
						? body.lowImportanceThreshold
						: undefined,
				contradictionGraceDays:
					typeof body.contradictionGraceDays === "number"
						? body.contradictionGraceDays
						: undefined,
			};
			const report =
				await this.system.memoryOrchestrator.runActiveForgetting(options);
			jsonRes(res, 200, { ok: true, report });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async readOptionalJsonBody(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<Record<string, unknown> | undefined> {
		const raw = await readBody(req);
		if (!raw.trim()) return {};
		try {
			return JSON.parse(raw) as Record<string, unknown>;
		} catch {
			jsonRes(res, 400, { error: "Invalid JSON body" });
			return undefined;
		}
	}

	private async handleMemorySources(
		res: ServerResponse,
		params: URLSearchParams,
	): Promise<void> {
		const memoryId = params.get("id") ?? "";
		if (!memoryId) {
			jsonRes(res, 400, { error: "Missing memory id" });
			return;
		}
		try {
			if (!this.system?.memoryOrchestrator?.getSources) {
				jsonRes(res, 503, { error: "Memory orchestrator is not available" });
				return;
			}
			const readable = await this.filterReadableMemoryIds(
				[memoryId],
				this.memoryContextFromParams(params),
			);
			if (readable.length === 0) {
				jsonRes(res, 403, { error: "Memory is not accessible" });
				return;
			}
			const sources = await this.system.memoryOrchestrator.getSources(memoryId);
			jsonRes(res, 200, { memoryId, sources });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleMemoryGraph(
		res: ServerResponse,
		params: URLSearchParams,
	): Promise<void> {
		const entityName = params.get("entity")?.trim();
		if (entityName) {
			try {
				if (!this.system?.memoryOrchestrator?.getGraphByEntity) {
					jsonRes(res, 503, { error: "Memory orchestrator is not available" });
					return;
				}
				const graph = await this.system.memoryOrchestrator.getGraphByEntity(
					entityName,
					this.memoryContextFromParams(params),
					this.memoryGraphOptionsFromParams(params),
				);
				jsonRes(res, 200, { entity: entityName, graph });
			} catch (err) {
				jsonRes(res, 500, {
					error: err instanceof Error ? err.message : String(err),
				});
			}
			return;
		}

		const memoryIds = parseMemoryIds(params);
		if (memoryIds.length === 0) {
			jsonRes(res, 400, { error: "Missing memory id(s)" });
			return;
		}
		try {
			if (!this.system?.memoryOrchestrator?.getGraph) {
				jsonRes(res, 503, { error: "Memory orchestrator is not available" });
				return;
			}
			const readable = await this.filterReadableMemoryIds(
				memoryIds,
				this.memoryContextFromParams(params),
			);
			if (readable.length === 0) {
				jsonRes(res, 403, { error: "No requested memories are accessible" });
				return;
			}
			const graph = await this.system.memoryOrchestrator.getGraph(readable);
			jsonRes(res, 200, { memoryIds: readable, graph });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleMemoryGraphTraverse(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(await readBody(req)) as Record<string, unknown>;
			} catch {
				jsonRes(res, 400, { error: "Invalid JSON body" });
				return;
			}
			if (!this.system?.memoryOrchestrator?.traverseGraph) {
				jsonRes(res, 503, { error: "Memory orchestrator is not available" });
				return;
			}
			const memoryIds = Array.isArray(body.memoryIds)
				? body.memoryIds.filter((id): id is string => typeof id === "string")
				: [];
			if (memoryIds.length === 0) {
				jsonRes(res, 400, { error: "Missing memory id(s)" });
				return;
			}
			const graph = await this.system.memoryOrchestrator.traverseGraph(
				memoryIds,
				this.memoryContextFromBody(body),
				this.memoryGraphOptionsFromBody(body),
			);
			jsonRes(res, 200, { memoryIds, graph });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleMemoryAudit(
		res: ServerResponse,
		params: URLSearchParams,
	): Promise<void> {
		try {
			if (!this.system?.memoryOrchestrator?.listAudit) {
				jsonRes(res, 503, { error: "Memory orchestrator is not available" });
				return;
			}
			const limit = Number(params.get("limit") ?? 50);
			const memoryId = params.get("id") ?? undefined;
			if (!memoryId) {
				jsonRes(res, 400, { error: "Missing memory id" });
				return;
			}
			const readable = await this.filterReadableMemoryIds(
				[memoryId],
				this.memoryContextFromParams(params),
			);
			if (readable.length === 0) {
				jsonRes(res, 403, { error: "Memory is not accessible" });
				return;
			}
			const audit = await this.system.memoryOrchestrator.listAudit(
				memoryId,
				Number.isFinite(limit) ? limit : 50,
			);
			jsonRes(res, 200, {
				memoryId,
				audit: this.sanitizeAuditEntries(audit),
			});
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleMemoryAuditIntegrity(res: ServerResponse): Promise<void> {
		try {
			if (!this.system?.memoryOrchestrator?.verifyAuditIntegrity) {
				jsonRes(res, 503, { error: "Memory orchestrator is not available" });
				return;
			}
			const report =
				await this.system.memoryOrchestrator.verifyAuditIntegrity();
			jsonRes(res, 200, { report });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleMemoryActions(
		res: ServerResponse,
		params: URLSearchParams,
	): Promise<void> {
		try {
			if (!this.system?.memoryOrchestrator?.listActionLogs) {
				jsonRes(res, 503, { error: "Memory orchestrator is not available" });
				return;
			}
			const limit = Number(params.get("limit") ?? 50);
			const actions = await this.system.memoryOrchestrator.listActionLogs(
				Number.isFinite(limit) ? limit : 50,
			);
			jsonRes(res, 200, { actions: this.sanitizeActionLogs(actions) });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleMemoryVerifyPost(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(await readBody(req)) as Record<string, unknown>;
			} catch {
				jsonRes(res, 400, { error: "Invalid JSON body" });
				return;
			}
			const ids = Array.isArray(body.memoryIds)
				? body.memoryIds.filter((id): id is string => typeof id === "string")
				: [];
			await this.handleMemoryVerify(res, ids, this.memoryContextFromBody(body));
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleMemoryVerify(
		res: ServerResponse,
		memoryIds: string[],
		contextOrParams: MemoryReadContext | URLSearchParams,
	): Promise<void> {
		if (memoryIds.length === 0) {
			jsonRes(res, 400, { error: "Missing memory id(s)" });
			return;
		}
		try {
			if (!this.system?.memoryOrchestrator?.explain) {
				jsonRes(res, 503, { error: "Memory orchestrator is not available" });
				return;
			}
			const context =
				contextOrParams instanceof URLSearchParams
					? this.memoryContextFromParams(contextOrParams)
					: contextOrParams;
			const readable = await this.filterReadableMemoryIds(memoryIds, context);
			if (readable.length === 0) {
				jsonRes(res, 403, { error: "No requested memories are accessible" });
				return;
			}
			const verification = this.system.memoryOrchestrator.verify
				? await this.system.memoryOrchestrator.verify(readable)
				: [];
			const explanations =
				await this.system.memoryOrchestrator.explain(readable);
			jsonRes(res, 200, { memoryIds: readable, verification, explanations });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleMemoryConsolidate(res: ServerResponse): Promise<void> {
		try {
			let result: unknown = null;
			if (
				this.system?.memoryConsolidator?.consolidate &&
				this.system?.agentRuntime?.stm
			) {
				result = await this.system.memoryConsolidator.consolidate(
					this.system.agentRuntime.stm,
				);
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

	private async handleLearningInsights(
		res: ServerResponse,
		params: URLSearchParams,
	): Promise<void> {
		try {
			const config = this.loadConfig();
			if (!this.system?.learningEngine) {
				jsonRes(res, 200, {
					enabled: false,
					config: config.learning,
					insights: [],
				});
				return;
			}
			const limit = Number.parseInt(params.get("limit") ?? "50", 10);
			const type = params.get("type") ?? undefined;
			const insights = await this.system.learningEngine.listInsights({
				limit: Number.isFinite(limit) ? limit : 50,
				...(type ? { type } : {}),
			});
			jsonRes(res, 200, {
				enabled: config.learning.enabled,
				config: config.learning,
				insights,
			});
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleLearningExperiences(
		res: ServerResponse,
		params: URLSearchParams,
	): Promise<void> {
		try {
			const config = this.loadConfig();
			if (!this.system?.learningEngine) {
				jsonRes(res, 200, {
					enabled: false,
					config: config.learning,
					experiences: [],
				});
				return;
			}
			const limit = Number.parseInt(params.get("limit") ?? "30", 10);
			const rawStatus = params.get("status") ?? undefined;
			const status = ["succeeded", "failed", "partial", "unknown"].includes(
				rawStatus ?? "",
			)
				? rawStatus
				: undefined;
			const experiences = await this.system.learningEngine.listExperiences({
				limit: Number.isFinite(limit) ? limit : 30,
				...(status ? { status } : {}),
			});
			jsonRes(res, 200, {
				enabled: config.learning.enabled,
				config: config.learning,
				experiences,
			});
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleLearningFeedback(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			if (!this.system?.learningEngine) {
				jsonRes(res, 404, { error: "Learning engine not available" });
				return;
			}
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(await readBody(req)) as Record<string, unknown>;
			} catch {
				jsonRes(res, 400, { error: "Invalid JSON body" });
				return;
			}
			await this.system.learningEngine.addFeedback({
				experienceId:
					typeof body.experienceId === "string" ? body.experienceId : undefined,
				conversationId:
					typeof body.conversationId === "string"
						? body.conversationId
						: undefined,
				messageId:
					typeof body.messageId === "string" ? body.messageId : undefined,
				rating:
					typeof body.rating === "number" ||
					body.rating === "positive" ||
					body.rating === "negative"
						? body.rating
						: "positive",
				comment: typeof body.comment === "string" ? body.comment : undefined,
			});
			jsonRes(res, 200, { ok: true });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleForgetLearningInsight(
		res: ServerResponse,
		id: string,
	): Promise<void> {
		try {
			if (!this.system?.learningEngine) {
				jsonRes(res, 404, { error: "Learning engine not available" });
				return;
			}
			const ok = await this.system.learningEngine.forgetInsight(id);
			jsonRes(
				res,
				ok ? 200 : 404,
				ok ? { ok: true } : { error: "Insight not found" },
			);
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
			const skillRegistry = this.system?.skillRegistry;
			if (skillRegistry?.list) {
				try {
					const skills = (await skillRegistry.list()) as Skill[];
					dbSkills = await Promise.all(
						skills.map(async (skill) => ({
							...skill,
							recentUsage: skillRegistry.getUsageHistory
								? await skillRegistry
										.getUsageHistory(skill.id, 5)
										.catch(() => [])
								: [],
						})),
					);
				} catch {
					/* table may not exist yet */
				}
			}
			jsonRes(res, 200, {
				enabled: config.skills.enabled,
				autoCreate: config.skills.autoCreate,
				autoImprove: config.skills.autoImprove,
				effectiveAutoCreate:
					config.skills.enabled &&
					config.skills.autoCreate &&
					config.learning.enabled &&
					config.learning.autoCreateSkills,
				learningAutoCreateSkills: config.learning.autoCreateSkills,
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
			if (this.system?.skillRegistry?.save) {
				const skill = await this.getSkillByName(skillName);
				if (!skill) {
					jsonRes(res, 404, { error: `Skill '${skillName}' not found` });
					return;
				}
				const disabled = skill.tags.includes("disabled");
				const tags = disabled
					? skill.tags.filter((tag: string) => tag !== "disabled")
					: Array.from(new Set([...skill.tags, "disabled"]));
				await this.system.skillRegistry.save({ ...skill, tags });
				jsonRes(res, 200, {
					ok: true,
					enabled: disabled,
					skill: { name: skill.name, version: skill.version, tags },
					message: `Skill '${skillName}' ${disabled ? "enabled" : "disabled"}`,
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
					if (result.success && this.system?.reloadDynamicTool) {
						const toolName = String(result.metadata?.toolName ?? parsed.name);
						await this.system.reloadDynamicTool(toolName);
					}
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

	private handleGetToolsUnified(res: ServerResponse): void {
		try {
			const items: Record<string, unknown>[] = [];
			let systemCount = 0;
			let dynamicCount = 0;
			let mcpServerCount = 0;
			let mcpToolCount = 0;

			// Get disabled tools from config
			const config = this.loadConfig();
			const disabledTools = config.tools?.disabled ?? [];

			// 1. Get System & Dynamic Tools from ToolRegistry
			if (this.system?.toolRegistry) {
				const registeredTools = this.system.toolRegistry.list();
				for (const t of registeredTools) {
					const metadata = t.metadata || {};
					const source = metadata.source || "system";

					if (source === "system" || source === "dynamic") {
						const isEnabled = !disabledTools.includes(t.name);
						const paramCount = Object.keys(t.parameters || {}).length;

						items.push({
							id: `${source}:${t.name}`,
							source,
							resourceType: "tool",
							managementScope: "tool",
							name: t.name,
							displayName: t.name,
							description: t.description,
							status: isEnabled ? "active" : "inactive",
							enabled: isEnabled,
							registered: true,
							persisted: true,
							uiIcon: t.uiIcon,
							paramCount,
							parameters: t.parameters,
							origin: metadata,
							capabilities: {
								canToggle: source !== "dynamic",
								canEdit: source === "dynamic",
								canDelete: source === "dynamic",
								canRestart: false,
							},
						});

						if (source === "system") systemCount++;
						if (source === "dynamic") dynamicCount++;
					}
				}
			}

			// Add un-registered dynamic tools (from disk)
			const dir = join(homedir(), ".octopus", "tools");
			if (existsSync(dir)) {
				const entries = readdirSync(dir, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isDirectory()) {
						const manifestPath = join(dir, entry.name, "manifest.json");
						if (existsSync(manifestPath)) {
							try {
								const manifest = JSON.parse(
									readFileSync(manifestPath, "utf-8"),
								);
								const isLoaded = items.some(
									(i) => i.source === "dynamic" && i.name === manifest.name,
								);
								if (!isLoaded) {
									items.push({
										id: `dynamic:${manifest.name}`,
										source: "dynamic",
										resourceType: "tool",
										managementScope: "tool",
										name: manifest.name,
										displayName: manifest.name,
										description: manifest.description || "",
										status: "not_loaded",
										enabled: false,
										registered: false,
										persisted: true,
										version: manifest.version,
										language: manifest.language,
										uiIcon: manifest.uiIcon,
										origin: { path: manifestPath },
										capabilities: {
											canToggle: false,
											canEdit: true,
											canDelete: true,
											canRestart: false,
										},
									});
									dynamicCount++;
								} else {
									const loadedItem = items.find(
										(i) => i.source === "dynamic" && i.name === manifest.name,
									);
									if (loadedItem) {
										loadedItem.version = manifest.version;
										loadedItem.language = manifest.language;
									}
								}
							} catch {}
						}
					}
				}
			}

			// 2. MCP Servers
			if (this.system?.mcpManager) {
				const servers = this.system.mcpManager.listServers();
				for (const s of servers) {
					mcpServerCount++;
					mcpToolCount += (s.tools || []).length;
					const autoDisabled = config.mcp?.autoDisabled || [];
					const isAutoDisabled = autoDisabled.includes(s.name);

					let status = "active";
					if (isAutoDisabled || s.config.enabled === false) status = "inactive";
					else if (s.status === "error") status = "error";
					else if (s.status === "disconnected") status = "not_loaded";

					// Mask env
					const envKeys = s.config.env ? Object.keys(s.config.env) : [];

					items.push({
						id: `mcp-server:${s.name}`,
						source: "mcp",
						resourceType: "mcp-server",
						managementScope: "server",
						name: s.name,
						displayName: s.name,
						description: `MCP Server: ${s.name}`,
						status,
						enabled: status !== "inactive",
						registered: s.status === "connected",
						persisted: true,
						mcp: {
							tools: (s.tools || []).map((tName: string) => ({
								name: tName,
								runtimeName: tName,
							})),
							command: s.config.command,
							args: s.config.args,
							envKeys,
						},
						runtime: {
							error: s.error,
						},
						capabilities: {
							canToggle: true,
							canEdit: true,
							canDelete: true,
							canRestart: true,
						},
					});
				}
			}

			jsonRes(res, 200, {
				items,
				summary: {
					system: systemCount,
					dynamic: dynamicCount,
					mcpServers: mcpServerCount,
					mcpTools: mcpToolCount,
				},
			});
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleToggleSystemTool(
		res: ServerResponse,
		name: string,
	): Promise<void> {
		try {
			const loader = new ConfigLoader();
			const config = loader.load();
			config.tools.disabled = config.tools.disabled ?? [];

			let isEnabled = true;
			if (config.tools.disabled.includes(name)) {
				config.tools.disabled = config.tools.disabled.filter(
					(n: string) => n !== name,
				);
			} else {
				config.tools.disabled.push(name);
				isEnabled = false;
			}
			loader.save(config);

			if (this.system) {
				this.system.config = config;
			}

			jsonRes(res, 200, {
				ok: true,
				name,
				enabled: isEnabled,
				requiresRestart: true,
			});
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private handleGetDynamicToolDetail(res: ServerResponse, name: string): void {
		try {
			const dir = join(homedir(), ".octopus", "tools", name);
			if (!existsSync(dir)) {
				jsonRes(res, 404, { error: "Tool not found" });
				return;
			}
			const manifestPath = join(dir, "manifest.json");
			if (!existsSync(manifestPath)) {
				jsonRes(res, 404, { error: "Manifest not found" });
				return;
			}
			const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
			const ext = manifest.language === "typescript" ? "mts" : "mjs";
			const codePath = join(dir, `index.${ext}`);
			let code = "";
			if (existsSync(codePath)) {
				code = readFileSync(codePath, "utf-8");
			}
			jsonRes(res, 200, { manifest, code });
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleUpdateDynamicTool(
		req: IncomingMessage,
		res: ServerResponse,
		name: string,
	): Promise<void> {
		try {
			const body = JSON.parse(await readBody(req));
			const dir = join(homedir(), ".octopus", "tools", name);
			if (!existsSync(dir)) {
				jsonRes(res, 404, { error: "Tool not found" });
				return;
			}
			const manifestPath = join(dir, "manifest.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

			if (body.description) manifest.description = body.description;
			if (body.uiIcon !== undefined) manifest.uiIcon = body.uiIcon;
			if (body.parameters_schema)
				manifest.parameters = JSON.parse(body.parameters_schema);
			manifest.updatedAt = new Date().toISOString();

			writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

			if (body.code) {
				const ext = manifest.language === "typescript" ? "mts" : "mjs";
				const codePath = join(dir, `index.${ext}`);
				writeFileSync(codePath, body.code, "utf-8");
			}

			const reloaded = this.system?.reloadDynamicTool
				? await this.system.reloadDynamicTool(name)
				: false;
			jsonRes(res, 200, { ok: true, requiresRestart: !reloaded, reloaded });
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleToggleMCPServer(
		res: ServerResponse,
		name: string,
	): Promise<void> {
		try {
			if (!this.system?.mcpManager) {
				jsonRes(res, 503, { error: "MCP Manager not available" });
				return;
			}
			const loader = new ConfigLoader();
			const config = loader.load();
			const isAutoManaged = name.startsWith("zai-");

			if (isAutoManaged) {
				config.mcp = config.mcp || { servers: {}, autoDisabled: [] };
				config.mcp.autoDisabled = config.mcp.autoDisabled || [];
				let enabled = true;
				if (config.mcp.autoDisabled.includes(name)) {
					config.mcp.autoDisabled = config.mcp.autoDisabled.filter(
						(n: string) => n !== name,
					);
				} else {
					config.mcp.autoDisabled.push(name);
					enabled = false;
				}
				loader.save(config);
				this.system.config = config;

				if (!enabled) {
					await this.system.mcpManager.removeServer(name);
				} else {
					const auth = resolveZaiMCPAuth(
						config.ai?.providers?.zhipu,
						process.env,
					);
					if (auth) {
						const zaiConfigs = getZaiMCPConfigs(auth.apiKey, auth.platform);
						const serverConfig = zaiConfigs[name];
						if (serverConfig) {
							await this.system.mcpManager.addServer(name, serverConfig);
						}
					}
				}
				jsonRes(res, 200, { ok: true, enabled });
			} else {
				const server = this.system.mcpManager.getServer(name);
				if (!server) {
					jsonRes(res, 404, { error: "Server not found" });
					return;
				}
				const currentState = server.config.enabled !== false;
				const newState = !currentState;

				config.mcp = config.mcp || { servers: {}, autoDisabled: [] };
				config.mcp.servers = config.mcp.servers || {};
				config.mcp.servers[name] = { ...server.config, enabled: newState };
				loader.save(config);
				this.system.config = config;

				await this.system.mcpManager.setServerEnabled(name, newState);
				jsonRes(res, 200, { ok: true, enabled: newState });
			}
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleGetMCPServer(
		res: ServerResponse,
		name: string,
	): Promise<void> {
		try {
			if (!this.system?.mcpManager) {
				jsonRes(res, 503, { error: "Not available" });
				return;
			}
			const server = this.system.mcpManager.getServer(name);
			if (!server) {
				jsonRes(res, 404, { error: "Server not found" });
				return;
			}
			const maskedEnv: Record<string, string> = {};
			if (server.config.env) {
				for (const [k, v] of Object.entries(server.config.env)) {
					maskedEnv[k] =
						typeof v === "string" && v.length > 4
							? `${v.slice(0, 4)}...`
							: String(v || "");
				}
			}
			const maskedHeaders: Record<string, string> = {};
			if (server.config.headers) {
				for (const [k, v] of Object.entries(server.config.headers)) {
					maskedHeaders[k] =
						typeof v === "string" && v.length > 12
							? `${v.slice(0, 12)}...`
							: String(v || "");
				}
			}
			jsonRes(res, 200, {
				name: server.name,
				config: {
					type: server.config.type,
					url: server.config.url,
					command: server.config.command,
					args: server.config.args,
					env: maskedEnv,
					headers: maskedHeaders,
				},
			});
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleUpdateMCPServer(
		req: IncomingMessage,
		res: ServerResponse,
		name: string,
	): Promise<void> {
		try {
			if (!this.system?.mcpManager) {
				jsonRes(res, 503, { error: "Not available" });
				return;
			}
			const body = JSON.parse(await readBody(req));
			const existing = this.system.mcpManager.getServer(name);
			if (!existing) {
				jsonRes(res, 404, { error: "Server not found" });
				return;
			}

			// merge env with existing env to keep masked secrets
			const newEnv = { ...(existing.config.env || {}) };
			if (body.env) {
				for (const [k, v] of Object.entries(body.env)) {
					if (typeof v === "string" && !v.includes("...")) {
						newEnv[k] = v;
					}
				}
			}
			const newHeaders = { ...(existing.config.headers || {}) };
			if (body.headers) {
				for (const [k, v] of Object.entries(body.headers)) {
					if (typeof v === "string" && !v.includes("...")) {
						newHeaders[k] = v;
					}
				}
			}

			const newConfig = {
				type: body.type || existing.config.type,
				url: body.url || existing.config.url,
				headers: newHeaders,
				command: body.command || existing.config.command,
				args: body.args || existing.config.args,
				env: newEnv,
				enabled: existing.config.enabled,
			};

			await this.system.mcpManager.removeServer(name);
			const newServer = await this.system.mcpManager.addServer(name, newConfig);
			jsonRes(res, 200, { ok: true, server: newServer });
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
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
			const registered: {
				name: string;
				description: string;
				paramCount: number;
			}[] = [];
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
			if (this.system?.skillRegistry?.save) {
				const skill = await this.buildSkillRecord({
					name: parsed.name,
					description: parsed.description ?? "",
					content: parsed.content,
					domain: parsed.domain ?? "general",
				});
				await this.system.skillRegistry.save(skill);
				jsonRes(res, 200, {
					ok: true,
					skill,
					message: `Skill '${parsed.name}' created`,
				});
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
			if (this.system?.skillRegistry?.save) {
				const existing = await this.getSkillByName(skillName);
				if (!existing) {
					jsonRes(res, 404, { error: `Skill '${skillName}' not found` });
					return;
				}
				const skill = await this.buildSkillRecord({
					name: existing.name,
					description: parsed.description ?? existing.description,
					content: parsed.content ?? existing.instructions,
					domain:
						parsed.domain ?? existing.triggerConditions.domains[0] ?? "general",
					existing,
				});
				await this.system.skillRegistry.save(skill);
				jsonRes(res, 200, {
					ok: true,
					skill,
					message: `Skill '${skillName}' updated`,
				});
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
				const existing = await this.getSkillByName(skillName);
				if (!existing) {
					jsonRes(res, 404, { error: `Skill '${skillName}' not found` });
					return;
				}
				await this.system.skillRegistry.delete(existing.id);
				jsonRes(res, 200, {
					ok: true,
					message: `Skill '${skillName}' deleted`,
				});
			} else if (this.system?.db) {
				await this.system.db.run("DELETE FROM skills WHERE name = ?", [
					skillName,
				]);
				jsonRes(res, 200, {
					ok: true,
					message: `Skill '${skillName}' deleted`,
				});
			} else {
				jsonRes(res, 503, { error: "Skill deletion not available" });
			}
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async getSkillByName(skillName: string): Promise<Skill | undefined> {
		if (this.system?.skillRegistry?.getByName) {
			return this.system.skillRegistry.getByName(skillName);
		}
		const allSkills = (await this.system?.skillRegistry?.list?.()) ?? [];
		return allSkills.find((skill: Skill) => skill.name === skillName);
	}

	private async buildSkillRecord(input: {
		name: string;
		description: string;
		content: string;
		domain: string;
		existing?: Skill;
	}): Promise<Skill> {
		const now = new Date().toISOString();
		const text = `${input.name} ${input.description} ${input.domain} ${input.content}`;
		const keywords = this.extractSkillKeywords(text);
		const embedding = await this.embedSkillText(text);
		const existing = input.existing;

		return {
			id: existing?.id ?? randomUUID(),
			name: input.name.trim(),
			version: existing?.version ?? "1.0.0",
			description: input.description.trim(),
			tags: Array.from(new Set([input.domain, ...keywords.slice(0, 8)])),
			embedding,
			instructions: input.content.trim(),
			examples: existing?.examples ?? [],
			templates: existing?.templates ?? [],
			triggerConditions: {
				keywords,
				taskPatterns: existing?.triggerConditions.taskPatterns ?? [],
				domains: Array.from(
					new Set([
						input.domain,
						...(existing?.triggerConditions.domains ?? []),
					]),
				),
			},
			contextEstimate: existing?.contextEstimate ?? {
				instructions: Math.ceil(input.content.length / 4),
				perExample: 0,
				templates: 0,
			},
			metrics: existing?.metrics ?? {
				timesUsed: 0,
				successRate: 1,
				avgUserRating: 0,
				lastUsed: "",
				improvementsCount: 0,
				createdAt: now,
			},
			quality: existing?.quality ?? {
				completeness: 0.8,
				accuracy: 0.8,
				clarity: 0.8,
			},
			dependencies: existing?.dependencies ?? [],
			related: existing?.related ?? [],
		};
	}

	private async embedSkillText(text: string): Promise<number[]> {
		const embedFn = this.system?.embedFn;
		if (typeof embedFn !== "function") return [];
		try {
			return await embedFn(text);
		} catch {
			return [];
		}
	}

	private extractSkillKeywords(text: string): string[] {
		const stop = new Set([
			"para",
			"cuando",
			"con",
			"los",
			"las",
			"una",
			"the",
			"and",
			"that",
			"this",
		]);
		const words = text.toLowerCase().match(/[a-z0-9áéíóúñ_-]{3,}/gi) ?? [];
		return Array.from(new Set(words.filter((word) => !stop.has(word)))).slice(
			0,
			24,
		);
	}

	private handleGetSTM(res: ServerResponse): void {
		try {
			if (this.system?.agentRuntime?.stm) {
				const turns = this.system.agentRuntime.stm.getContext();
				const recentTurns = turns.slice(-30).map(
					(t: {
						role: string;
						content: string;
						timestamp: Date;
						metadata?: Record<string, unknown>;
					}) => ({
						role: t.role,
						content:
							t.content.length > 500
								? `${t.content.substring(0, 500)}...`
								: t.content,
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
				const messageCount =
					(await this.system.dailyMemory.getMessageCount?.()) ?? 0;
				jsonRes(res, 200, {
					context: ctx,
					structured: structured ?? null,
					messageCount,
					date: new Date().toISOString().split("T")[0],
				});
			} else {
				jsonRes(res, 200, {
					context: "",
					structured: null,
					messageCount: 0,
					date: new Date().toISOString().split("T")[0],
				});
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
				const profile =
					await this.system.userProfileManager.getProfile("owner");
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
				const profile =
					await this.system.userProfileManager.getProfile("owner");
				if (parsed.displayName !== undefined)
					profile.displayName = parsed.displayName;
				if (parsed.communicationStyle)
					profile.communicationStyle = parsed.communicationStyle;
				if (parsed.preferredLanguage)
					profile.preferredLanguage = parsed.preferredLanguage;
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
			const safeLimit = Number.isFinite(limit) ? limit : 20;
			if (this.system?.ltm?.listRecent) {
				const memories = await this.system.ltm.listRecent(safeLimit);
				jsonRes(res, 200, { memories });
			} else if (this.system?.db) {
				const rows = await this.system.db
					.all(
						"SELECT id, type, content, importance, access_count, last_accessed, created_at, associations, source, metadata FROM memory_items ORDER BY created_at DESC LIMIT ?",
						[Math.max(1, Math.min(safeLimit, 500))],
					)
					.catch(() => []);
				jsonRes(res, 200, { memories: rows });
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
			const fullPath = resolveRelativePathInside(workspaceRoot, relPath);

			if (!fullPath) {
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
			const fullPath = resolveRelativePathInside(workspaceRoot, relPath);

			if (!fullPath) {
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
			const conversation = await this.system.chatManager.createConversation({
				title: parsed.title,
				agentId: parsed.agentId,
			});
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
			let parsed: { title?: string; agent_id?: string; agentId?: string } = {};
			try {
				parsed = JSON.parse(body);
			} catch {
				jsonRes(res, 400, { error: "Invalid JSON body" });
				return;
			}
			await this.system.chatManager.updateConversation(id, {
				title: parsed.title,
				agentId: parsed.agentId ?? parsed.agent_id,
			});
			jsonRes(res, 200, { ok: true });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleListActiveChatExecutions(
		res: ServerResponse,
	): Promise<void> {
		try {
			if (!this.system?.chatManager) {
				jsonRes(res, 503, { error: "Chat manager not available" });
				return;
			}
			jsonRes(res, 200, await this.system.chatManager.listActiveExecutions());
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleGetConversationExecution(
		res: ServerResponse,
		id: string,
	): Promise<void> {
		try {
			if (!this.system?.chatManager) {
				jsonRes(res, 503, { error: "Chat manager not available" });
				return;
			}
			const active =
				await this.system.chatManager.getActiveExecutionForConversation(id);
			const latest =
				active ??
				(await this.system.chatManager.getLatestExecutionForConversation(id));
			jsonRes(res, 200, { execution: latest });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleGetConversationToolActions(
		res: ServerResponse,
		id: string,
		url: URL,
	): Promise<void> {
		try {
			if (!this.system?.chatManager) {
				jsonRes(res, 503, { error: "Chat manager not available" });
				return;
			}
			const requestedStatus = url.searchParams.get("status");
			const validStatuses = [
				"running",
				"completed",
				"failed",
				"uncertain",
			] as const;
			if (
				requestedStatus &&
				!validStatuses.includes(
					requestedStatus as (typeof validStatuses)[number],
				)
			) {
				jsonRes(res, 400, { error: "Invalid tool action status" });
				return;
			}
			const requestedLimit = Number(url.searchParams.get("limit") ?? 100);
			const limit = Number.isFinite(requestedLimit)
				? Math.max(1, Math.min(200, Math.trunc(requestedLimit)))
				: 100;
			const actions = await this.system.chatManager.listToolActions(id, {
				limit,
				executionId: url.searchParams.get("executionId") ?? undefined,
				status: requestedStatus as (typeof validStatuses)[number] | undefined,
			});
			jsonRes(res, 200, { actions });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleStopConversationExecution(
		res: ServerResponse,
		id: string,
	): Promise<void> {
		try {
			if (!this.system?.chatExecutionManager) {
				jsonRes(res, 503, { error: "Chat execution manager not available" });
				return;
			}
			const execution =
				await this.system.chatExecutionManager.cancelByConversation(id);
			jsonRes(res, 200, { ok: true, execution });
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
			const agents = await this.system.agentManager.listAgents();
			const enriched = await Promise.all(
				agents.map((a: { id: string; model: string | null }) =>
					this.enrichAgentRecord(a),
				),
			);
			jsonRes(res, 200, enriched);
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	/**
	 * Attach the effective model, resolved reasoning effort (from the live runtime
	 * or the persisted profile), and model capabilities to an agent record so the
	 * chat / agents / dashboard UIs can render and edit them consistently.
	 */
	private async enrichAgentRecord<
		T extends { id: string; model: string | null },
	>(
		agent: T,
	): Promise<
		T & {
			effectiveModel: string;
			reasoningEffort: AgentReasoningEffort;
			capabilities: ReturnType<typeof getModelCapabilitiesFromRef>;
		}
	> {
		const config = this.loadConfig();
		const effectiveModel = agent.model ?? config.ai.default;
		const caps = getModelCapabilitiesFromRef(config, effectiveModel);
		const runtime = this.system?.agentManager?.getRuntime(agent.id);
		const fallback: AgentReasoningEffort = caps
			? caps.defaultReasoningEffort
			: "none";
		let reasoning: AgentReasoningEffort = fallback;
		if (runtime?.getConfig().reasoningEffort) {
			reasoning = coerceReasoningEffort(
				caps,
				runtime.getConfig().reasoningEffort,
			);
		} else if (this.system?.agentManager) {
			try {
				reasoning = await this.system.agentManager.resolveReasoningForModel(
					agent.id,
					effectiveModel,
					fallback,
				);
			} catch {
				/* keep fallback */
			}
		}
		return {
			...agent,
			effectiveModel,
			reasoningEffort: reasoning,
			capabilities: caps,
		};
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
			jsonRes(res, 200, await this.enrichAgentRecord(agent));
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleListAgentMessages(
		res: ServerResponse,
		url: URL,
		agentId: string,
	): Promise<void> {
		try {
			if (!this.system?.agentManager) {
				jsonRes(res, 503, { error: "Agent manager not available" });
				return;
			}
			const messages = await this.system.agentManager.listInbox({
				agentId,
				runId: url.searchParams.get("runId") ?? undefined,
				includeBroadcasts:
					url.searchParams.get("includeBroadcasts") !== "false",
				unreadOnly: url.searchParams.get("unreadOnly") === "true",
				limit: Number.parseInt(url.searchParams.get("limit") ?? "50"),
			});
			jsonRes(res, 200, messages);
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleSendAgentMessage(
		res: ServerResponse,
		req: IncomingMessage,
	): Promise<void> {
		try {
			if (!this.system?.agentManager) {
				jsonRes(res, 503, { error: "Agent manager not available" });
				return;
			}
			const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
			const fromAgentId =
				typeof body.fromAgentId === "string" ? body.fromAgentId.trim() : "";
			const content = typeof body.content === "string" ? body.content : "";
			if (!fromAgentId || !content.trim()) {
				jsonRes(res, 400, { error: "fromAgentId and content are required" });
				return;
			}
			const message = await this.system.agentManager.sendMessage({
				fromAgentId,
				toAgentId:
					typeof body.toAgentId === "string" && body.toAgentId.trim()
						? body.toAgentId.trim()
						: null,
				runId:
					typeof body.runId === "string" && body.runId.trim()
						? body.runId.trim()
						: undefined,
				taskId:
					typeof body.taskId === "string" && body.taskId.trim()
						? body.taskId.trim()
						: undefined,
				messageType:
					typeof body.messageType === "string"
						? (body.messageType as never)
						: undefined,
				content,
				metadata:
					body.metadata &&
					typeof body.metadata === "object" &&
					!Array.isArray(body.metadata)
						? (body.metadata as Record<string, unknown>)
						: undefined,
			});
			jsonRes(res, 201, message);
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleMarkAgentMessagesRead(
		res: ServerResponse,
		req: IncomingMessage,
		agentId: string,
	): Promise<void> {
		try {
			if (!this.system?.agentManager) {
				jsonRes(res, 503, { error: "Agent manager not available" });
				return;
			}
			const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
			const messageIds = Array.isArray(body.messageIds)
				? body.messageIds.filter(
						(id): id is string =>
							typeof id === "string" && id.trim().length > 0,
					)
				: [];
			const updated = await this.system.agentManager.markMessagesRead(
				agentId,
				messageIds,
			);
			jsonRes(res, 200, { ok: true, updated });
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
			const agentManager = this.system?.agentManager;
			if (!agentManager) {
				jsonRes(res, 503, { error: "Agent manager not available" });
				return;
			}
			const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
			const existing = await agentManager.getAgent(id);
			if (!existing) {
				jsonRes(res, 404, { ok: false });
				return;
			}
			const ok = await agentManager.updateAgent(id, body);
			if (!ok) {
				jsonRes(res, 404, { ok: false });
				return;
			}

			// Live runtime refresh when model and/or reasoning changed. Keeps the
			// change effective immediately without a restart and persists the
			// per-(agent,model) reasoning profile.
			let effectiveModel: string | undefined;
			let effectiveReasoning: AgentReasoningEffort | undefined;
			const newModel =
				typeof body.model === "string" && body.model.trim()
					? body.model.trim()
					: undefined;
			const wantsReasoning = typeof body.reasoningEffort === "string";
			const runtime = agentManager.getRuntime(id);
			if (runtime && (newModel || wantsReasoning)) {
				const config = this.loadConfig();
				const updatedRecord = await agentManager.getAgent(id);
				effectiveModel =
					updatedRecord?.model ??
					newModel ??
					existing.model ??
					config.ai.default;
				if (wantsReasoning) {
					const caps = getModelCapabilitiesFromRef(config, effectiveModel);
					const desired = body.reasoningEffort as AgentReasoningEffort;
					effectiveReasoning = coerceReasoningEffort(caps, desired);
					await agentManager.upsertModelProfile(
						id,
						effectiveModel,
						effectiveReasoning,
					);
				} else {
					const caps = getModelCapabilitiesFromRef(config, effectiveModel);
					const fallback = caps ? caps.defaultReasoningEffort : "none";
					effectiveReasoning = await agentManager.resolveReasoningForModel(
						id,
						effectiveModel,
						fallback,
					);
				}
				runtime.updateConfig({
					model: newModel,
					reasoningEffort: effectiveReasoning,
				});
				// Mirror Octavio's change onto the legacy config aliases for compatibility.
				if (existing.is_main === 1 && effectiveModel && effectiveReasoning) {
					const onMain = this.system?.onMainAgentModelChange as
						| ((model: string, reasoning: string) => void)
						| undefined;
					onMain?.(effectiveModel, effectiveReasoning);
				}
			}

			const updated = await agentManager.getAgent(id);
			jsonRes(res, 200, {
				ok: true,
				agent: updated,
				effectiveModel: effectiveModel ?? updated?.model ?? undefined,
				effectiveReasoning:
					effectiveReasoning ??
					runtime?.getConfig().reasoningEffort ??
					undefined,
			});
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

	private async handleListWorkflows(
		res: ServerResponse,
		url: URL,
	): Promise<void> {
		try {
			if (!this.system?.workflowManager) {
				jsonRes(res, 200, []);
				return;
			}
			const status = url.searchParams.get("status") ?? undefined;
			const conversationId =
				url.searchParams.get("conversationId") ?? undefined;
			const limit = Number.parseInt(url.searchParams.get("limit") ?? "50");
			const offset = Number.parseInt(url.searchParams.get("offset") ?? "0");
			const resumable = url.searchParams.get("resumable") === "true";
			jsonRes(
				res,
				200,
				resumable
					? await this.system.workflowManager.listResumableRuns({
							conversationId,
							limit,
							offset,
						})
					: await this.system.workflowManager.listRuns({
							status,
							conversationId,
							limit,
							offset,
						}),
			);
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleRecoverWorkflows(res: ServerResponse): Promise<void> {
		try {
			if (!this.system?.workflowManager) {
				jsonRes(res, 503, { error: "Workflow manager not available" });
				return;
			}
			const result =
				await this.system.workflowManager.markStaleRunsInterrupted();
			const scheduler = this.system.workflowScheduler
				? await this.system.workflowScheduler.tick()
				: undefined;
			jsonRes(res, 200, { ok: true, ...result, scheduler });
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleKanbanDispatcherStatus(
		res: ServerResponse,
	): Promise<void> {
		try {
			if (!this.system?.kanbanDispatcher) {
				jsonRes(res, 503, { error: "Kanban dispatcher not available" });
				return;
			}
			jsonRes(res, 200, this.system.kanbanDispatcher.getStatus());
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleKanbanDispatcherTick(res: ServerResponse): Promise<void> {
		try {
			if (!this.system?.kanbanDispatcher) {
				jsonRes(res, 503, { error: "Kanban dispatcher not available" });
				return;
			}
			jsonRes(res, 200, await this.system.kanbanDispatcher.tick());
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleKanbanDispatcherControl(
		res: ServerResponse,
		enabled: boolean,
	): Promise<void> {
		try {
			if (!this.system?.kanbanDispatcher) {
				jsonRes(res, 503, { error: "Kanban dispatcher not available" });
				return;
			}
			jsonRes(res, 200, await this.system.kanbanDispatcher.setEnabled(enabled));
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleGetKanbanTaskContext(
		res: ServerResponse,
		taskId: string,
	): Promise<void> {
		try {
			if (!this.system?.workflowManager) {
				jsonRes(res, 503, { error: "Workflow manager not available" });
				return;
			}
			const context = await this.system.workflowManager.getTaskContext(taskId);
			if (!context) {
				jsonRes(res, 404, { error: "Workflow task not found" });
				return;
			}
			jsonRes(res, 200, context);
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleKanbanRequirementAction(
		res: ServerResponse,
		req: IncomingMessage,
		requirementId: string,
		action: string,
	): Promise<void> {
		try {
			if (!this.system?.workflowManager) {
				jsonRes(res, 503, { error: "Workflow manager not available" });
				return;
			}
			const requirement =
				await this.system.workflowManager.getRequirement(requirementId);
			if (!requirement) {
				jsonRes(res, 404, { error: "Workflow requirement not found" });
				return;
			}
			const body = parseJsonRecord(await readBody(req));
			if (action === "satisfy") {
				await this.system.workflowManager.markRequirementSatisfied(
					requirementId,
					{},
				);
				await this.system.workflowManager.recordEvent({
					runId: requirement.run_id,
					taskId: requirement.task_id,
					eventType: "requirement_satisfied_manual",
					message: `Requirement manually satisfied: ${requirement.requirement_key}`,
					metadata: { requirementId, source: "kanban_api" },
				});
				await this.system.requirementResolver?.unlockSatisfiedTasks(
					requirement.run_id,
				);
				await this.system.workflowManager.completeRunIfAllTasksTerminal(
					requirement.run_id,
				);
			} else if (action === "reset") {
				const reason =
					boundedString(body.reason, "reason", KANBAN_MAX_TEXT_LENGTH, {
						fallback: "Requirement reset from Kanban API",
					}) ?? "Requirement reset from Kanban API";
				await this.system.workflowManager.markRequirementPending(
					requirementId,
					reason,
				);
				await this.system.workflowManager.recordEvent({
					runId: requirement.run_id,
					taskId: requirement.task_id,
					eventType: "requirement_reset_manual",
					message: `Requirement reset: ${requirement.requirement_key}`,
					metadata: { requirementId, reason, source: "kanban_api" },
				});
				await this.system.workflowManager.invalidateTaskForPendingRequirement({
					taskId: requirement.task_id,
					requirementId,
					reason,
				});
			} else {
				jsonRes(res, 400, {
					error: `Unsupported Kanban requirement action: ${action}`,
				});
				return;
			}
			await this.system.kanbanDispatcher?.tick();
			const [snapshot, context] = await Promise.all([
				this.system.workflowManager.getRunSnapshot(requirement.run_id),
				this.system.workflowManager.getTaskContext(requirement.task_id),
			]);
			jsonRes(res, 200, { snapshot, context });
		} catch (err) {
			const message = badRequestMessage(err);
			if (message) {
				jsonRes(res, 400, { error: message });
				return;
			}
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleCreateKanbanPlan(
		res: ServerResponse,
		req: IncomingMessage,
	): Promise<void> {
		try {
			if (!this.system?.workflowManager || !this.system?.kanbanPlanner) {
				jsonRes(res, 503, { error: "Kanban planner not available" });
				return;
			}
			const body = parseJsonRecord(await readBody(req));
			const goal = boundedString(body.goal, "goal", KANBAN_MAX_GOAL_LENGTH, {
				required: true,
			}) as string;
			const tasks = Array.isArray(body.tasks)
				? (body.tasks as Array<Record<string, unknown>>)
				: [];
			if (body.tasks !== undefined && !Array.isArray(body.tasks)) {
				throw badRequest("tasks must be an array when provided");
			}
			if (tasks.length > KANBAN_MAX_TASKS_PER_PLAN) {
				throw badRequest(
					`tasks must contain ${KANBAN_MAX_TASKS_PER_PLAN} items or less`,
				);
			}
			const persisted =
				tasks.length > 0
					? await this.system.kanbanPlanner.persistPlan({
							goal,
							conversationId:
								typeof body.conversationId === "string"
									? body.conversationId
									: undefined,
							rootAgentId:
								typeof body.rootAgentId === "string"
									? body.rootAgentId
									: undefined,
							plan: { goal, tasks },
						})
					: await this.system.kanbanPlanner.planFromGoal({
							goal,
							conversationId:
								typeof body.conversationId === "string"
									? body.conversationId
									: undefined,
							rootAgentId:
								typeof body.rootAgentId === "string"
									? body.rootAgentId
									: undefined,
						});
			await this.system.requirementResolver?.evaluatePendingRequirements({
				runId: persisted.run.id,
			});
			jsonRes(
				res,
				201,
				await this.system.workflowManager.getRunSnapshot(persisted.run.id),
			);
		} catch (err) {
			const message = badRequestMessage(err);
			if (message) {
				jsonRes(res, 400, { error: message });
				return;
			}
			const messageText = err instanceof Error ? err.message : String(err);
			if (
				/Kanban plan|Task .*requires|Duplicate|Cycle|Invalid armKey/i.test(
					messageText,
				)
			) {
				jsonRes(res, 400, { error: messageText });
				return;
			}
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleKanbanTaskAction(
		res: ServerResponse,
		req: IncomingMessage,
		taskId: string,
		action: string,
	): Promise<void> {
		try {
			if (!this.system?.workflowManager) {
				jsonRes(res, 503, { error: "Workflow manager not available" });
				return;
			}
			const task = await this.system.workflowManager.getTask(taskId);
			if (!task) {
				jsonRes(res, 404, { error: "Workflow task not found" });
				return;
			}
			const body = parseJsonRecord(await readBody(req));
			if (action === "retry" || action === "unblock") {
				await this.system.workflowManager.resolveTaskBlockers(
					taskId,
					`${action} from Kanban API`,
				);
				await this.system.workflowManager.updateTaskStatus(taskId, "ready", {
					metadata: { action, source: "kanban_api" },
				});
			} else if (action === "approve") {
				await this.system.workflowManager.resolveTaskBlockers(
					taskId,
					"Approved from Kanban API",
				);
				await this.system.workflowManager.updateTaskStatus(taskId, "done", {
					metadata: { action, source: "kanban_api" },
				});
				await this.system.requirementResolver?.evaluatePendingRequirements({
					runId: task.run_id,
				});
				await this.system.workflowManager.completeRunIfAllTasksTerminal(
					task.run_id,
				);
			} else if (action === "reject") {
				const bodyText =
					boundedString(body.body, "body", KANBAN_MAX_TEXT_LENGTH) ??
					boundedString(body.reason, "reason", KANBAN_MAX_TEXT_LENGTH, {
						fallback: "Review rejected from Kanban API",
					}) ??
					"Review rejected from Kanban API";
				await this.system.workflowManager.recordTaskComment({
					runId: task.run_id,
					taskId,
					commentType: "review_rejected",
					body: bodyText,
					metadata: { source: "kanban_api" },
				});
				await this.system.workflowManager.resolveTaskBlockers(
					taskId,
					"Review rejected; card returned to ready",
				);
				await this.system.workflowManager.updateTaskStatus(taskId, "ready", {
					metadata: { action, source: "kanban_api", reviewFeedback: bodyText },
				});
			} else if (action === "block") {
				const reason =
					boundedString(body.reason, "reason", KANBAN_MAX_TEXT_LENGTH, {
						fallback: "Blocked from Kanban API",
					}) ?? "Blocked from Kanban API";
				await this.system.workflowManager.recordBlocker({
					runId: task.run_id,
					taskId,
					blockerType: "manual",
					reason,
				});
				await this.system.workflowManager.updateTaskStatus(taskId, "blocked");
			} else if (action === "comment") {
				const bodyText =
					boundedString(body.body, "body", KANBAN_MAX_TEXT_LENGTH, {
						fallback: "Comment from Kanban API",
					}) ?? "Comment from Kanban API";
				const commentType =
					boundedString(
						body.commentType,
						"commentType",
						KANBAN_MAX_COMMENT_TYPE_LENGTH,
						{ fallback: "comment" },
					) ?? "comment";
				await this.system.workflowManager.recordTaskComment({
					runId: task.run_id,
					taskId,
					commentType,
					body: bodyText,
					metadata: { source: "kanban_api" },
				});
			} else {
				jsonRes(res, 400, {
					error: `Unsupported Kanban task action: ${action}`,
				});
				return;
			}
			await this.system.kanbanDispatcher?.tick();
			jsonRes(
				res,
				200,
				await this.system.workflowManager.getRunSnapshot(task.run_id),
			);
		} catch (err) {
			const message = badRequestMessage(err);
			if (message) {
				jsonRes(res, 400, { error: message });
				return;
			}
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleKanbanWorkersActive(res: ServerResponse): Promise<void> {
		try {
			const dispatcher = this.system?.kanbanDispatcher;
			if (!dispatcher) {
				jsonRes(res, 503, { error: "Kanban dispatcher not available" });
				return;
			}
			const status = dispatcher.getStatus();
			const workflowManager = this.system?.workflowManager;

			let activeTasks: unknown[] = [];
			let leases: unknown[] = [];
			if (workflowManager && status.activeTaskIds.length > 0) {
				const snapshotPromises = status.activeTaskIds.map(
					async (taskId: string) => {
						const task = await workflowManager.getTask(taskId);
						return task ?? null;
					},
				);
				activeTasks = (await Promise.all(snapshotPromises)).filter(Boolean);

				if (workflowManager.getRunSnapshot) {
					const runIds = new Set(
						activeTasks
							.map((task) => (task as { run_id?: unknown })?.run_id)
							.filter((runId): runId is string => typeof runId === "string"),
					);
					const snapshotResults = await Promise.all(
						[...runIds].map((runId) =>
							workflowManager.getRunSnapshot(runId).catch(() => null),
						),
					);
					leases = snapshotResults.flatMap((snapshot) => {
						const snapshotLeases = (snapshot as { leases?: unknown[] } | null)
							?.leases;
						return Array.isArray(snapshotLeases) ? snapshotLeases : [];
					});
				}
			}

			jsonRes(res, 200, {
				dispatcher: status,
				activeTasks,
				leases,
			});
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleKanbanRunBoard(
		res: ServerResponse,
		runId: string,
	): Promise<void> {
		try {
			const workflowManager = this.system?.workflowManager;
			if (!workflowManager) {
				jsonRes(res, 503, { error: "Workflow manager not available" });
				return;
			}
			if (!runId) {
				jsonRes(res, 400, { error: "Missing runId" });
				return;
			}
			const snapshot = await workflowManager.getRunSnapshot(runId);
			if (!snapshot.run) {
				jsonRes(res, 404, { error: "Workflow run not found" });
				return;
			}

			const columns: Record<string, unknown[]> = {};
			for (const task of snapshot.tasks) {
				const rawStatus = (task as { status?: unknown }).status;
				const status = typeof rawStatus === "string" ? rawStatus : "unknown";
				if (!columns[status]) columns[status] = [];
				columns[status].push(task);
			}

			jsonRes(res, 200, {
				run: snapshot.run,
				columns,
				metrics: snapshot.metrics,
				requirements: snapshot.requirements,
				blockers: snapshot.blockers,
				leases: snapshot.leases,
			});
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleKanbanBlackboardGet(res: ServerResponse): Promise<void> {
		try {
			const bus = this.system?.agentRuntime
				?.getOrchestrator?.()
				?.getCoordinationBus?.();
			if (!bus) {
				jsonRes(res, 200, {
					sharedState: {},
					artifacts: [],
					messages: [],
					summary: "",
					available: false,
				});
				return;
			}
			const artifacts = bus.getAllArtifacts();
			const messages = bus.getMessagesForAgent("*");
			const summary = bus.getCoordinationSummary();
			const sharedState: Record<string, unknown> = {};
			const sharedStateEntries = (
				bus as { sharedState?: { entries?: () => Iterable<[string, unknown]> } }
			).sharedState?.entries?.();
			for (const [key, value] of sharedStateEntries ?? []) {
				sharedState[key] = value;
			}
			jsonRes(res, 200, {
				sharedState,
				artifacts,
				messages,
				summary,
				messageCount: bus.messageCount,
				artifactCount: bus.artifactCount,
				available: true,
			});
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleKanbanBlackboardSet(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			const bus = this.system?.agentRuntime
				?.getOrchestrator?.()
				?.getCoordinationBus?.();
			if (!bus) {
				jsonRes(res, 503, {
					error: "Agent coordination bus not available",
				});
				return;
			}
			const body = await this.readJsonBody(req, res);
			if (!body) return;

			const key = typeof body.key === "string" ? body.key.trim() : "";
			if (!key) {
				jsonRes(res, 400, { error: "Missing 'key'" });
				return;
			}
			if (!Object.hasOwn(body, "value")) {
				jsonRes(res, 400, { error: "Missing 'value'" });
				return;
			}

			bus.setState(key, body.value);
			const workflowManager = this.system?.workflowManager;
			if (workflowManager) {
				const requestedRunId =
					typeof body.run_id === "string"
						? body.run_id.trim()
						: typeof body.runId === "string"
							? body.runId.trim()
							: "";
				const run = requestedRunId
					? await workflowManager.getRun(requestedRunId)
					: (await workflowManager.listRuns({ limit: 1 }))[0];
				if (run) {
					await workflowManager.recordEvent({
						runId: run.id,
						eventType: "shared_state_update",
						message: `Blackboard key updated: ${key}`,
						metadata: {
							source: "kanban_blackboard_api",
							key,
							value: body.value,
						},
					});
				}
			}
			jsonRes(res, 200, { ok: true, key, value: body.value });
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleKanbanInspect(res: ServerResponse): Promise<void> {
		try {
			const dispatcher = this.system?.kanbanDispatcher;
			const workflowManager = this.system?.workflowManager;
			const requirementResolver = this.system?.requirementResolver;

			const dispatcherStatus = dispatcher?.getStatus?.() ?? null;

			let activeRuns: unknown[] = [];
			if (workflowManager?.listRuns) {
				try {
					activeRuns = await workflowManager.listRuns({
						status: undefined,
						limit: 20,
					});
				} catch {
					activeRuns = [];
				}
			}

			let pendingRequirements: unknown[] = [];
			if (workflowManager?.listRequirements) {
				try {
					pendingRequirements = await workflowManager.listRequirements({
						status: "pending",
						limit: 50,
					});
				} catch {
					pendingRequirements = [];
				}
			}

			let evaluationResult = null;
			if (requirementResolver?.evaluatePendingRequirements) {
				try {
					evaluationResult =
						await requirementResolver.evaluatePendingRequirements({});
				} catch {
					evaluationResult = null;
				}
			}

			jsonRes(res, 200, {
				dispatcher: dispatcherStatus,
				activeRuns,
				pendingRequirements,
				evaluationResult,
			});
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleWorkflowAction(
		res: ServerResponse,
		req: IncomingMessage,
		id: string,
		action: string,
	): Promise<void> {
		try {
			if (!this.system?.workflowManager) {
				jsonRes(res, 503, { error: "Workflow manager not available" });
				return;
			}
			if (action === "retry") {
				await this.system.workflowManager.retryRun(id);
				const scheduler = this.system.workflowScheduler
					? await this.system.workflowScheduler.tick()
					: undefined;
				jsonRes(res, 200, { ok: true, id, action, scheduler });
				return;
			}
			if (action === "cancel") {
				let reason: string | undefined;
				try {
					const raw = await readBody(req);
					const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
					reason = typeof body.reason === "string" ? body.reason : undefined;
				} catch {
					reason = undefined;
				}
				await this.system.workflowManager.cancelRun(id, reason);
				jsonRes(res, 200, { ok: true, id, action });
				return;
			}
			jsonRes(res, 400, { error: `Unsupported workflow action: ${action}` });
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleGetWorkflow(
		res: ServerResponse,
		id: string,
	): Promise<void> {
		try {
			if (!this.system?.workflowManager) {
				jsonRes(res, 503, { error: "Workflow manager not available" });
				return;
			}
			const snapshot = await this.system.workflowManager.getRunSnapshot(id);
			if (!snapshot.run) {
				jsonRes(res, 404, { error: "Workflow not found" });
				return;
			}
			jsonRes(res, 200, snapshot);
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
			if (url.searchParams.get("showSecrets") === "true") {
				jsonRes(res, 403, { error: "Secret values cannot be listed" });
				return;
			}
			jsonRes(res, 200, await this.system.envVarManager.list(false));
		} catch (err) {
			jsonRes(res, 500, { error: String(err) });
		}
	}

	private async handleGetEnvVar(
		res: ServerResponse,
		key: string,
	): Promise<void> {
		try {
			if (!this.system?.envVarManager) {
				jsonRes(res, 503, { error: "Not available" });
				return;
			}
			if (!ENV_VAR_KEY_PATTERN.test(key)) {
				jsonRes(res, 400, { error: "Invalid environment variable name" });
				return;
			}

			const value = await this.system.envVarManager.get(key);
			if (value === null) {
				jsonRes(res, 404, { error: "Environment variable not found" });
				return;
			}

			const envVars = await this.system.envVarManager.list(false);
			const metadata = envVars.find(
				(item: { key: string }) => item.key === key,
			);
			jsonRes(res, 200, {
				...(metadata ?? {}),
				key,
				value,
			});
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
			const key = typeof body?.key === "string" ? body.key.trim() : "";
			if (!ENV_VAR_KEY_PATTERN.test(key)) {
				jsonRes(res, 400, {
					error:
						"Invalid environment variable name. Use letters, numbers, and underscores, starting with a letter or underscore.",
				});
				return;
			}

			const hasValue =
				Object.hasOwn(body as Record<string, unknown>, "value") &&
				body.value !== undefined;
			const value = hasValue
				? String(body.value)
				: await this.system.envVarManager.get(key);
			if (value === null) {
				jsonRes(res, 400, { error: "Missing environment variable value" });
				return;
			}

			await this.system.envVarManager.set(key, value, {
				isSecret: body.isSecret,
				description: body.description,
			});
			process.env[key] = value;
			if (BROWSER_TOOL_ENV_KEYS.has(key)) {
				await this.system.refreshBrowserTools?.(this.system.config);
			}

			const envVars = await this.system.envVarManager.list(false);
			jsonRes(
				res,
				200,
				envVars.find((item: { key: string }) => item.key === key) ?? {
					ok: true,
				},
			);
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
			if (!ENV_VAR_KEY_PATTERN.test(key)) {
				jsonRes(res, 400, { error: "Invalid environment variable name" });
				return;
			}
			const ok = await this.system.envVarManager.delete(key);
			if (ok) {
				delete process.env[key];
				if (BROWSER_TOOL_ENV_KEYS.has(key)) {
					await this.system.refreshBrowserTools?.(this.system.config);
				}
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
			const servers = this.system.mcpManager
				.listServers()
				.map((s: MCPManagedServer) => {
					const maskedEnv: Record<string, string> = {};
					if (s.config.env) {
						for (const [k, v] of Object.entries(s.config.env)) {
							maskedEnv[k] =
								typeof v === "string" && v.length > 4
									? `${v.slice(0, 4)}...`
									: String(v || "");
						}
					}
					const maskedHeaders: Record<string, string> = {};
					if (s.config.headers) {
						for (const [k, v] of Object.entries(s.config.headers)) {
							maskedHeaders[k] =
								typeof v === "string" && v.length > 12
									? `${v.slice(0, 12)}...`
									: String(v || "");
						}
					}
					return {
						...s,
						config: { ...s.config, env: maskedEnv, headers: maskedHeaders },
					};
				});
			jsonRes(res, 200, servers);
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
				type: body.type,
				url: body.url,
				headers: body.headers,
				command: body.command,
				args: body.args ?? [],
				env: body.env,
				enabled: body.enabled,
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
				return { name, enabled, type: name, config: redactChannelConfig(rest) };
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
			const items = sortMediaNewestFirst(loadMediaMeta());
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
			if (saved.length === 1) {
				const item = saved[0];
				if (!item) {
					jsonRes(res, 500, { error: "Media save failed" });
					return;
				}
				const ext =
					extname(item.filename) || MIME_EXTENSIONS[item.mimetype] || "";
				jsonRes(res, 201, { ...item, url: `/api/media/file/${item.id}${ext}` });
			} else {
				jsonRes(
					res,
					201,
					saved.map((item) => {
						const ext =
							extname(item.filename) || MIME_EXTENSIONS[item.mimetype] || "";
						return { ...item, url: `/api/media/file/${item.id}${ext}` };
					}),
				);
			}
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

	private resolveMediaFile(id: string): {
		item: MediaItem;
		pureId: string;
		filePath: string;
		size: number;
	} | null {
		// Strip any extension from the id (e.g. "uuid.png" -> "uuid")
		const pureId = id.replace(/\.[^.]+$/, "");
		if (!MEDIA_ID_PATTERN.test(pureId)) return null;
		const items = loadMediaMeta();
		const item = items.find((m) => m.id === pureId);
		if (!item) return null;
		const ext = extname(item.filename) || MIME_EXTENSIONS[item.mimetype] || "";
		const filePath = resolveRelativePathInside(MEDIA_DIR, pureId + ext);
		if (!filePath) return null;
		if (!existsSync(filePath)) return null;
		return { item, pureId, filePath, size: statSync(filePath).size };
	}

	private handleServeMediaThumbnail(res: ServerResponse, id: string): void {
		try {
			const resolved = this.resolveMediaFile(id);
			if (!resolved) {
				jsonRes(res, 404, { error: "Media not found" });
				return;
			}
			if (!resolved.item.mimetype.startsWith("video/")) {
				jsonRes(res, 400, { error: "Media is not a video" });
				return;
			}

			const posterPath = resolveRelativePathInside(
				MEDIA_DIR,
				`${resolved.pureId}.poster.jpg`,
			);
			if (!posterPath) {
				jsonRes(res, 404, { error: "Media not found" });
				return;
			}
			if (!existsSync(posterPath)) {
				const result = spawnSync(
					"ffmpeg",
					[
						"-y",
						"-ss",
						"0.001",
						"-i",
						resolved.filePath,
						"-frames:v",
						"1",
						"-vf",
						"scale='min(720,iw)':-1",
						"-q:v",
						"3",
						posterPath,
					],
					{ stdio: "ignore" },
				);
				if (result.status !== 0 || !existsSync(posterPath)) {
					jsonRes(res, 404, { error: "Video thumbnail unavailable" });
					return;
				}
			}

			const stat = statSync(posterPath);
			corsHeaders(res);
			res.writeHead(200, {
				"Content-Type": "image/jpeg",
				"Content-Length": stat.size,
				"Cache-Control": "public, max-age=86400",
			});
			createReadStream(posterPath).pipe(res);
		} catch (err) {
			jsonRes(res, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private handleServeMediaFile(
		req: IncomingMessage,
		res: ServerResponse,
		id: string,
	): void {
		try {
			const resolved = this.resolveMediaFile(id);
			if (!resolved) {
				jsonRes(res, 404, { error: "Media not found" });
				return;
			}

			const range = req.headers.range;
			const supportsRange =
				resolved.item.mimetype.startsWith("video/") ||
				resolved.item.mimetype.startsWith("audio/");

			if (range && supportsRange) {
				const match = range.match(/^bytes=(\d*)-(\d*)$/);
				if (!match) {
					res.writeHead(416, { "Content-Range": `bytes */${resolved.size}` });
					res.end();
					return;
				}
				const start = match[1] ? Number.parseInt(match[1], 10) : 0;
				const end = match[2]
					? Math.min(Number.parseInt(match[2], 10), resolved.size - 1)
					: resolved.size - 1;
				if (start >= resolved.size || end < start) {
					res.writeHead(416, { "Content-Range": `bytes */${resolved.size}` });
					res.end();
					return;
				}
				const chunkSize = end - start + 1;
				corsHeaders(res);
				res.writeHead(206, {
					"Content-Type": resolved.item.mimetype,
					"Content-Length": chunkSize,
					"Content-Range": `bytes ${start}-${end}/${resolved.size}`,
					"Accept-Ranges": "bytes",
					"Cache-Control": "public, max-age=86400",
				});
				createReadStream(resolved.filePath, { start, end }).pipe(res);
				return;
			}

			corsHeaders(res);
			res.writeHead(200, {
				"Content-Type": resolved.item.mimetype,
				"Content-Length": resolved.size,
				"Accept-Ranges": supportsRange ? "bytes" : "none",
				"Cache-Control": "public, max-age=86400",
			});
			createReadStream(resolved.filePath).pipe(res);
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
			const filePath = resolveRelativePathInside(MEDIA_DIR, id + ext);
			if (!filePath) {
				jsonRes(res, 404, { error: "Media not found" });
				return;
			}
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

	subscribeConversation(clientId: string, conversationId: string): void {
		if (!this.clients.has(clientId)) return;
		const subscribers =
			this.conversationSubscriptions.get(conversationId) ?? new Set<string>();
		subscribers.add(clientId);
		this.conversationSubscriptions.set(conversationId, subscribers);
	}

	unsubscribeConversation(clientId: string, conversationId: string): void {
		const subscribers = this.conversationSubscriptions.get(conversationId);
		if (!subscribers) return;
		subscribers.delete(clientId);
		if (subscribers.size === 0) {
			this.conversationSubscriptions.delete(conversationId);
		}
	}

	unsubscribeClientFromAllConversations(clientId: string): void {
		for (const [conversationId, subscribers] of this
			.conversationSubscriptions) {
			subscribers.delete(clientId);
			if (subscribers.size === 0) {
				this.conversationSubscriptions.delete(conversationId);
			}
		}
	}

	sendToConversation(
		conversationId: string,
		message: ProtocolMessage<unknown>,
	): void {
		const subscribers = this.conversationSubscriptions.get(conversationId);
		if (!subscribers || subscribers.size === 0) return;
		const raw = serializeMessage(message);
		for (const clientId of subscribers) {
			const ws = this.clients.get(clientId);
			if (ws?.readyState === WebSocket.OPEN) {
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

/** Credential fields wiped by the disconnect endpoint for every provider. */
const COMMON_CREDENTIAL_FIELDS = [
	"apiKey",
	"apiKeyEnv",
	"accessToken",
	"accessTokenEnv",
	"oauthAccessToken",
	"oauthRefreshToken",
	"oauthClientId",
	"oauthClientSecret",
	"browserCookies",
	"browserUserAgent",
	"credentialsJson",
	"accountId",
] as const;

/** Extra fields wiped for vertex (location is kept — it's a preference). */
const VERTEX_ONLY_FIELDS = ["credentialsFile", "projectId"] as const;

/**
 * Mutate `prov` in place, clearing every stored credential field for the given
 * provider. Exported for unit tests. oauthExpiresAt is deleted (it's a number,
 * not a string) and authMode is reset to the provider's default.
 */
export function clearProviderCredentials(
	prov: Record<string, unknown>,
	provider: string,
): void {
	const fields =
		provider === "vertex"
			? [...COMMON_CREDENTIAL_FIELDS, ...VERTEX_ONLY_FIELDS]
			: COMMON_CREDENTIAL_FIELDS;
	for (const f of fields) {
		prov[f] = "";
	}
	prov.oauthExpiresAt = undefined;
	if (provider === "openai") prov.authMode = "api-key";
	else prov.authMode = undefined;
}
