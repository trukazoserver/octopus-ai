import * as path from "node:path";
import {
	type CommandApprovalConfig,
	CommandApprovalService,
} from "../security/command-approval.js";
import { PathSafetyPolicy } from "../security/path-safety-policy.js";
import { SecretRedactor } from "../security/secret-redactor.js";
import { mediaContext } from "./media.js";
import { ToolRateLimiter } from "./rate-limiter.js";
import type { ToolRateLimitConfig } from "./rate-limiter.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./registry.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolHealthManager } from "./tool-health-manager.js";

const DEFAULT_TOOL_TIMEOUT_MS = 45_000;
const LONG_RUNNING_TOOL_TIMEOUT_MS = 90_000;
const DELEGATE_TASK_TIMEOUT_MS = 300_000;
// orchestrate_parallel runs a full swarm (decompose + N workers + synthesize +
// C1 recovery); with slow models that can take several minutes, so it gets a
// generous budget (mirrors the default workerTimeoutMs).
const ORCHESTRATE_PARALLEL_TIMEOUT_MS = 600_000;
const MEDIA_TOOL_TIMEOUT_MS = 300_000;
const CAPTCHA_TOOL_TIMEOUT_MS = 150_000;
const SCRAPING_TOOL_TIMEOUT_MS = 165_000;

const DATA_URL_RE = /^data:([^;]+);base64,(.+)$/s;
const EMBEDDED_DATA_URL_RE = /data:([^;\s]+);base64,([A-Za-z0-9+/=\r\n]+)/g;
const BASE64_KEY_RE =
	/(?:^|_)(?:image|audio|video|file|document|media)?_?base64$/i;
const MEDIA_MIME_RE = /^(image|audio|video)\//i;
const DOCUMENT_MIME_RE =
	/^(application\/(?:pdf|zip|json|msword|vnd\.|octet-stream)|text\/(?:plain|csv|markdown|html))/i;

interface SavedToolMedia {
	filename: string;
	url: string;
	mimetype: string;
	size: number;
	source: string;
	metadata?: Record<string, unknown>;
}

export interface ToolTimeoutConfig {
	defaultMs?: number;
	longRunningMs?: number;
	captchaMs?: number;
	scrapingMs?: number;
	byTool?: Record<string, number>;
}

export interface ToolExecutionContext {
	agentId?: string;
	model?: string;
	usesZaiVisionToolForImages?: boolean;
	workerId?: string;
	taskId?: string;
	role?: string;
	channelId?: string;
	runId?: string;
	toolScope?: string[];
	fileScope?: string[];
	abortSignal?: AbortSignal;
	/** Canal de progreso para tools longRunning (lo provee el runtime). */
	onProgress?: (status: string) => void;
}

export class ToolExecutor {
	private registry: ToolRegistry;
	private sandboxCommands: boolean;
	private pathPolicy: PathSafetyPolicy;
	private timeouts: Required<ToolTimeoutConfig>;
	private rateLimiter: ToolRateLimiter;
	private commandApproval: CommandApprovalService;
	private redactor: SecretRedactor;
	private health?: ToolHealthManager;

	constructor(
		registry: ToolRegistry,
		config: {
			sandboxCommands: boolean;
			allowedPaths: string[];
			timeouts?: ToolTimeoutConfig;
			rateLimits?: ToolRateLimitConfig;
			commandApproval?: CommandApprovalConfig;
			redactor?: SecretRedactor;
		},
	) {
		this.registry = registry;
		this.sandboxCommands = config.sandboxCommands;
		this.pathPolicy = new PathSafetyPolicy({
			allowedPaths: config.allowedPaths,
		});
		this.timeouts = this.normalizeTimeouts(config.timeouts);
		this.rateLimiter = new ToolRateLimiter(config.rateLimits);
		this.commandApproval = new CommandApprovalService({
			mode: config.sandboxCommands ? "smart" : "off",
			...config.commandApproval,
		});
		this.redactor = config.redactor ?? new SecretRedactor();
	}

	/** Attach the tool-health/quota registry (enables short-circuit + breaker). */
	setHealth(health: ToolHealthManager): void {
		this.health = health;
	}

	/** Tool-health registry, if attached (runtimes read the summary from here). */
	getHealth(): ToolHealthManager | undefined {
		return this.health;
	}

	updateConfig(config: {
		timeouts?: ToolTimeoutConfig;
		rateLimits?: ToolRateLimitConfig;
	}): void {
		if (config.timeouts) {
			this.timeouts = this.normalizeTimeouts(config.timeouts);
		}
		if (config.rateLimits) {
			this.rateLimiter.update(config.rateLimits);
		}
	}

	getTimeoutConfig(): Required<ToolTimeoutConfig> {
		return {
			...this.timeouts,
			byTool: { ...this.timeouts.byTool },
		};
	}

	private normalizeTimeouts(
		timeouts?: ToolTimeoutConfig,
	): Required<ToolTimeoutConfig> {
		const positive = (value: unknown, fallback: number) => {
			const parsed = typeof value === "number" ? value : Number(value);
			return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
		};
		const byTool: Record<string, number> = {};
		for (const [toolName, timeoutMs] of Object.entries(
			timeouts?.byTool ?? {},
		)) {
			byTool[toolName] = positive(timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
		}
		return {
			defaultMs: positive(timeouts?.defaultMs, DEFAULT_TOOL_TIMEOUT_MS),
			longRunningMs: positive(
				timeouts?.longRunningMs,
				LONG_RUNNING_TOOL_TIMEOUT_MS,
			),
			captchaMs: positive(timeouts?.captchaMs, CAPTCHA_TOOL_TIMEOUT_MS),
			scrapingMs: positive(timeouts?.scrapingMs, SCRAPING_TOOL_TIMEOUT_MS),
			byTool,
		};
	}

	private getTimeoutMs(toolName: string): number {
		const toolOverride = this.timeouts.byTool[toolName];
		if (Number.isFinite(toolOverride) && toolOverride > 0) {
			return toolOverride;
		}
		const normalizedToolName = toolName.toLowerCase();
		if (toolName === "browser_solve_captchas") {
			return this.timeouts.captchaMs;
		}
		if (toolName === "delegate_task") {
			return DELEGATE_TASK_TIMEOUT_MS;
		}
		if (toolName === "orchestrate_parallel") {
			return ORCHESTRATE_PARALLEL_TIMEOUT_MS;
		}
		if (toolName === "decodo_scrape") {
			return this.timeouts.scrapingMs;
		}
		if (
			normalizedToolName.includes("video") ||
			normalizedToolName.includes("audio") ||
			normalizedToolName.includes("image") ||
			normalizedToolName.includes("media") ||
			normalizedToolName.includes("generate")
		) {
			return Math.max(this.timeouts.longRunningMs, MEDIA_TOOL_TIMEOUT_MS);
		}
		if (
			toolName.startsWith("browser_") ||
			toolName.includes("web") ||
			toolName.includes("search")
		) {
			return this.timeouts.longRunningMs;
		}
		return this.timeouts.defaultMs;
	}

	private isRateLimitedMediaTool(toolName: string): boolean {
		const normalizedToolName = toolName.toLowerCase();
		return (
			normalizedToolName.includes("video") ||
			normalizedToolName.includes("audio") ||
			normalizedToolName.includes("image") ||
			normalizedToolName.includes("media") ||
			normalizedToolName.includes("generate") ||
			normalizedToolName.includes("banana") ||
			normalizedToolName.includes("veo")
		);
	}

	private isMediaMimeType(mimeType: string | undefined): boolean {
		if (!mimeType) return false;
		return MEDIA_MIME_RE.test(mimeType) || DOCUMENT_MIME_RE.test(mimeType);
	}

	private inferMimeTypeFromFilename(
		filename: string | undefined,
	): string | undefined {
		if (!filename) return undefined;
		const ext = path.extname(filename).toLowerCase();
		const map: Record<string, string> = {
			".png": "image/png",
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
			".webp": "image/webp",
			".gif": "image/gif",
			".svg": "image/svg+xml",
			".mp3": "audio/mpeg",
			".wav": "audio/wav",
			".ogg": "audio/ogg",
			".m4a": "audio/mp4",
			".mp4": "video/mp4",
			".webm": "video/webm",
			".mov": "video/quicktime",
			".pdf": "application/pdf",
			".txt": "text/plain",
			".md": "text/markdown",
			".csv": "text/csv",
			".json": "application/json",
			".zip": "application/zip",
		};
		return map[ext];
	}

	private inferMimeTypeFromKey(key: string): string | undefined {
		const lower = key.toLowerCase();
		if (lower.includes("image")) return "image/png";
		if (lower.includes("audio")) return "audio/mpeg";
		if (lower.includes("video")) return "video/mp4";
		if (lower.includes("document") || lower.includes("file")) {
			return "application/octet-stream";
		}
		return undefined;
	}

	private getStringField(
		obj: Record<string, unknown>,
		keys: string[],
	): string | undefined {
		for (const key of keys) {
			const value = obj[key];
			if (typeof value === "string" && value.trim()) return value;
		}
		return undefined;
	}

	private looksLikeBase64(value: string): boolean {
		if (value.length < 80) return false;
		if (!/^[A-Za-z0-9+/=\r\n]+$/.test(value)) return false;
		try {
			return Buffer.from(value.replace(/\s+/g, ""), "base64").length > 0;
		} catch {
			return false;
		}
	}

	private async saveToolMediaPayload(
		base64: string,
		mimeType: string,
		description: string,
		source: string,
		savedMedia: SavedToolMedia[],
	): Promise<Record<string, unknown>> {
		const buffer = Buffer.from(base64.replace(/\s+/g, ""), "base64");
		const media = await mediaContext.save(buffer, mimeType, description, {
			source,
		});
		const saved = {
			filename: media.filename,
			url: media.url,
			mimetype: media.mimetype,
			size: media.size,
			source,
			metadata: media.metadata,
		};
		savedMedia.push(saved);
		return {
			savedToMediaLibrary: true,
			url: saved.url,
			filename: saved.filename,
			mimetype: saved.mimetype,
			size: saved.size,
			metadata: saved.metadata,
		};
	}

	private async sanitizeMediaPayloads(
		value: unknown,
		toolName: string,
		savedMedia: SavedToolMedia[],
		key = "output",
	): Promise<{ value: unknown; changed: boolean }> {
		if (typeof value === "string") {
			const dataUrl = value.match(DATA_URL_RE);
			if (dataUrl && this.isMediaMimeType(dataUrl[1])) {
				return {
					value: await this.saveToolMediaPayload(
						dataUrl[2],
						dataUrl[1],
						`Generated by ${toolName}`,
						key,
						savedMedia,
					),
					changed: true,
				};
			}

			let changed = false;
			let sanitized = value;
			for (const match of value.matchAll(EMBEDDED_DATA_URL_RE)) {
				const [fullMatch, mimeType, base64] = match;
				if (!this.isMediaMimeType(mimeType)) continue;
				const mediaRef = await this.saveToolMediaPayload(
					base64,
					mimeType,
					`Generated by ${toolName}`,
					key,
					savedMedia,
				);
				sanitized = sanitized.replace(fullMatch, String(mediaRef.url));
				changed = true;
			}
			if (changed) return { value: sanitized, changed: true };

			return { value, changed: false };
		}

		if (Array.isArray(value)) {
			let changed = false;
			const result = [];
			for (let i = 0; i < value.length; i++) {
				const sanitized = await this.sanitizeMediaPayloads(
					value[i],
					toolName,
					savedMedia,
					`${key}[${i}]`,
				);
				changed = changed || sanitized.changed;
				result.push(sanitized.value);
			}
			return { value: result, changed };
		}

		if (value && typeof value === "object") {
			const obj = value as Record<string, unknown>;
			const filename = this.getStringField(obj, [
				"filename",
				"fileName",
				"name",
			]);
			const explicitMime = this.getStringField(obj, [
				"mimeType",
				"mimetype",
				"mime_type",
				"mime",
				"contentType",
			]);
			let changed = false;
			const result: Record<string, unknown> = {};

			for (const [entryKey, entryValue] of Object.entries(obj)) {
				if (
					typeof entryValue === "string" &&
					(BASE64_KEY_RE.test(entryKey) || entryKey.toLowerCase() === "data")
				) {
					const mimeType =
						explicitMime ||
						this.inferMimeTypeFromFilename(filename) ||
						this.inferMimeTypeFromKey(entryKey);
					if (
						this.isMediaMimeType(mimeType) &&
						this.looksLikeBase64(entryValue)
					) {
						result[entryKey.replace(/_?base64$/i, "") || "media"] =
							await this.saveToolMediaPayload(
								entryValue,
								mimeType as string,
								`Generated by ${toolName}${filename ? `: ${filename}` : ""}`,
								`${key}.${entryKey}`,
								savedMedia,
							);
						changed = true;
						continue;
					}
				}

				const sanitized = await this.sanitizeMediaPayloads(
					entryValue,
					toolName,
					savedMedia,
					`${key}.${entryKey}`,
				);
				changed = changed || sanitized.changed;
				result[entryKey] = sanitized.value;
			}

			return { value: result, changed };
		}

		return { value, changed: false };
	}

	private async normalizeMediaOutput(
		toolName: string,
		result: ToolResult,
	): Promise<ToolResult> {
		if (!result.success) return this.redactToolResult(result);

		const savedMedia: SavedToolMedia[] = [];
		const output = await this.sanitizeMediaPayloads(
			result.output,
			toolName,
			savedMedia,
			"output",
		);
		const metadata = await this.sanitizeMediaPayloads(
			result.metadata,
			toolName,
			savedMedia,
			"metadata",
		);

		if (!output.changed && !metadata.changed)
			return this.redactToolResult(result);

		const mediaSummary = savedMedia
			.map(
				(item) =>
					`- ${item.filename} (${item.mimetype}, ${item.size} bytes): ${item.url}`,
			)
			.join("\n");
		const sanitizedOutput =
			typeof output.value === "string"
				? output.value
				: JSON.stringify(output.value, null, 2);

		return this.redactToolResult({
			...result,
			output: `Generated media was saved to the Octopus media library.\n${mediaSummary}\nUse these URLs directly in the response; do not request or expose base64.\n\nSanitized tool output:\n${sanitizedOutput}`,
			metadata: {
				...(metadata.value && typeof metadata.value === "object"
					? (metadata.value as Record<string, unknown>)
					: {}),
				savedMedia,
			},
		});
	}

	private redactToolResult(result: ToolResult): ToolResult {
		const redactedOutput =
			typeof result.output === "string"
				? this.redactor.redactText(result.output)
				: (this.redactor.redact(result.output) as ToolResult["output"]);
		return {
			...result,
			output: redactedOutput,
			error: result.error ? this.redactor.redactText(result.error) : undefined,
			metadata: result.metadata
				? this.redactor.redact(result.metadata)
				: undefined,
		};
	}

	private async withTimeout<T>(
		operation: Promise<T>,
		timeoutMs: number,
		label: string,
		signal?: AbortSignal,
	): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abortHandler: (() => void) | undefined;
		try {
			if (signal?.aborted) throw new Error(`${label} aborted`);
			return await Promise.race([
				operation,
				new Promise<T>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
						timeoutMs,
					);
					if (signal) {
						abortHandler = () => reject(new Error(`${label} aborted`));
						signal.addEventListener("abort", abortHandler, { once: true });
					}
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
			if (signal && abortHandler)
				signal.removeEventListener("abort", abortHandler);
		}
	}

	private getPathParams(params: Record<string, unknown>): string[] {
		const pathKeys = [
			"path",
			"filePath",
			"filepath",
			"dir",
			"directory",
			"workdir",
			"workingDirectory",
			"outputPath",
			"inputPath",
		];
		return pathKeys
			.map((key) => params[key])
			.filter(
				(value): value is string =>
					typeof value === "string" && value.trim().length > 0,
			);
	}

	async execute(
		toolName: string,
		params: Record<string, unknown>,
		executionContext?: ToolExecutionContext,
	): Promise<ToolResult> {
		if (executionContext?.abortSignal?.aborted) {
			return {
				success: false,
				output: "",
				error: `Tool ${toolName} aborted before execution`,
			};
		}
		const tool = this.registry.get(toolName);
		if (!tool) {
			return {
				success: false,
				output: "",
				error: `Tool not found: ${toolName}`,
			};
		}

		const validation = this.validateParams(tool, params);
		if (!validation.valid) {
			return {
				success: false,
				output: "",
				error: `Missing required parameters: ${validation.missing.join(", ")}`,
			};
		}

		if (!tool.managesOwnPathPolicy) {
			for (const pathParam of this.getPathParams(params)) {
				try {
					this.pathPolicy.assertAllowed(pathParam, "Tool path");
				} catch (error) {
					return {
						success: false,
						output: "",
						error: error instanceof Error ? error.message : String(error),
					};
				}
			}
		}

		if (params.command && typeof params.command === "string") {
			const decision = this.commandApproval.evaluate(params.command);
			if (!decision.allowed) {
				return {
					success: false,
					output: "",
					error: decision.reason ?? "Command blocked by security policy",
				};
			}
		}

		// Tool health / quota steering: skip the handler entirely when the
		// backing provider is known to be out of quota, and trip the circuit
		// breaker on repeated failures. This prevents the multi-turn discovery
		// loop where the model only learns a tool is unavailable by trying it.
		if (this.health) {
			const health = await this.health.getStatus(toolName);
			if (health?.status === "no_quota") {
				const alt = this.health.alternativeFor(toolName);
				const when = health.checkedAt
					? new Date(health.checkedAt).toLocaleTimeString()
					: "recientemente";
				return {
					success: false,
					output: "",
					error: `${toolName} no está disponible (sin saldo de API, verificado ${when}).${
						alt ? ` Usa ${alt} en su lugar.` : ""
					}`,
				};
			}
			const circuit = this.health.isCircuitOpen(toolName);
			if (circuit?.open) {
				return {
					success: false,
					output: "",
					error: `${toolName} tiene el cortacircuitos abierto tras ${circuit.failures} fallos consecutivos. Última causa: ${circuit.lastError || "desconocida"}. Usa una alternativa.`,
				};
			}
		}

		try {
			const scopedMediaContext = {
				...mediaContext,
				save: (
					buffer: Buffer,
					mimeType: string,
					description?: string,
					metadata?: Record<string, unknown>,
				) =>
					mediaContext.save(buffer, mimeType, description, {
						...metadata,
						sourceTool: toolName,
						channelId: executionContext?.channelId,
						runId: executionContext?.runId,
						workerId: executionContext?.workerId,
						taskId: executionContext?.taskId,
					}),
			};
			const context: ToolContext = {
				media: scopedMediaContext,
				onProgress: executionContext?.onProgress,
			};
			if (executionContext) context.agent = executionContext;
			const result = await this.rateLimiter.run(
				toolName,
				this.isRateLimitedMediaTool(toolName),
				() =>
					this.withTimeout(
						tool.handler(params, context),
						this.getTimeoutMs(toolName),
						`Tool ${toolName}`,
						executionContext?.abortSignal,
					),
			);
			const normalized = await this.normalizeMediaOutput(toolName, result);
			this.health?.recordOutcome(
				toolName,
				normalized.success,
				normalized.error,
			);
			return normalized;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.health?.recordOutcome(toolName, false, message);
			return {
				success: false,
				output: "",
				error: this.redactor.redactText(`Tool execution failed: ${message}`),
			};
		}
	}

	async executeMultiple(
		calls: Array<{ name: string; params: Record<string, unknown> }>,
		executionContext?: ToolExecutionContext,
	): Promise<ToolResult[]> {
		return Promise.all(
			calls.map((call) =>
				this.execute(call.name, call.params, executionContext),
			),
		);
	}

	private validateParams(
		tool: ToolDefinition,
		params: Record<string, unknown>,
	): { valid: boolean; missing: string[] } {
		const requiredKeys = Object.entries(tool.parameters)
			.filter(([, param]) => param.required)
			.map(([key]) => key);

		const missing = requiredKeys.filter(
			(key) => params[key] === undefined || params[key] === null,
		);

		return {
			valid: missing.length === 0,
			missing,
		};
	}
}
