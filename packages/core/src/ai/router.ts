import { createLogger } from "../utils/logger.js";
import { getModelContextWindow } from "./model-context.js";
import { estimateCost } from "./pricing.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import type { BaseLLMProvider } from "./providers/base.js";
import { CodexProvider } from "./providers/codex.js";
import { CohereProvider } from "./providers/cohere.js";
import { GoogleProvider } from "./providers/google.js";
import { OllamaProvider } from "./providers/ollama.js";
import {
	type OpenAICompatibleConfig,
	OpenAICompatibleProvider,
} from "./providers/openai-compatible.js";
import { OpenAIProvider } from "./providers/openai.js";
import { ZhipuProvider } from "./providers/zhipu.js";
import type {
	LLMChunk,
	LLMRequest,
	LLMRequestMetadata,
	LLMResponse,
	LLMRouterConfig,
	ProviderConfig,
	ReasoningConfig,
	ReasoningEffort,
	UsageStats,
} from "./types.js";
import type { UsageSink } from "./usage-store.js";

const logger = createLogger("llm-router");
const DEFAULT_PROVIDER_RETRIES = 2;
const DEFAULT_PROVIDER_RETRY_BASE_DELAY_MS = 1500;

function getPositiveIntEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstNonEmpty(
	...values: Array<string | undefined>
): string | undefined {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

function env(name: string | undefined): string | undefined {
	return name ? firstNonEmpty(process.env[name]) : undefined;
}

function envByMode(mode: string, values: Record<string, string | undefined>) {
	return values[mode];
}

function firstEnv(...names: string[]): string | undefined {
	return firstNonEmpty(...names.map((name) => process.env[name]));
}

function envOverridesDefault(
	value: string | undefined,
	defaultValue: string,
	...envValues: Array<string | undefined>
): string | undefined {
	const configured = firstNonEmpty(value);
	const override = firstNonEmpty(...envValues);
	if (configured && configured !== defaultValue) return configured;
	return firstNonEmpty(override, configured);
}

function resolveZhipuMode(config: ProviderConfig): string {
	const configuredMode = config.mode;
	const hasConfiguredKey = Boolean(
		firstNonEmpty(config.apiKey, config.codingApiKey),
	);
	if (
		configuredMode &&
		(hasConfiguredKey || configuredMode !== "coding-plan")
	) {
		return configuredMode;
	}
	if (process.env.ZAI_CODING_API_KEY) return "coding-global";
	if (process.env.ZHIPU_CODING_API_KEY) return "coding-plan";
	if (process.env.ZAI_API_KEY) return "global";
	if (process.env.ZHIPU_API_KEY) return "api";
	return configuredMode ?? "coding-global";
}

export function resolveProviderConfig(
	providerName: string,
	config: ProviderConfig,
): ProviderConfig {
	const withConfiguredEnv = {
		...config,
		apiKey: firstNonEmpty(config.apiKey, env(config.apiKeyEnv)),
		accessToken: firstNonEmpty(config.accessToken, env(config.accessTokenEnv)),
	};
	switch (providerName) {
		case "openai": {
			const authMode = envOverridesDefault(
				withConfiguredEnv.authMode,
				"api-key",
				process.env.OPENAI_AUTH_MODE,
			);
			return {
				...withConfiguredEnv,
				authMode,
				apiKey: firstNonEmpty(
					withConfiguredEnv.apiKey,
					authMode === "codex"
						? process.env.CODEX_API_KEY
						: process.env.OPENAI_API_KEY,
				),
				baseUrl: envOverridesDefault(
					withConfiguredEnv.baseUrl,
					"https://api.openai.com/v1",
					process.env.OPENAI_BASE_URL,
				),
				accessToken: firstNonEmpty(
					withConfiguredEnv.accessToken,
					process.env.CODEX_ACCESS_TOKEN,
				),
			};
		}
		case "anthropic":
			return {
				...withConfiguredEnv,
				apiKey: firstNonEmpty(
					withConfiguredEnv.apiKey,
					process.env.ANTHROPIC_API_KEY,
					process.env.ANTHROPIC_AUTH_TOKEN,
				),
				baseUrl: envOverridesDefault(
					withConfiguredEnv.baseUrl,
					"https://api.anthropic.com/v1",
					process.env.ANTHROPIC_BASE_URL,
				),
			};
		case "gemini": {
			return {
				...withConfiguredEnv,
				authMode: "api-key" as const,
				apiKey: firstNonEmpty(
					withConfiguredEnv.apiKey,
					process.env.GEMINI_API_KEY,
					process.env.GOOGLE_API_KEY,
				),
				baseUrl: firstNonEmpty(
					withConfiguredEnv.baseUrl,
					firstEnv("GOOGLE_BASE_URL", "GEMINI_BASE_URL"),
				),
			};
		}
		case "vertex": {
			return {
				...withConfiguredEnv,
				authMode: "vertex" as const,
				projectId: firstNonEmpty(
					withConfiguredEnv.projectId,
					process.env.GOOGLE_CLOUD_PROJECT,
					process.env.GCLOUD_PROJECT,
				),
				location: firstNonEmpty(
					withConfiguredEnv.location,
					process.env.GOOGLE_CLOUD_LOCATION,
					process.env.GOOGLE_CLOUD_REGION,
					"us-central1",
				),
				baseUrl: firstNonEmpty(
					withConfiguredEnv.baseUrl,
					process.env.GOOGLE_VERTEX_BASE_URL,
				),
				accessToken: firstNonEmpty(
					withConfiguredEnv.accessToken,
					process.env.GOOGLE_VERTEX_ACCESS_TOKEN,
				),
				credentialsFile: firstNonEmpty(
					withConfiguredEnv.credentialsFile,
					process.env.GOOGLE_APPLICATION_CREDENTIALS,
				),
			};
		}
		case "zhipu": {
			const codingApiKey = firstNonEmpty(
				withConfiguredEnv.codingApiKey,
				envByMode(resolveZhipuMode(withConfiguredEnv), {
					"coding-global": process.env.ZAI_CODING_API_KEY,
					"coding-plan": process.env.ZHIPU_CODING_API_KEY,
				}),
			);
			const mode = resolveZhipuMode(withConfiguredEnv);
			const normalApiKey = firstNonEmpty(
				envByMode(mode, {
					global: process.env.ZAI_API_KEY,
					api: process.env.ZHIPU_API_KEY,
				}),
			);
			const explicitApiKey = withConfiguredEnv.apiKey;
			return {
				...withConfiguredEnv,
				mode,
				apiKey: firstNonEmpty(
					explicitApiKey,
					mode.startsWith("coding") ? codingApiKey : normalApiKey,
				),
				baseUrl: firstNonEmpty(
					withConfiguredEnv.baseUrl,
					mode.startsWith("coding")
						? withConfiguredEnv.codingBaseUrl
						: undefined,
					envByMode(mode, {
						"coding-global": process.env.ZAI_CODING_BASE_URL,
						"coding-plan": process.env.ZHIPU_CODING_BASE_URL,
						global: process.env.ZAI_BASE_URL,
						api: process.env.ZHIPU_BASE_URL,
					}),
				),
			};
		}
		case "openrouter":
			return {
				...withConfiguredEnv,
				apiKey: firstNonEmpty(
					withConfiguredEnv.apiKey,
					process.env.OPENROUTER_API_KEY,
				),
				baseUrl: envOverridesDefault(
					withConfiguredEnv.baseUrl,
					"https://openrouter.ai/api/v1",
					process.env.OPENROUTER_BASE_URL,
				),
			};
		case "deepseek":
			return {
				...withConfiguredEnv,
				apiKey: firstNonEmpty(
					withConfiguredEnv.apiKey,
					process.env.DEEPSEEK_API_KEY,
				),
				baseUrl: envOverridesDefault(
					withConfiguredEnv.baseUrl,
					"https://api.deepseek.com",
					process.env.DEEPSEEK_BASE_URL,
				),
			};
		case "mistral":
			return {
				...withConfiguredEnv,
				apiKey: firstNonEmpty(
					withConfiguredEnv.apiKey,
					process.env.MISTRAL_API_KEY,
				),
				baseUrl: envOverridesDefault(
					withConfiguredEnv.baseUrl,
					"https://api.mistral.ai/v1",
					process.env.MISTRAL_BASE_URL,
				),
			};
		case "xai":
			return {
				...withConfiguredEnv,
				apiKey: firstNonEmpty(
					withConfiguredEnv.apiKey,
					process.env.XAI_API_KEY,
				),
				baseUrl: envOverridesDefault(
					withConfiguredEnv.baseUrl,
					"https://api.x.ai/v1",
					process.env.XAI_BASE_URL,
				),
			};
		case "cohere":
			return {
				...withConfiguredEnv,
				apiKey: firstNonEmpty(
					withConfiguredEnv.apiKey,
					process.env.COHERE_API_KEY,
					process.env.CO_API_KEY,
				),
				baseUrl: envOverridesDefault(
					withConfiguredEnv.baseUrl,
					"https://api.cohere.com/v2",
					process.env.COHERE_BASE_URL,
				),
			};
		case "local":
			return {
				...withConfiguredEnv,
				baseUrl: envOverridesDefault(
					withConfiguredEnv.baseUrl,
					"http://localhost:11434",
					process.env.OLLAMA_BASE_URL,
					process.env.OLLAMA_HOST,
				),
			};
		default:
			return withConfiguredEnv;
	}
}

export function isRetryableProviderError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	// Network/transient errors AND provider rate-limiting (HTTP 429 / 503).
	// Without 429 here, parallel workers that burst the provider's rate limit
	// die on the first attempt with no backoff.
	return /fetch failed|network|timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR|socket|terminated|429|503|rate.?limit|too many requests/i.test(
		message,
	);
}

/**
 * Z.ai coding-plan reports transient backend overload as HTTP 429 with a JSON
 * body code 1305 ("The service may be temporarily overloaded..."). Short
 * retries hammer the same overloaded window, so it needs a longer, escalating
 * backoff than a generic 429. The thrown provider error includes the full body,
 * so we can detect 1305/overloaded from the message text.
 */
export function isZaiOverloadError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	// Z.ai coding-plan reports backend overload as 429 with body code 1305
	// ("The service may be temporarily overloaded..."). Match that specific
	// signature only — a plain quota 429 (code "429") must NOT be treated as
	// overload, or it would get the long escalating backoff unnecessarily.
	return /code["']?\s*:\s*1305|temporarily overloaded|service.{0,20}overload/i.test(
		message,
	);
}

/**
 * Provider rejected the request payload on schema grounds (HTTP 400 "extra
 * inputs not permitted", invalid schema, validation failed). These are NOT
 * transient — retrying or falling over sends the same bad payload — so the
 * backoff helper returns -1 to signal "fail fast".
 */
export function isSchemaValidationError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /extra inputs (are )?not permitted|invalid schema|schema validation|validation failed|unprocessable entit/i.test(
		message,
	);
}

const ZAI_OVERLOAD_BACKOFF_MS = [30_000, 60_000, 90_000, 120_000];
const BACKOFF_EXP_CAP_MS = 30_000;

/**
 * Compute the retry delay (ms) for a provider error.
 *
 * - Schema/validation errors → -1 (caller fails fast; not transient).
 * - z.ai overload (429/1305) → escalating fixed schedule (30→60→90→120s) +
 *   small jitter, so concurrent retries don't synchronize on an overloaded window.
 * - Otherwise → decorrelated full-jitter exponential backoff in
 *   [exp/2, exp] (capped), preventing thundering-herd when parallel workers
 *   all back off at the same instant after a shared 429.
 */
export function computeBackoffDelay(
	error: unknown,
	attempt: number,
	baseMs: number,
): number {
	if (isSchemaValidationError(error)) return -1;
	if (isZaiOverloadError(error)) {
		const step =
			ZAI_OVERLOAD_BACKOFF_MS[
				Math.min(attempt, ZAI_OVERLOAD_BACKOFF_MS.length - 1)
			];
		return step + Math.floor(Math.random() * 5_000);
	}
	const exp = Math.min(baseMs * 2 ** attempt, BACKOFF_EXP_CAP_MS);
	return Math.floor(exp * (0.5 + Math.random() * 0.5));
}

/**
 * Compact one-line summary of a provider error for logs (truncated, whitespace-
 * normalized) so router WARN lines show the actual status/message instead of
 * a bare "transient failure".
 */
function summarizeError(error: unknown): string {
	const msg = error instanceof Error ? error.message : String(error);
	return msg.replace(/\s+/g, " ").trim().slice(0, 300);
}

const PROVIDER_REGISTRY: Record<
	string,
	{
		displayName: string;
		factory: (config: ProviderConfig) => BaseLLMProvider;
		defaultBaseUrl: string;
		openAICompatible: boolean;
		supportsTools: boolean;
		supportsVision: boolean;
		supportsReasoning: boolean;
		hasOAuth: boolean;
		hasCodingPlan: boolean;
		hasFreeTier: boolean;
		defaultModels: string[];
	}
> = {
	openai: {
		displayName: "OpenAI",
		// When authenticated via Codex (ChatGPT account), route to the Codex
		// backend (Responses API) instead of api.openai.com/v1.
		factory: (c) =>
			c.authMode === "codex" && c.accessToken
				? new CodexProvider(c)
				: new OpenAIProvider(c),
		defaultBaseUrl: "https://api.openai.com/v1",
		openAICompatible: true,
		supportsTools: true,
		supportsVision: true,
		supportsReasoning: true,
		hasOAuth: true,
		hasCodingPlan: true,
		hasFreeTier: false,
		defaultModels: [
			"gpt-5.5",
			"gpt-5.4",
			"gpt-5.4-mini",
			"gpt-4.1",
			"gpt-4o",
			"gpt-4o-mini",
		],
	},
	anthropic: {
		displayName: "Anthropic",
		factory: (c) => new AnthropicProvider(c),
		defaultBaseUrl: "https://api.anthropic.com/v1",
		openAICompatible: false,
		supportsTools: true,
		supportsVision: true,
		supportsReasoning: true,
		hasOAuth: false,
		hasCodingPlan: false,
		hasFreeTier: false,
		defaultModels: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
	},
	gemini: {
		displayName: "Google Gemini",
		factory: (c) => new GoogleProvider({ ...c, authMode: "api-key" }),
		defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
		openAICompatible: true,
		supportsTools: true,
		supportsVision: true,
		supportsReasoning: true,
		hasOAuth: false,
		hasCodingPlan: false,
		hasFreeTier: true,
		defaultModels: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
	},
	vertex: {
		displayName: "Google Vertex AI",
		factory: (c) => new GoogleProvider({ ...c, authMode: "vertex" }),
		defaultBaseUrl: "https://us-central1-aiplatform.googleapis.com/v1",
		openAICompatible: true,
		supportsTools: true,
		supportsVision: true,
		supportsReasoning: true,
		hasOAuth: false,
		hasCodingPlan: false,
		hasFreeTier: false,
		defaultModels: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
	},
	zhipu: {
		displayName: "Z.ai / ZhipuAI (GLM)",
		factory: (c) => new ZhipuProvider(c),
		// Metadata only (not consumed at runtime — the endpoint is derived from
		// `mode` in ZhipuProvider). Matches the default mode (coding-global).
		defaultBaseUrl: "https://api.z.ai/api/coding/paas/v4",
		openAICompatible: true,
		supportsTools: true,
		supportsVision: true,
		supportsReasoning: true,
		hasOAuth: false,
		hasCodingPlan: true,
		hasFreeTier: true,
		defaultModels: [
			"glm-5.2",
			"glm-5.1",
			"glm-5",
			"glm-5-turbo",
			"glm-4.7",
			"glm-4.7-flash",
			"glm-4.7-flashx",
			"glm-4.6",
			"glm-4.5-flash",
			"glm-5v-turbo",
			"glm-4.6v",
		],
	},
	openrouter: {
		displayName: "OpenRouter",
		factory: (c) =>
			new OpenAICompatibleProvider({
				...c,
				baseUrl: c.baseUrl ?? "https://openrouter.ai/api/v1",
				prefix: "openrouter",
				extraHeaders: {
					"HTTP-Referer": "https://octopus-ai.dev",
					"X-OpenRouter-Title": "Octopus AI",
				},
			}),
		defaultBaseUrl: "https://openrouter.ai/api/v1",
		openAICompatible: true,
		supportsTools: true,
		supportsVision: true,
		supportsReasoning: true,
		hasOAuth: false,
		hasCodingPlan: false,
		hasFreeTier: false,
		defaultModels: [
			"openai/gpt-4.1",
			"anthropic/claude-sonnet-4-6",
			"google/gemini-2.5-pro",
			"meta-llama/llama-3.3-70b-instruct",
		],
	},
	deepseek: {
		displayName: "DeepSeek",
		factory: (c) =>
			new OpenAICompatibleProvider({
				...c,
				baseUrl: c.baseUrl ?? "https://api.deepseek.com",
				prefix: "deepseek",
			}),
		defaultBaseUrl: "https://api.deepseek.com",
		openAICompatible: true,
		supportsTools: true,
		supportsVision: false,
		supportsReasoning: true,
		hasOAuth: false,
		hasCodingPlan: false,
		hasFreeTier: false,
		defaultModels: ["deepseek-chat", "deepseek-reasoner"],
	},
	mistral: {
		displayName: "Mistral",
		factory: (c) =>
			new OpenAICompatibleProvider({
				...c,
				baseUrl: c.baseUrl ?? "https://api.mistral.ai/v1",
				prefix: "mistral",
			}),
		defaultBaseUrl: "https://api.mistral.ai/v1",
		openAICompatible: true,
		supportsTools: true,
		supportsVision: true,
		supportsReasoning: true,
		hasOAuth: false,
		hasCodingPlan: true,
		hasFreeTier: false,
		defaultModels: [
			"mistral-large-3",
			"mistral-medium-3-1",
			"mistral-small-4",
			"codestral-25-08",
		],
	},
	xai: {
		displayName: "xAI (Grok)",
		factory: (c) =>
			new OpenAICompatibleProvider({
				...c,
				baseUrl: c.baseUrl ?? "https://api.x.ai/v1",
				prefix: "xai",
			}),
		defaultBaseUrl: "https://api.x.ai/v1",
		openAICompatible: true,
		supportsTools: true,
		supportsVision: true,
		supportsReasoning: true,
		hasOAuth: false,
		hasCodingPlan: false,
		hasFreeTier: false,
		defaultModels: [
			"grok-4.20-0309-reasoning",
			"grok-4.20-0309-non-reasoning",
			"grok-4-1-fast-reasoning",
		],
	},
	cohere: {
		displayName: "Cohere",
		factory: (c) => new CohereProvider(c),
		defaultBaseUrl: "https://api.cohere.com/v2",
		openAICompatible: false,
		supportsTools: true,
		supportsVision: true,
		supportsReasoning: true,
		hasOAuth: false,
		hasCodingPlan: false,
		hasFreeTier: true,
		defaultModels: [
			"command-a-03-2025",
			"command-a-vision-07-2025",
			"command-a-reasoning-08-2025",
		],
	},
	local: {
		displayName: "Ollama (Local)",
		factory: (c) => new OllamaProvider(c),
		defaultBaseUrl: "http://localhost:11434",
		openAICompatible: true,
		supportsTools: true,
		supportsVision: true,
		supportsReasoning: false,
		hasOAuth: false,
		hasCodingPlan: false,
		hasFreeTier: true,
		defaultModels: ["llama3.1", "codellama", "mistral", "qwen2.5"],
	},
};

export function getProviderRegistry() {
	return PROVIDER_REGISTRY;
}

export class LLMRouter {
	private providers: Map<string, BaseLLMProvider> = new Map();
	private config: LLMRouterConfig;
	private usage: UsageStats = {
		totalTokens: 0,
		promptTokens: 0,
		completionTokens: 0,
		totalCost: 0,
		byProvider: {},
	};
	private providerRetries = getPositiveIntEnv(
		"OCTOPUS_PROVIDER_RETRIES",
		DEFAULT_PROVIDER_RETRIES,
	);
	private providerRetryBaseDelayMs = getPositiveIntEnv(
		"OCTOPUS_PROVIDER_RETRY_BASE_DELAY_MS",
		DEFAULT_PROVIDER_RETRY_BASE_DELAY_MS,
	);
	private usageSink?: UsageSink;
	private quotaHeaderHandler?: (provider: string, headers: Headers) => void;
	private tokenRefreshHandler?: (
		provider: string,
	) => Promise<{ accessToken: string; expiresAt?: number } | undefined>;
	/** Per-provider auth health, surfaced via /api/status so the UI can tell the
	 * user to re-login instead of failing silently. */
	private authStatus = new Map<
		string,
		{ requiresRelogin: boolean; reason?: string; at: number }
	>();

	constructor(config: LLMRouterConfig) {
		this.config = config;
	}

	/** Attach a durable usage sink so token/cost events survive restarts. */
	setUsageSink(sink: UsageSink | undefined): void {
		this.usageSink = sink;
	}

	/**
	 * Attach a handler that receives raw response headers from every provider
	 * call. Used to capture rate-limit / quota headers (e.g. Codex `x-codex-*`)
	 * into a quota cache for the dashboard.
	 */
	setQuotaHeaderHandler(
		handler: ((provider: string, headers: Headers) => void) | undefined,
	): void {
		this.quotaHeaderHandler = handler;
		for (const [name, provider] of this.providers) {
			provider.onResponseHeaders = (h) => this.quotaHeaderHandler?.(name, h);
		}
	}

	/**
	 * Attach a token-refresh handler. When a refresh-capable provider (currently
	 * CodexProvider) hits a 401, it calls this to obtain a fresh access token —
	 * which the handler persists — then retries the request transparently. If the
	 * handler returns undefined/throws, the 401 propagates to the router's
	 * fallback. Mirrors the setQuotaHeaderHandler wiring pattern.
	 */
	setTokenRefreshHandler(
		handler:
			| ((
					provider: string,
			  ) => Promise<{ accessToken: string; expiresAt?: number } | undefined>)
			| undefined,
	): void {
		this.tokenRefreshHandler = handler;
		this.applyTokenRefreshHook();
	}

	private applyTokenRefreshHook(): void {
		const handler = this.tokenRefreshHandler;
		for (const [name, provider] of this.providers) {
			if (provider instanceof CodexProvider) {
				provider.onTokenRefresh = handler
					? async () => {
							const refreshed = await handler(name);
							if (!refreshed) {
								throw new Error(
									`token refresh returned no token for '${name}'`,
								);
							}
							return refreshed;
						}
					: undefined;
			}
		}
	}

	/**
	 * Mark a provider's auth as needing re-login (e.g. Codex refresh token
	 * revoked/expired). Surfaced via getAuthStatus() → /api/status so the UI can
	 * prompt the user instead of failing silently through the fallback.
	 */
	markAuthStatus(
		provider: string,
		entry: { requiresRelogin: boolean; reason?: string },
	): void {
		this.authStatus.set(provider, { ...entry, at: Date.now() });
	}

	/** Clear a provider's auth-status (e.g. after a successful refresh/re-login). */
	clearAuthStatus(provider: string): void {
		this.authStatus.delete(provider);
	}

	/** Snapshot of per-provider auth health for /api/status. */
	getAuthStatus(): Record<
		string,
		{ requiresRelogin: boolean; reason?: string; at: number }
	> {
		const out: Record<
			string,
			{ requiresRelogin: boolean; reason?: string; at: number }
		> = {};
		for (const [provider, entry] of this.authStatus) {
			out[provider] = entry;
		}
		return out;
	}

	async reconfigure(config: LLMRouterConfig): Promise<void> {
		this.config = config;
		this.providers.clear();
		await this.initialize();
	}

	async initialize(): Promise<void> {
		for (const [name, config] of Object.entries(this.config.providers)) {
			const registryEntry = PROVIDER_REGISTRY[name];
			if (registryEntry) {
				try {
					const provider = registryEntry.factory(
						resolveProviderConfig(name, config),
					);
					const available = await provider.isAvailable();
					if (available) {
						provider.onResponseHeaders = (h) =>
							this.quotaHeaderHandler?.(name, h);
						this.providers.set(name, provider);
						logger.info(
							`Provider '${name}' (${registryEntry.displayName}) initialized`,
						);
					} else {
						logger.warn(
							`Provider '${name}' not available (check API key / connectivity)`,
						);
					}
				} catch (err) {
					logger.warn(
						`Provider '${name}' failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}

		if (this.providers.size === 0) {
			logger.warn(
				"No AI providers available. Please configure at least one provider with a valid API key.",
			);
		}
		this.applyTokenRefreshHook();
	}

	addProvider(name: string, provider: BaseLLMProvider): void {
		this.providers.set(name, provider);
	}

	getAvailableProviders(): string[] {
		return Array.from(this.providers.keys());
	}

	/**
	 * Whether the provider backing `model` can accept image content natively
	 * (multimodal). Used by the agent runtime to decide between embedding images
	 * directly and routing them through an external vision tool.
	 */
	supportsVisionForModel(model: string): boolean {
		try {
			const { providerName } = this.resolveProvider(model);
			return PROVIDER_REGISTRY[providerName]?.supportsVision ?? false;
		} catch {
			return false;
		}
	}

	private resolveProvider(model: string): {
		provider: BaseLLMProvider;
		modelName: string;
		providerName: string;
	} {
		if (model === "default" && this.config.default !== "default") {
			return this.resolveProvider(this.config.default);
		}

		const slashIndex = model.indexOf("/");
		if (slashIndex === -1) {
			for (const [providerName, provider] of this.providers) {
				const registry = PROVIDER_REGISTRY[providerName];
				if (registry?.defaultModels.includes(model)) {
					return { provider, modelName: model, providerName };
				}
			}
			const defaultProviderName = this.config.default.includes("/")
				? this.config.default.slice(0, this.config.default.indexOf("/"))
				: this.config.default;
			const defaultProvider = this.providers.get(defaultProviderName);
			if (!defaultProvider)
				throw new Error(
					`Default provider "${defaultProviderName}" not available`,
				);
			return {
				provider: defaultProvider,
				modelName: model,
				providerName: defaultProviderName,
			};
		}

		const providerName = model.slice(0, slashIndex);
		const modelName = model.slice(slashIndex + 1);
		const provider = this.providers.get(providerName);
		if (!provider) {
			const available = Array.from(this.providers.keys()).join(", ");
			throw new Error(
				`Provider "${providerName}" not available. Available: ${available}`,
			);
		}
		return { provider, modelName, providerName };
	}

	private ensureUsageProvider(provider: string): void {
		if (!this.usage.byProvider[provider]) {
			this.usage.byProvider[provider] = {
				tokens: 0,
				promptTokens: 0,
				completionTokens: 0,
				cost: 0,
				requests: 0,
			};
		}
	}

	private trackRequest(provider: string): void {
		this.ensureUsageProvider(provider);
		this.usage.byProvider[provider].requests += 1;
	}

	private trackUsage(
		provider: string,
		usage: {
			promptTokens: number;
			completionTokens: number;
			totalTokens?: number;
			reasoningTokens?: number;
		},
		model?: string,
		metadata?: LLMRequestMetadata,
	): void {
		const prompt = usage.promptTokens ?? 0;
		const completion = usage.completionTokens ?? 0;
		const reasoning = usage.reasoningTokens ?? 0;
		const tokens = usage.totalTokens ?? prompt + completion;
		this.usage.totalTokens += tokens;
		this.usage.promptTokens += prompt;
		this.usage.completionTokens += completion;
		this.ensureUsageProvider(provider);
		const entry = this.usage.byProvider[provider];
		entry.tokens += tokens;
		entry.promptTokens += prompt;
		entry.completionTokens += completion;
		const cost = estimateCost(provider, model, prompt, completion);
		if (cost > 0) {
			this.usage.totalCost += cost;
			entry.cost += cost;
		}
		this.usageSink?.record({
			provider,
			model,
			agentId: metadata?.agentId,
			conversationId: metadata?.conversationId,
			requestId: metadata?.requestId,
			promptTokens: prompt,
			completionTokens: completion,
			reasoningTokens: reasoning,
			totalTokens: tokens,
			estimatedCost: cost,
		});
	}

	private injectReasoning(request: LLMRequest): LLMRequest {
		if (request.reasoning) return request;
		const thinking = this.config.thinking;
		if (!thinking || thinking === "none") return request;
		return {
			...request,
			reasoning: {
				effort: thinking,
				includeThinking: true,
			},
		};
	}

	/**
	 * Map of text-only model → vision model, per provider.
	 * When a request contains images via direct API, we transparently upgrade the model.
	 * NOTE: zhipu (Coding Plan) is NOT listed here — vision is handled via Z.AI MCP Server.
	 */
	private static readonly VISION_MODEL_MAP: Record<
		string,
		Record<string, string>
	> = {
		// openai, anthropic, google etc. can be added here if needed
	};

	/**
	 * Returns true if any message in the request has image content parts.
	 */
	private hasVisionContent(request: LLMRequest): boolean {
		return request.messages.some((msg) => {
			if (!Array.isArray(msg.content)) return false;
			return (msg.content as Array<{ type: string }>).some(
				(part) => part.type === "image_url",
			);
		});
	}

	/**
	 * If the request contains images and the current model is text-only,
	 * upgrade to the vision-capable equivalent for this provider.
	 */
	private applyVisionRouting(
		request: LLMRequest,
		providerName: string,
	): LLMRequest {
		if (!this.hasVisionContent(request)) return request;
		const visionMap = LLMRouter.VISION_MODEL_MAP[providerName];
		if (!visionMap) return request;
		const visionModel = visionMap[request.model];
		if (!visionModel) return request;
		logger.info(
			`Vision routing: upgrading model ${request.model} → ${visionModel} for ${providerName}`,
		);
		return { ...request, model: visionModel };
	}

	async chat(request: LLMRequest): Promise<LLMResponse> {
		const enriched = this.injectReasoning(request);
		const { provider, modelName, providerName } = this.resolveProvider(
			enriched.model,
		);
		const visionRouted = this.applyVisionRouting(
			{ ...enriched, model: modelName },
			providerName,
		);
		const resolvedRequest = visionRouted;

		try {
			for (let attempt = 0; ; attempt++) {
				try {
					this.trackRequest(providerName);
					const response = await provider.chat(resolvedRequest);
					this.trackUsage(
						providerName,
						response.usage,
						resolvedRequest.model,
						resolvedRequest.metadata,
					);
					return response;
				} catch (error) {
					if (
						attempt < this.providerRetries &&
						isRetryableProviderError(error)
					) {
						const delay = computeBackoffDelay(
							error,
							attempt,
							this.providerRetryBaseDelayMs,
						);
						if (delay < 0) throw error; // schema/validation: fail fast
						logger.warn(
							`Provider '${providerName}' transient failure; retrying in ${delay}ms (${attempt + 1}/${this.providerRetries}): ${summarizeError(error)}`,
						);
						await sleep(delay);
						continue;
					}
					throw error;
				}
			}
		} catch (error) {
			if (this.config.fallback) {
				try {
					const {
						provider: fallbackProvider,
						modelName: fallbackModelName,
						providerName: fallbackProviderName,
					} = this.resolveProvider(this.config.fallback);
					logger.warn(
						`Provider '${providerName}' failed, falling back to '${fallbackProviderName}': ${summarizeError(error)}`,
					);
					const fallbackResolved = this.applyVisionRouting(
						{ ...enriched, model: fallbackModelName },
						fallbackProviderName,
					);
					this.trackRequest(fallbackProviderName);
					const fallbackResponse =
						await fallbackProvider.chat(fallbackResolved);
					this.trackUsage(
						fallbackProviderName,
						fallbackResponse.usage,
						fallbackResolved.model,
						fallbackResolved.metadata,
					);
					return fallbackResponse;
				} catch (fallbackError) {
					logger.warn(
						`Fallback '${this.config.fallback}' also failed: ${summarizeError(fallbackError)}`,
					);
					// Surface the original provider error when fallback is unavailable.
				}
			}
			throw error;
		}
	}

	async *chatStream(request: LLMRequest): AsyncIterable<LLMChunk> {
		const enriched = this.injectReasoning(request);
		const { provider, modelName, providerName } = this.resolveProvider(
			enriched.model,
		);
		const visionRouted = this.applyVisionRouting(
			{ ...enriched, model: modelName },
			providerName,
		);
		const resolvedRequest = visionRouted;
		let primaryYieldedAnyChunk = false;

		try {
			for (let attempt = 0; ; attempt++) {
				try {
					this.trackRequest(providerName);
					const stream = provider.chatStream(resolvedRequest);
					for await (const chunk of stream) {
						primaryYieldedAnyChunk = true;
						if (chunk.usage)
							this.trackUsage(
								providerName,
								chunk.usage,
								resolvedRequest.model,
								resolvedRequest.metadata,
							);
						yield chunk;
					}
					return;
				} catch (error) {
					if (
						!primaryYieldedAnyChunk &&
						attempt < this.providerRetries &&
						isRetryableProviderError(error)
					) {
						const delay = computeBackoffDelay(
							error,
							attempt,
							this.providerRetryBaseDelayMs,
						);
						if (delay < 0) throw error; // schema/validation: fail fast
						logger.warn(
							`Provider '${providerName}' stream failed before output; retrying in ${delay}ms (${attempt + 1}/${this.providerRetries}): ${summarizeError(error)}`,
						);
						await sleep(delay);
						continue;
					}
					throw error;
				}
			}
		} catch (error) {
			if (this.config.fallback && !primaryYieldedAnyChunk) {
				try {
					const {
						provider: fallbackProvider,
						modelName: fallbackModelName,
						providerName: fallbackProviderName,
					} = this.resolveProvider(this.config.fallback);
					logger.warn(
						`Provider '${providerName}' failed, falling back to '${fallbackProviderName}': ${summarizeError(error)}`,
					);
					const fallbackResolved = this.applyVisionRouting(
						{ ...enriched, model: fallbackModelName },
						fallbackProviderName,
					);
					this.trackRequest(fallbackProviderName);
					const fallbackStream = fallbackProvider.chatStream(fallbackResolved);
					for await (const chunk of fallbackStream) {
						if (chunk.usage)
							this.trackUsage(
								fallbackProviderName,
								chunk.usage,
								fallbackResolved.model,
								fallbackResolved.metadata,
							);
						yield chunk;
					}
					return;
				} catch (fallbackError) {
					logger.warn(
						`Fallback '${this.config.fallback}' also failed: ${summarizeError(fallbackError)}`,
					);
					// Surface the original provider error when fallback is unavailable.
				}
			}
			throw error;
		}
	}

	getUsage(): UsageStats {
		return { ...this.usage, byProvider: { ...this.usage.byProvider } };
	}

	// --- Live Model Switching ---

	/**
	 * Switch the default provider at runtime (no restart needed).
	 * Returns true if the provider exists and is available.
	 */
	switchProvider(providerName: string): boolean {
		if (!this.providers.has(providerName)) {
			logger.warn(
				`Cannot switch to provider '${providerName}' — not available`,
			);
			return false;
		}
		const previousDefault = this.config.default;
		this.config.default = providerName;
		logger.info(
			`Default provider switched: ${previousDefault} → ${providerName}`,
		);
		return true;
	}

	/**
	 * Switch the default model at runtime.
	 * Use "provider/model" format or just "model" for current default provider.
	 */
	setDefaultModel(model: string): void {
		(this.config as unknown as Record<string, unknown>).defaultModel = model;
		logger.info(`Default model set to: ${model}`);
	}

	/**
	 * Get current active provider and model info.
	 */
	getActiveConfig(): {
		defaultProvider: string;
		availableProviders: string[];
		fallback: string | undefined;
	} {
		return {
			defaultProvider: this.config.default,
			availableProviders: Array.from(this.providers.keys()),
			fallback: this.config.fallback,
		};
	}

	/**
	 * Hot-add a new provider at runtime (e.g., user adds API key mid-session).
	 */
	async addProviderFromConfig(
		name: string,
		config: ProviderConfig,
	): Promise<boolean> {
		const registryEntry = PROVIDER_REGISTRY[name];
		if (!registryEntry) {
			logger.warn(`Unknown provider: ${name}`);
			return false;
		}

		try {
			const provider = registryEntry.factory(config);
			const available = await provider.isAvailable();
			if (available) {
				this.providers.set(name, provider);
				provider.onResponseHeaders = (h) => this.quotaHeaderHandler?.(name, h);
				this.applyTokenRefreshHook();
				logger.info(`Provider '${name}' hot-added successfully`);
				return true;
			}
			logger.warn(`Provider '${name}' configured but not available`);
			return false;
		} catch (err) {
			logger.error(`Failed to hot-add provider '${name}': ${String(err)}`);
			return false;
		}
	}

	/**
	 * Remove a provider at runtime.
	 */
	removeProvider(name: string): boolean {
		if (name === this.config.default) {
			logger.warn(`Cannot remove default provider '${name}'`);
			return false;
		}
		const removed = this.providers.delete(name);
		if (removed) {
			logger.info(`Provider '${name}' removed`);
		}
		return removed;
	}
}
