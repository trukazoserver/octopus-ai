import { createLogger } from "../utils/logger.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import type { BaseLLMProvider } from "./providers/base.js";
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
	LLMResponse,
	LLMRouterConfig,
	ProviderConfig,
	ReasoningConfig,
	ReasoningEffort,
	UsageStats,
} from "./types.js";

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
	return configuredMode ?? "coding-plan";
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
		case "google": {
			const authMode = envOverridesDefault(
				withConfiguredEnv.authMode,
				"api-key",
				process.env.GOOGLE_AUTH_MODE,
				process.env.VERTEXAI === "true" ? "vertex" : undefined,
			);
			return {
				...withConfiguredEnv,
				authMode,
				apiKey: firstNonEmpty(
					withConfiguredEnv.apiKey,
					process.env.GEMINI_API_KEY,
					process.env.GOOGLE_API_KEY,
				),
				baseUrl: firstNonEmpty(
					withConfiguredEnv.baseUrl,
					authMode === "vertex"
						? process.env.GOOGLE_VERTEX_BASE_URL
						: firstEnv("GOOGLE_BASE_URL", "GEMINI_BASE_URL"),
				),
				projectId: firstNonEmpty(
					withConfiguredEnv.projectId,
					process.env.GOOGLE_CLOUD_PROJECT,
					process.env.GCLOUD_PROJECT,
				),
				location: firstNonEmpty(
					withConfiguredEnv.location,
					process.env.GOOGLE_CLOUD_LOCATION,
					process.env.GOOGLE_CLOUD_REGION,
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

function isRetryableProviderError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /fetch failed|network|timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR|socket|terminated/i.test(
		message,
	);
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
		factory: (c) => new OpenAIProvider(c),
		defaultBaseUrl: "https://api.openai.com/v1",
		openAICompatible: true,
		supportsTools: true,
		supportsVision: true,
		supportsReasoning: true,
		hasOAuth: false,
		hasCodingPlan: false,
		hasFreeTier: false,
		defaultModels: ["gpt-4.1", "gpt-4o", "gpt-4o-mini", "o3", "o4-mini"],
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
	google: {
		displayName: "Google Gemini",
		factory: (c) => new GoogleProvider(c),
		defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
		openAICompatible: true,
		supportsTools: true,
		supportsVision: true,
		supportsReasoning: true,
		hasOAuth: true,
		hasCodingPlan: false,
		hasFreeTier: true,
		defaultModels: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
	},
	zhipu: {
		displayName: "Z.ai / ZhipuAI (GLM)",
		factory: (c) => new ZhipuProvider(c),
		defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
		openAICompatible: true,
		supportsTools: true,
		supportsVision: true,
		supportsReasoning: true,
		hasOAuth: false,
		hasCodingPlan: true,
		hasFreeTier: true,
		defaultModels: [
			"glm-5.1",
			"glm-5",
			"glm-5-turbo",
			"glm-4.7",
			"glm-4.6",
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

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	"gemini-2.5-pro": 1_048_576,
	"gemini-2.5-flash": 1_048_576,
	"gemini-2.0-flash": 1_048_576,
	"gpt-4.1": 1_048_576,
	"gpt-4o": 128_000,
	"gpt-4o-mini": 128_000,
	o3: 200_000,
	"o4-mini": 200_000,
	"claude-opus-4-7": 1_048_576,
	"claude-opus-4-6": 1_048_576,
	"claude-sonnet-4-6": 1_048_576,
	"claude-haiku-4-5": 200_000,
	"glm-5.1": 200_000,
	"glm-5": 200_000,
	"glm-5-turbo": 200_000,
	"glm-4.7": 200_000,
	"glm-4.6": 200_000,
	"glm-5v-turbo": 200_000,
	"glm-4.6v": 128_000,
	"deepseek-v4-pro": 128_000,
	"deepseek-v4-flash": 128_000,
	"deepseek-chat": 128_000,
	"deepseek-reasoner": 128_000,
	"mistral-large-3": 128_000,
	"mistral-medium-3-1": 128_000,
	"mistral-medium-3-5": 128_000,
	"mistral-small-4": 128_000,
	"codestral-25-08": 256_000,
	"grok-4.20-0309-reasoning": 1_048_576,
	"grok-4.20-0309-non-reasoning": 1_048_576,
	"grok-4-1-fast-reasoning": 1_048_576,
	"grok-4.3": 1_048_576,
	"command-a-03-2025": 256_000,
	"command-a-vision-07-2025": 128_000,
	"command-a-reasoning-08-2025": 256_000,
	"command-a-plus-05-2026": 128_000,
};

export function getModelContextWindow(model: string): number {
	const normalized = model.includes("/")
		? model.slice(model.indexOf("/") + 1)
		: model;
	if (MODEL_CONTEXT_WINDOWS[normalized])
		return MODEL_CONTEXT_WINDOWS[normalized];
	for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
		if (normalized.startsWith(key.split("-").slice(0, 2).join("-")))
			return value;
	}
	return 128_000;
}

export class LLMRouter {
	private providers: Map<string, BaseLLMProvider> = new Map();
	private config: LLMRouterConfig;
	private usage: UsageStats = {
		totalTokens: 0,
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

	constructor(config: LLMRouterConfig) {
		this.config = config;
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
	}

	addProvider(name: string, provider: BaseLLMProvider): void {
		this.providers.set(name, provider);
	}

	getAvailableProviders(): string[] {
		return Array.from(this.providers.keys());
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
			this.usage.byProvider[provider] = { tokens: 0, cost: 0, requests: 0 };
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
		},
	): void {
		const tokens =
			usage.totalTokens ?? usage.promptTokens + usage.completionTokens;
		this.usage.totalTokens += tokens;
		this.ensureUsageProvider(provider);
		this.usage.byProvider[provider].tokens += tokens;
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
					this.trackUsage(providerName, response.usage);
					return response;
				} catch (error) {
					if (
						attempt < this.providerRetries &&
						isRetryableProviderError(error)
					) {
						const delay = this.providerRetryBaseDelayMs * 2 ** attempt;
						logger.warn(
							`Provider '${providerName}' transient failure; retrying in ${delay}ms (${attempt + 1}/${this.providerRetries})`,
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
						`Provider '${providerName}' failed, falling back to '${fallbackProviderName}'`,
					);
					const fallbackResolved = this.applyVisionRouting(
						{ ...enriched, model: fallbackModelName },
						fallbackProviderName,
					);
					this.trackRequest(fallbackProviderName);
					const fallbackResponse =
						await fallbackProvider.chat(fallbackResolved);
					this.trackUsage(fallbackProviderName, fallbackResponse.usage);
					return fallbackResponse;
				} catch {
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
						if (chunk.usage) this.trackUsage(providerName, chunk.usage);
						yield chunk;
					}
					return;
				} catch (error) {
					if (
						!primaryYieldedAnyChunk &&
						attempt < this.providerRetries &&
						isRetryableProviderError(error)
					) {
						const delay = this.providerRetryBaseDelayMs * 2 ** attempt;
						logger.warn(
							`Provider '${providerName}' stream failed before output; retrying in ${delay}ms (${attempt + 1}/${this.providerRetries})`,
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
						`Provider '${providerName}' failed, falling back to '${fallbackProviderName}'`,
					);
					const fallbackResolved = this.applyVisionRouting(
						{ ...enriched, model: fallbackModelName },
						fallbackProviderName,
					);
					this.trackRequest(fallbackProviderName);
					const fallbackStream = fallbackProvider.chatStream(fallbackResolved);
					for await (const chunk of fallbackStream) {
						if (chunk.usage) this.trackUsage(fallbackProviderName, chunk.usage);
						yield chunk;
					}
					return;
				} catch {
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
