import { type Static, Type } from "@sinclair/typebox";

const ServerSchema = Type.Object({
	port: Type.Number({ default: 18789 }),
	host: Type.String({ default: "127.0.0.1" }),
	transport: Type.Union(
		[
			Type.Literal("auto"),
			Type.Literal("stdio"),
			Type.Literal("sse"),
			Type.Literal("streamable-http"),
		],
		{ default: "auto" },
	),
});

const AnthropicProviderSchema = Type.Object({
	apiKey: Type.String({ default: "" }),
	models: Type.Array(Type.String(), {
		default: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
	}),
});

const OpenAIProviderSchema = Type.Object({
	apiKey: Type.String({ default: "" }),
	models: Type.Array(Type.String(), {
		default: ["gpt-4.1", "gpt-4o", "gpt-4o-mini", "o3", "o4-mini"],
	}),
});

const GoogleProviderSchema = Type.Object({
	apiKey: Type.String({ default: "" }),
	models: Type.Array(Type.String(), {
		default: ["gemini-2.5-pro", "gemini-2.5-flash"],
	}),
});

const ZhipuProviderSchema = Type.Object({
	apiKey: Type.String({ default: "" }),
	mode: Type.Union(
		[
			Type.Literal("api"),
			Type.Literal("coding-plan"),
			Type.Literal("coding-global"),
			Type.Literal("global"),
		],
		{ default: "coding-plan" },
	),
	models: Type.Array(Type.String(), {
		default: ["glm-5.1", "glm-5", "glm-5-turbo", "glm-5v-turbo", "glm-4.6v"],
	}),
});

const OpenRouterProviderSchema = Type.Object({
	apiKey: Type.String({ default: "" }),
});

const DeepSeekProviderSchema = Type.Object({
	apiKey: Type.String({ default: "" }),
	models: Type.Array(Type.String(), {
		default: ["deepseek-chat", "deepseek-reasoner"],
	}),
});

const MistralProviderSchema = Type.Object({
	apiKey: Type.String({ default: "" }),
	models: Type.Array(Type.String(), {
		default: ["mistral-large-3", "mistral-small-4", "codestral-25-08"],
	}),
});

const XaiProviderSchema = Type.Object({
	apiKey: Type.String({ default: "" }),
	models: Type.Array(Type.String(), {
		default: ["grok-4.20-0309-reasoning", "grok-4-1-fast-reasoning"],
	}),
});

const CohereProviderSchema = Type.Object({
	apiKey: Type.String({ default: "" }),
	models: Type.Array(Type.String(), {
		default: ["command-a-03-2025", "command-a-vision-07-2025"],
	}),
});

const LocalProviderSchema = Type.Object({
	baseUrl: Type.String({ default: "http://localhost:11434" }),
	models: Type.Array(Type.String(), {
		default: ["llama3.1", "codellama", "mistral", "qwen2.5"],
	}),
});

const ProvidersSchema = Type.Object({
	anthropic: AnthropicProviderSchema,
	openai: OpenAIProviderSchema,
	google: GoogleProviderSchema,
	zhipu: ZhipuProviderSchema,
	openrouter: OpenRouterProviderSchema,
	deepseek: DeepSeekProviderSchema,
	mistral: MistralProviderSchema,
	xai: XaiProviderSchema,
	cohere: CohereProviderSchema,
	local: LocalProviderSchema,
});

const AiSchema = Type.Object({
	default: Type.String({ default: "zhipu/glm-5.1" }),
	fallback: Type.String({ default: "openai/gpt-4.1" }),
	providers: ProvidersSchema,
	thinking: Type.Union(
		[
			Type.Literal("none"),
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
		],
		{ default: "medium" },
	),
	maxTokens: Type.Number({ default: 16384 }),
});

const ChannelSchema = Type.Object({
	enabled: Type.Boolean({ default: false }),
	botToken: Type.Optional(Type.String()),
	signingSecret: Type.Optional(Type.String()),
	appToken: Type.Optional(Type.String()),
});

const ChannelsSchema = Type.Object({
	whatsapp: ChannelSchema,
	telegram: ChannelSchema,
	discord: ChannelSchema,
	slack: ChannelSchema,
	teams: ChannelSchema,
	signal: ChannelSchema,
	wechat: ChannelSchema,
	webchat: Type.Object({ enabled: Type.Boolean({ default: true }) }),
});

const ConnectionSchema = Type.Object({
	autoProxy: Type.Boolean({ default: true }),
	retryMaxAttempts: Type.Number({ default: 5 }),
	retryBaseDelay: Type.Number({ default: 1000 }),
	circuitBreakerThreshold: Type.Number({ default: 5 }),
	healthCheckInterval: Type.Number({ default: 30000 }),
	offlineQueueSize: Type.Number({ default: 1000 }),
	preferIPv4: Type.Boolean({ default: true }),
});

const ShortTermSchema = Type.Object({
	maxTokens: Type.Number({ default: 8192 }),
	scratchPadSize: Type.Number({ default: 2048 }),
	autoEviction: Type.Boolean({ default: true }),
});

const EpisodicSchema = Type.Object({
	decayRate: Type.Number({ default: 0.003 }),
	compressionAfter: Type.String({ default: "30d" }),
	maxAge: Type.String({ default: "365d" }),
});

const SemanticSchema = Type.Object({
	decayRate: Type.Number({ default: 0.0001 }),
	contradictionCheck: Type.Boolean({ default: true }),
});

const AssociativeSchema = Type.Object({
	enabled: Type.Boolean({ default: true }),
	cascadeDepth: Type.Number({ default: 2 }),
	cascadeThreshold: Type.Number({ default: 0.8 }),
});

const LongTermSchema = Type.Object({
	backend: Type.String({ default: "sqlite-vss" }),
	importanceThreshold: Type.Number({ default: 0.5 }),
	maxItems: Type.Number({ default: 100000 }),
	episodic: EpisodicSchema,
	semantic: SemanticSchema,
	associative: AssociativeSchema,
});

const ConsolidationSchema = Type.Object({
	trigger: Type.String({ default: "task-complete" }),
	idleInterval: Type.String({ default: "30m" }),
	batchSize: Type.Number({ default: 50 }),
	extractFacts: Type.Boolean({ default: true }),
	extractEvents: Type.Boolean({ default: true }),
	extractProcedures: Type.Boolean({ default: true }),
	buildAssociations: Type.Boolean({ default: true }),
	compressAndDecay: Type.Boolean({ default: true }),
});

const RetrievalSchema = Type.Object({
	maxResults: Type.Number({ default: 10 }),
	maxTokens: Type.Number({ default: 2000 }),
	minRelevance: Type.Number({ default: 0.6 }),
	weights: Type.Object({
		relevance: Type.Number({ default: 0.5 }),
		recency: Type.Number({ default: 0.3 }),
		frequency: Type.Number({ default: 0.2 }),
	}),
});

const MemorySchema = Type.Object({
	enabled: Type.Boolean({ default: true }),
	shortTerm: ShortTermSchema,
	longTerm: LongTermSchema,
	consolidation: ConsolidationSchema,
	retrieval: RetrievalSchema,
});

const ForgeSchema = Type.Object({
	complexityThreshold: Type.Number({ default: 0.6 }),
	selfCritique: Type.Boolean({ default: true }),
	minQualityScore: Type.Number({ default: 7 }),
	includeExamples: Type.Boolean({ default: true }),
	includeTemplates: Type.Boolean({ default: true }),
	includeAntiPatterns: Type.Boolean({ default: true }),
});

const ImprovementSchema = Type.Object({
	triggerOnSuccessRate: Type.Number({ default: 0.7 }),
	triggerOnRating: Type.Number({ default: 3.5 }),
	reviewEveryNUses: Type.Number({ default: 10 }),
	abTestMajorChanges: Type.Boolean({ default: true }),
	abTestSampleSize: Type.Number({ default: 20 }),
});

const LoadingSchema = Type.Object({
	maxTokenBudget: Type.Number({ default: 3000 }),
	progressiveLevels: Type.Boolean({ default: true }),
	autoUnload: Type.Boolean({ default: true }),
	searchThreshold: Type.Number({ default: 0.7 }),
});

const RegistrySchema = Type.Object({
	path: Type.String({ default: "~/.octopus/skills" }),
	builtinSkills: Type.Array(Type.String(), {
		default: ["general-reasoning", "code-generation", "writing", "research"],
	}),
});

const SkillsSchema = Type.Object({
	enabled: Type.Boolean({ default: true }),
	autoCreate: Type.Boolean({ default: true }),
	autoImprove: Type.Boolean({ default: true }),
	forge: ForgeSchema,
	improvement: ImprovementSchema,
	loading: LoadingSchema,
	registry: RegistrySchema,
});

const PluginsSchema = Type.Object({
	directories: Type.Array(Type.String(), { default: ["~/.octopus/plugins"] }),
	builtin: Type.Array(Type.String(), { default: ["productivity", "coding"] }),
});

const StorageSchema = Type.Object({
	backend: Type.String({ default: "sqlite" }),
	path: Type.String({ default: "~/.octopus/data/octopus.db" }),
});

const SecuritySchema = Type.Object({
	encryptionKey: Type.String({ default: "" }),
	allowedPaths: Type.Array(Type.String(), {
		default: ["~/Documents", "~/Desktop"],
	}),
	sandboxCommands: Type.Boolean({ default: true }),
});

const MCPServerEntrySchema = Type.Object({
	command: Type.String(),
	args: Type.Array(Type.String(), { default: [] }),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
});

const MCPchema = Type.Object({
	servers: Type.Record(Type.String(), MCPServerEntrySchema, { default: {} }),
});

export const ConfigSchema = Type.Object({
	version: Type.Number({ default: 1 }),
	server: ServerSchema,
	ai: AiSchema,
	channels: ChannelsSchema,
	connection: ConnectionSchema,
	memory: MemorySchema,
	skills: SkillsSchema,
	plugins: PluginsSchema,
	storage: StorageSchema,
	security: SecuritySchema,
	mcp: Type.Optional(MCPchema),
});

export type OctopusConfig = Static<typeof ConfigSchema>;
