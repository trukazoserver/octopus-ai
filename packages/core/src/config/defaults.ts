import type { OctopusConfig } from "./schema.js";

export const DEFAULT_CONFIG: OctopusConfig = {
	version: 1,
	server: {
		port: 18789,
		host: "127.0.0.1",
		transport: "auto",
	},
	ai: {
		default: "zhipu/glm-5.1",
		fallback: "openai/gpt-4.1",
		providers: {
			anthropic: {
				apiKey: "",
				models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
			},
			openai: {
				apiKey: "",
				models: ["gpt-4.1", "gpt-4o", "gpt-4o-mini", "o3", "o4-mini"],
			},
			google: {
				apiKey: "",
				models: ["gemini-2.5-pro", "gemini-2.5-flash"],
			},
			zhipu: {
				apiKey: "",
				mode: "coding-plan",
				models: ["glm-5.1", "glm-5", "glm-5-turbo", "glm-5v-turbo", "glm-4.6v"],
			},
			openrouter: {
				apiKey: "",
			},
			deepseek: {
				apiKey: "",
				models: ["deepseek-chat", "deepseek-reasoner"],
			},
			mistral: {
				apiKey: "",
				models: ["mistral-large-3", "mistral-small-4", "codestral-25-08"],
			},
			xai: {
				apiKey: "",
				models: ["grok-4.20-0309-reasoning", "grok-4-1-fast-reasoning"],
			},
			cohere: {
				apiKey: "",
				models: ["command-a-03-2025", "command-a-vision-07-2025"],
			},
			local: {
				baseUrl: "http://localhost:11434",
				models: ["llama3.1", "codellama", "mistral", "qwen2.5"],
			},
		},
		thinking: "medium",
		maxTokens: 16384,
	},
	channels: {
		whatsapp: { enabled: false },
		telegram: { enabled: false },
		discord: { enabled: false },
		slack: { enabled: false },
		teams: { enabled: false },
		signal: { enabled: false },
		wechat: { enabled: false },
		webchat: { enabled: true },
	},
	connection: {
		autoProxy: true,
		retryMaxAttempts: 5,
		retryBaseDelay: 1000,
		circuitBreakerThreshold: 5,
		healthCheckInterval: 30000,
		offlineQueueSize: 1000,
		preferIPv4: true,
	},
	memory: {
		enabled: true,
		shortTerm: {
			maxTokens: 8192,
			scratchPadSize: 2048,
			autoEviction: true,
		},
		longTerm: {
			backend: "sqlite-vss",
			importanceThreshold: 0.5,
			maxItems: 100000,
			episodic: {
				decayRate: 0.003,
				compressionAfter: "30d",
				maxAge: "365d",
			},
			semantic: {
				decayRate: 0.0001,
				contradictionCheck: true,
			},
			associative: {
				enabled: true,
				cascadeDepth: 2,
				cascadeThreshold: 0.8,
			},
		},
		consolidation: {
			trigger: "task-complete",
			idleInterval: "30m",
			batchSize: 50,
			extractFacts: true,
			extractEvents: true,
			extractProcedures: true,
			buildAssociations: true,
			compressAndDecay: true,
		},
		retrieval: {
			maxResults: 10,
			maxTokens: 2000,
			minRelevance: 0.6,
			weights: {
				relevance: 0.5,
				recency: 0.3,
				frequency: 0.2,
			},
		},
	},
	skills: {
		enabled: true,
		autoCreate: true,
		autoImprove: true,
		forge: {
			complexityThreshold: 0.6,
			selfCritique: true,
			minQualityScore: 7,
			includeExamples: true,
			includeTemplates: true,
			includeAntiPatterns: true,
		},
		improvement: {
			triggerOnSuccessRate: 0.7,
			triggerOnRating: 3.5,
			reviewEveryNUses: 10,
			abTestMajorChanges: true,
			abTestSampleSize: 20,
		},
		loading: {
			maxTokenBudget: 3000,
			progressiveLevels: true,
			autoUnload: true,
			searchThreshold: 0.7,
		},
		registry: {
			path: "~/.octopus/skills",
			builtinSkills: [
				"general-reasoning",
				"code-generation",
				"writing",
				"research",
			],
		},
	},
	plugins: {
		directories: ["~/.octopus/plugins"],
		builtin: ["productivity", "coding"],
	},
	storage: {
		backend: "sqlite",
		path: "~/.octopus/data/octopus.db",
	},
	security: {
		encryptionKey: "",
		allowedPaths: ["~/Documents", "~/Desktop"],
		sandboxCommands: true,
	},
};

export function getDefaults(): OctopusConfig {
	return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}
