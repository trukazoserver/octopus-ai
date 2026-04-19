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
				baseUrl: "https://openrouter.ai/api/v1",
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
				baseUrl: "https://api.deepseek.com",
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
				baseUrl: "https://api.mistral.ai/v1",
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
				baseUrl: "https://api.x.ai/v1",
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
		totalCost: 0,
		byProvider: {},
	};

	constructor(config: LLMRouterConfig) {
		this.config = config;
	}

	async initialize(): Promise<void> {
		for (const [name, config] of Object.entries(this.config.providers)) {
			const registryEntry = PROVIDER_REGISTRY[name];
			if (registryEntry) {
				try {
					const provider = registryEntry.factory(config);
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
		const slashIndex = model.indexOf("/");
		if (slashIndex === -1) {
			for (const [providerName, provider] of this.providers) {
				const registry = PROVIDER_REGISTRY[providerName];
				if (registry?.defaultModels.includes(model)) {
					return { provider, modelName: model, providerName };
				}
			}
			const defaultProvider = this.providers.get(this.config.default);
			if (!defaultProvider)
				throw new Error(
					`Default provider "${this.config.default}" not available`,
				);
			return {
				provider: defaultProvider,
				modelName: model,
				providerName: this.config.default,
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

	private trackUsage(
		provider: string,
		usage: { promptTokens: number; completionTokens: number },
	): void {
		const tokens = usage.promptTokens + usage.completionTokens;
		this.usage.totalTokens += tokens;

		if (!this.usage.byProvider[provider]) {
			this.usage.byProvider[provider] = { tokens: 0, cost: 0, requests: 0 };
		}
		this.usage.byProvider[provider].tokens += tokens;
		this.usage.byProvider[provider].requests += 1;
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

	async chat(request: LLMRequest): Promise<LLMResponse> {
		const enriched = this.injectReasoning(request);
		const { provider, modelName, providerName } = this.resolveProvider(
			enriched.model,
		);
		const resolvedRequest = { ...enriched, model: modelName };

		try {
			const response = await provider.chat(resolvedRequest);
			this.trackUsage(providerName, response.usage);
			return response;
		} catch (error) {
			if (this.config.fallback) {
				const fallbackProvider = this.providers.get(this.config.fallback);
				if (fallbackProvider) {
					logger.warn(
						`Provider '${providerName}' failed, falling back to '${this.config.fallback}'`,
					);
					const fallbackResponse = await fallbackProvider.chat(resolvedRequest);
					this.trackUsage(this.config.fallback, fallbackResponse.usage);
					return fallbackResponse;
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
		const resolvedRequest = { ...enriched, model: modelName };

		try {
			const stream = provider.chatStream(resolvedRequest);
			for await (const chunk of stream) {
				yield chunk;
			}
		} catch (error) {
			if (this.config.fallback) {
				const fallbackProvider = this.providers.get(this.config.fallback);
				if (fallbackProvider) {
					logger.warn(
						`Provider '${providerName}' failed, falling back to '${this.config.fallback}'`,
					);
					const fallbackStream = fallbackProvider.chatStream(resolvedRequest);
					for await (const chunk of fallbackStream) {
						yield chunk;
					}
					return;
				}
			}
			throw error;
		}
	}

	getUsage(): UsageStats {
		return { ...this.usage, byProvider: { ...this.usage.byProvider } };
	}
}
