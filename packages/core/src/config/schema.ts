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

const BrowserSchema = Type.Object({
	headless: Type.Boolean({ default: false }),
	userDataDir: Type.Optional(Type.String()),
	chromiumSandbox: Type.Optional(Type.Boolean()),
	nativeFingerprint: Type.Boolean({ default: true }),
	stealth: Type.Boolean({ default: false }),
	provider: Type.Union(
		[
			Type.Literal("embedded"),
			Type.Literal("brightdata"),
			Type.Literal("decodo"),
			Type.Literal("auto"),
		],
		{ default: "auto" },
	),
	brightDataEnabled: Type.Boolean({ default: true }),
	brightDataWsUrl: Type.Optional(Type.String()),
	decodoEnabled: Type.Boolean({ default: true }),
	decodoProxyUrl: Type.Optional(Type.String()),
	decodoProxyUsername: Type.Optional(Type.String()),
	decodoProxyPassword: Type.Optional(Type.String()),
	decodoProxyCountry: Type.Optional(Type.String()),
	decodoProxyCity: Type.Optional(Type.String()),
	decodoProxyState: Type.Optional(Type.String()),
	decodoProxyZip: Type.Optional(Type.String()),
	decodoProxySession: Type.Optional(Type.String()),
	decodoProxySessionDuration: Type.Optional(Type.String()),
	decodoScraperToken: Type.Optional(Type.String()),
	decodoScraperUsername: Type.Optional(Type.String()),
	decodoScraperPassword: Type.Optional(Type.String()),
	solveCaptchas: Type.Boolean({ default: true }),
	captchaProvider: Type.Union([Type.Literal("2captcha")], {
		default: "2captcha",
	}),
	captchaTimeoutMs: Type.Number({ default: 120000 }),
	captchaApiKey: Type.Optional(Type.String()),
	persistCookies: Type.Boolean({ default: true }),
	sessionStorageDir: Type.Optional(Type.String()),
	sessionTtlHours: Type.Number({ default: 168 }),
	autoFallbackOnBlock: Type.Boolean({ default: false }),
	blockFallbackProvider: Type.Union(
		[
			Type.Literal("brightdata"),
			Type.Literal("decodo"),
			Type.Literal("embedded"),
		],
		{ default: "decodo" },
	),
	confirmBlockWithVision: Type.Boolean({ default: true }),
	blockResources: Type.Array(Type.String(), {
		default: [],
	}),
	blockTrackerDomains: Type.Boolean({ default: false }),
	humanBehavior: Type.Boolean({ default: true }),
	autoDismissPopups: Type.Boolean({ default: true }),
});

const AnthropicProviderSchema = Type.Object({
	apiKey: Type.String({ default: "" }),
	apiKeyEnv: Type.Optional(Type.String()),
	baseUrl: Type.String({ default: "https://api.anthropic.com/v1" }),
	authMode: Type.Optional(
		Type.Union([
			Type.Literal("api-key"),
			Type.Literal("bearer"),
			Type.Literal("oauth"),
		]),
	),
	oauthClientId: Type.Optional(Type.String()),
	oauthClientSecret: Type.Optional(Type.String()),
	oauthAccessToken: Type.Optional(Type.String()),
	oauthRefreshToken: Type.Optional(Type.String()),
	oauthExpiresAt: Type.Optional(Type.Number()),
	browserCookies: Type.Optional(Type.String()),
	browserUserAgent: Type.Optional(Type.String()),
	models: Type.Array(Type.String(), {
		default: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
	}),
});

const OpenAIProviderSchema = Type.Object({
	apiKey: Type.String({ default: "" }),
	apiKeyEnv: Type.Optional(Type.String()),
	baseUrl: Type.String({ default: "https://api.openai.com/v1" }),
	authMode: Type.Optional(
		Type.Union([
			Type.Literal("api-key"),
			Type.Literal("codex"),
			Type.Literal("oauth"),
			Type.Literal("browser"),
		]),
	),
	accessToken: Type.Optional(Type.String()),
	accessTokenEnv: Type.Optional(Type.String()),
	// ChatGPT account id (from the Codex login id_token) — required by the Codex
	// backend (Responses API + image generation) when authMode is "codex".
	accountId: Type.Optional(Type.String()),
	oauthClientId: Type.Optional(Type.String()),
	oauthClientSecret: Type.Optional(Type.String()),
	oauthAccessToken: Type.Optional(Type.String()),
	oauthRefreshToken: Type.Optional(Type.String()),
	oauthExpiresAt: Type.Optional(Type.Number()),
	browserCookies: Type.Optional(Type.String()),
	browserUserAgent: Type.Optional(Type.String()),
	models: Type.Array(Type.String(), {
		default: ["gpt-4.1", "gpt-4o", "gpt-4o-mini", "o3", "o4-mini"],
	}),
});

// Google Gemini — API key only (separate from Vertex AI).
const GeminiProviderSchema = Type.Object({
	apiKey: Type.String({ default: "" }),
	apiKeyEnv: Type.Optional(Type.String()),
	baseUrl: Type.Optional(Type.String()),
	models: Type.Array(Type.String(), {
		default: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
	}),
});

// Google Vertex AI — service account / gcloud credentials.
const VertexProviderSchema = Type.Object({
	projectId: Type.Optional(Type.String()),
	location: Type.Optional(Type.String()),
	credentialsFile: Type.Optional(Type.String()),
	credentialsJson: Type.Optional(Type.String()),
	accessToken: Type.Optional(Type.String()),
	accessTokenEnv: Type.Optional(Type.String()),
	apiKeyEnv: Type.Optional(Type.String()),
	baseUrl: Type.Optional(Type.String()),
	// Transient OAuth fields used during auto-provisioning (replaced by the
	// service-account key once created).
	oauthAccessToken: Type.Optional(Type.String()),
	oauthRefreshToken: Type.Optional(Type.String()),
	oauthClientId: Type.Optional(Type.String()),
	oauthClientSecret: Type.Optional(Type.String()),
	oauthExpiresAt: Type.Optional(Type.Number()),
	models: Type.Array(Type.String(), {
		default: [
			"gemini-3.5-flash",
			"gemini-3-flash-preview",
			"gemini-3.1-pro-preview",
			"gemini-3.1-flash-lite",
			"gemini-2.5-pro",
			"gemini-2.5-flash",
			"gemini-2.5-flash-lite",
			"gemini-2.0-flash",
			"gemini-2.0-flash-lite",
		],
	}),
});

// Legacy shape kept only so the config loader can read & migrate old
// `ai.providers.google` entries into `gemini` / `vertex`.
const GoogleProviderSchema = Type.Object({
	apiKey: Type.Optional(Type.String()),
	apiKeyEnv: Type.Optional(Type.String()),
	baseUrl: Type.Optional(Type.String()),
	authMode: Type.Optional(Type.String()),
	accessToken: Type.Optional(Type.String()),
	accessTokenEnv: Type.Optional(Type.String()),
	credentialsFile: Type.Optional(Type.String()),
	credentialsJson: Type.Optional(Type.String()),
	projectId: Type.Optional(Type.String()),
	location: Type.Optional(Type.String()),
	oauthAccessToken: Type.Optional(Type.String()),
	oauthRefreshToken: Type.Optional(Type.String()),
	oauthClientId: Type.Optional(Type.String()),
	oauthClientSecret: Type.Optional(Type.String()),
	oauthExpiresAt: Type.Optional(Type.Number()),
	models: Type.Optional(Type.Array(Type.String())),
});

const ZhipuProviderSchema = Type.Object({
	apiKey: Type.String({ default: "" }),
	apiKeyEnv: Type.Optional(Type.String()),
	baseUrl: Type.Optional(Type.String()),
	codingApiKey: Type.Optional(Type.String()),
	codingBaseUrl: Type.Optional(Type.String()),
	mode: Type.Union(
		[
			Type.Literal("api"),
			Type.Literal("coding-plan"),
			Type.Literal("coding-global"),
			Type.Literal("global"),
		],
		{ default: "coding-global" },
	),
	models: Type.Array(Type.String(), {
		default: [
			"glm-5.2",
			"glm-5.1",
			"glm-5",
			"glm-5-turbo",
			"glm-5v-turbo",
			"glm-4.6",
			"glm-4.6v",
		],
	}),
});

const OpenRouterProviderSchema = Type.Object({
	apiKey: Type.String({ default: "" }),
	apiKeyEnv: Type.Optional(Type.String()),
	baseUrl: Type.String({ default: "https://openrouter.ai/api/v1" }),
	models: Type.Array(Type.String(), {
		default: [
			"openai/gpt-4.1",
			"anthropic/claude-sonnet-4-6",
			"google/gemini-2.5-pro",
		],
	}),
});

const DeepSeekProviderSchema = Type.Object({
	apiKey: Type.String({ default: "" }),
	apiKeyEnv: Type.Optional(Type.String()),
	baseUrl: Type.String({ default: "https://api.deepseek.com" }),
	authMode: Type.Optional(
		Type.Union([Type.Literal("api-key"), Type.Literal("browser")]),
	),
	accessToken: Type.Optional(Type.String()),
	browserCookies: Type.Optional(Type.String()),
	browserUserAgent: Type.Optional(Type.String()),
	models: Type.Array(Type.String(), {
		default: ["deepseek-chat", "deepseek-reasoner"],
	}),
});

const MistralProviderSchema = Type.Object({
	apiKey: Type.String({ default: "" }),
	apiKeyEnv: Type.Optional(Type.String()),
	baseUrl: Type.String({ default: "https://api.mistral.ai/v1" }),
	models: Type.Array(Type.String(), {
		default: ["mistral-large-3", "mistral-small-4", "codestral-25-08"],
	}),
});

const XaiProviderSchema = Type.Object({
	apiKey: Type.String({ default: "" }),
	apiKeyEnv: Type.Optional(Type.String()),
	baseUrl: Type.String({ default: "https://api.x.ai/v1" }),
	authMode: Type.Optional(
		Type.Union([Type.Literal("api-key"), Type.Literal("browser")]),
	),
	accessToken: Type.Optional(Type.String()),
	browserCookies: Type.Optional(Type.String()),
	browserUserAgent: Type.Optional(Type.String()),
	models: Type.Array(Type.String(), {
		default: ["grok-4.20-0309-reasoning", "grok-4-1-fast-reasoning"],
	}),
});

const CohereProviderSchema = Type.Object({
	apiKey: Type.String({ default: "" }),
	apiKeyEnv: Type.Optional(Type.String()),
	baseUrl: Type.String({ default: "https://api.cohere.com/v2" }),
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
	gemini: GeminiProviderSchema,
	vertex: VertexProviderSchema,
	zhipu: ZhipuProviderSchema,
	openrouter: OpenRouterProviderSchema,
	deepseek: DeepSeekProviderSchema,
	mistral: MistralProviderSchema,
	xai: XaiProviderSchema,
	cohere: CohereProviderSchema,
	local: LocalProviderSchema,
});

const AiSchema = Type.Object({
	default: Type.String({ default: "zhipu/glm-5.2" }),
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
	streamReadTimeoutMs: Type.Optional(
		Type.Number({ default: 120000, minimum: 1000 }),
	),
	streamReadTimeoutLocalMs: Type.Optional(
		Type.Number({ default: 1800000, minimum: 1000 }),
	),
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
	teams: Type.Optional(ChannelSchema),
	signal: Type.Optional(ChannelSchema),
	wechat: Type.Optional(ChannelSchema),
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

const VectorStoreSchema = Type.Object({
	url: Type.String({ default: "" }),
	apiKey: Type.String({ default: "" }),
	collection: Type.String({ default: "octopus_memory" }),
	timeoutMs: Type.Number({ default: 10000, minimum: 1 }),
	maxRetries: Type.Number({ default: 2, minimum: 0 }),
	retryBaseDelayMs: Type.Number({ default: 100, minimum: 0 }),
	dimension: Type.Optional(Type.Number({ minimum: 1 })),
	database: Type.Optional(Type.String()),
	ssl: Type.Optional(Type.Boolean()),
});

const LongTermSchema = Type.Object({
	backend: Type.String({ default: "sqlite-vss" }),
	vectorStore: VectorStoreSchema,
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

const EmbeddingsSchema = Type.Object({
	enabled: Type.Boolean({ default: false }),
	provider: Type.Union(
		[
			Type.Literal("auto"),
			Type.Literal("zhipu"),
			Type.Literal("openai"),
			Type.Literal("google"),
			Type.Literal("deepseek"),
			Type.Literal("mistral"),
			Type.Literal("xai"),
			Type.Literal("cohere"),
			Type.Literal("ollama"),
		],
		{ default: "auto" },
	),
	apiType: Type.Union(
		[
			Type.Literal("openai"),
			Type.Literal("google"),
			Type.Literal("cohere"),
			Type.Literal("ollama"),
		],
		{ default: "openai" },
	),
	authMode: Type.Optional(
		Type.Union([Type.Literal("api-key"), Type.Literal("vertex")]),
	),
	model: Type.String({ default: "" }),
	baseUrl: Type.String({ default: "" }),
	apiKey: Type.String({ default: "" }),
	apiKeyEnv: Type.String({ default: "" }),
	accessToken: Type.Optional(Type.String()),
	accessTokenEnv: Type.Optional(Type.String()),
	credentialsFile: Type.Optional(Type.String()),
	credentialsJson: Type.Optional(Type.String()),
	projectId: Type.Optional(Type.String()),
	location: Type.Optional(Type.String()),
	task: Type.Union(
		[Type.Literal("document"), Type.Literal("query"), Type.Literal("none")],
		{ default: "document" },
	),
	dimensions: Type.Number({ default: 1024, minimum: 1 }),
	maxBatchSize: Type.Number({ default: 32, minimum: 1 }),
	maxTextLength: Type.Number({ default: 8000, minimum: 1 }),
	cacheSize: Type.Number({ default: 500, minimum: 1 }),
	failureRetryMs: Type.Number({ default: 60000, minimum: 0 }),
});

const RetentionSchema = Type.Object({
	enabled: Type.Boolean({ default: false }),
	cron: Type.String({ default: "30 3 * * *" }),
	unusedDays: Type.Number({ default: 90, minimum: 1 }),
	lowImportanceThreshold: Type.Number({ default: 0.25, minimum: 0 }),
	contradictionGraceDays: Type.Number({ default: 14, minimum: 0 }),
});

const MemorySchema = Type.Object({
	enabled: Type.Boolean({ default: true }),
	shortTerm: ShortTermSchema,
	longTerm: LongTermSchema,
	consolidation: ConsolidationSchema,
	retrieval: RetrievalSchema,
	embeddings: EmbeddingsSchema,
	retention: RetentionSchema,
});

const ForgeSchema = Type.Object({
	complexityThreshold: Type.Number({ default: 0.6 }),
	selfCritique: Type.Boolean({ default: true }),
	minQualityScore: Type.Number({ default: 7 }),
	includeExamples: Type.Boolean({ default: true }),
	includeTemplates: Type.Boolean({ default: true }),
	includeAntiPatterns: Type.Boolean({ default: true }),
	llmGeneration: Type.Boolean({ default: true }),
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

const Context7Schema = Type.Object({
	enabled: Type.Boolean({ default: true }),
	mcpServer: Type.String({ default: "context7" }),
	httpEndpoint: Type.String({ default: "https://context7.com" }),
	apiKey: Type.Optional(Type.String()),
	timeoutMs: Type.Number({ default: 8000 }),
});

const ResearchSchema = Type.Object({
	enabled: Type.Boolean({ default: true }),
	onlyTechnical: Type.Boolean({ default: true }),
	useLlmClassifier: Type.Boolean({ default: false }),
	context7: Context7Schema,
	webSearchTool: Type.String({ default: "zai-web-search" }),
	webReaderTool: Type.String({ default: "zai-web-reader" }),
	browserFetchTool: Type.String({ default: "browser_navigate" }),
	maxContextTokens: Type.Number({ default: 2000 }),
	maxSources: Type.Number({ default: 4 }),
});

const SkillsSchema = Type.Object({
	enabled: Type.Boolean({ default: true }),
	autoCreate: Type.Boolean({ default: true }),
	autoImprove: Type.Boolean({ default: true }),
	forge: ForgeSchema,
	improvement: ImprovementSchema,
	loading: LoadingSchema,
	registry: RegistrySchema,
	research: Type.Optional(ResearchSchema),
});

const LearningSchema = Type.Object({
	enabled: Type.Boolean({ default: true }),
	autoReflect: Type.Boolean({ default: true }),
	minConfidenceToStore: Type.Number({ default: 0.65 }),
	minConfidenceToInject: Type.Number({ default: 0.55 }),
	maxInsightsPerContext: Type.Number({ default: 5 }),
	maxContextTokens: Type.Number({ default: 1000 }),
	autoCreateSkills: Type.Boolean({ default: true }),
	minSimilarSuccessesForSkill: Type.Number({ default: 3 }),
	retainFailedInsights: Type.Boolean({ default: true }),
});

const PluginsSchema = Type.Object({
	directories: Type.Array(Type.String(), { default: ["~/.octopus/plugins"] }),
	builtin: Type.Array(Type.String(), { default: ["productivity", "coding"] }),
});

const StorageSchema = Type.Object({
	backend: Type.String({ default: "sqlite" }),
	path: Type.String({ default: "~/.octopus/data/octopus.db" }),
	connectionString: Type.String({ default: "" }),
	ssl: Type.Boolean({ default: false }),
});

const SecuritySchema = Type.Object({
	encryptionKey: Type.String({ default: "" }),
	memoryApiKey: Type.String({ default: "" }),
	allowedPaths: Type.Array(Type.String(), {
		default: ["~/Documents", "~/Desktop"],
	}),
	sandboxCommands: Type.Boolean({ default: true }),
	commandApproval: Type.Object({
		mode: Type.Union(
			[Type.Literal("manual"), Type.Literal("smart"), Type.Literal("off")],
			{ default: "smart" },
		),
		timeoutMs: Type.Number({ default: 30000, minimum: 1000 }),
		allowlist: Type.Array(Type.String(), { default: [] }),
	}),
	redaction: Type.Object({
		enabled: Type.Boolean({ default: true }),
		mask: Type.String({ default: "[REDACTED]" }),
		extraSecretKeys: Type.Array(Type.String(), { default: [] }),
	}),
	urlPolicy: Type.Object({
		enabled: Type.Boolean({ default: true }),
		allowedProtocols: Type.Array(Type.String(), {
			default: ["https:", "http:"],
		}),
		allowPrivateNetworks: Type.Boolean({ default: false }),
		dnsLookup: Type.Object({
			enabled: Type.Boolean({ default: true }),
			failClosed: Type.Boolean({ default: true }),
		}),
		blocklist: Type.Array(Type.String(), { default: [] }),
		allowlist: Type.Array(Type.String(), { default: [] }),
	}),
	envFiltering: Type.Object({
		enabled: Type.Boolean({ default: true }),
		allowlist: Type.Array(Type.String(), { default: [] }),
		blocklist: Type.Array(Type.String(), { default: [] }),
	}),
	contentScanning: Type.Object({
		enabled: Type.Boolean({ default: true }),
		mode: Type.Union(
			[Type.Literal("report"), Type.Literal("annotate"), Type.Literal("block")],
			{ default: "annotate" },
		),
		blockSeverity: Type.Union(
			[Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")],
			{ default: "high" },
		),
		extraPatterns: Type.Array(Type.String(), { default: [] }),
	}),
});

const MCPServerEntrySchema = Type.Object({
	type: Type.Optional(Type.String()),
	url: Type.Optional(Type.String()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	command: Type.Optional(Type.String()),
	args: Type.Array(Type.String(), { default: [] }),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
	enabled: Type.Optional(Type.Boolean()),
});

const ContinuityGuardSchema = Type.Object({
	enabled: Type.Boolean({ default: true }),
	maxAutoContinuations: Type.Integer({ default: 25, minimum: 1 }),
	truncationDetection: Type.Boolean({ default: true }),
	stallDetection: Type.Optional(Type.Boolean({ default: true })),
	maxStallForcings: Type.Optional(Type.Integer({ default: 3, minimum: 0 })),
	stallSignatureHistory: Type.Optional(
		Type.Integer({ default: 4, minimum: 1 }),
	),
});

const MCPchema = Type.Object({
	servers: Type.Record(Type.String(), MCPServerEntrySchema, { default: {} }),
	autoDisabled: Type.Array(Type.String(), { default: [] }),
});

const ToolIterationLimitSchema = Type.Object({
	enabled: Type.Boolean({ default: true }),
	maxIterations: Type.Integer({ default: 256, minimum: 1 }),
	/**
	 * When true, suppress the per-tool-result "Remaining tool budget" reminder
	 * injected into the model context. HermesAgent removed mid-task budget
	 * reminders (April 2026) because they nudged models to abandon complex
	 * tasks prematurely. Default false preserves prior behavior.
	 */
	suppressPressureReminders: Type.Optional(Type.Boolean({ default: false })),
});

const ToolResultTruncationSchema = Type.Object({
	maxTokens: Type.Integer({ default: 4000, minimum: 256 }),
	maxCharsCeiling: Type.Integer({ default: 12000, minimum: 1000 }),
});

const ToolTimeoutsSchema = Type.Object({
	defaultMs: Type.Number({ default: 45000, minimum: 1000 }),
	longRunningMs: Type.Number({ default: 90000, minimum: 1000 }),
	captchaMs: Type.Number({ default: 150000, minimum: 1000 }),
	scrapingMs: Type.Number({ default: 165000, minimum: 1000 }),
	byTool: Type.Record(Type.String(), Type.Number({ minimum: 1000 }), {
		default: {},
	}),
});

const ToolRateLimitRuleSchema = Type.Object({
	minIntervalMs: Type.Number({ default: 3000, minimum: 0 }),
	maxConcurrent: Type.Integer({ default: 1, minimum: 1 }),
	queueTimeoutMs: Type.Number({ default: 600000, minimum: 1000 }),
});

const ToolRateLimitsSchema = Type.Object({
	enabled: Type.Boolean({ default: true }),
	mediaDefault: ToolRateLimitRuleSchema,
	byTool: Type.Record(Type.String(), ToolRateLimitRuleSchema, { default: {} }),
});

const ToolsConfigSchema = Type.Object({
	disabled: Type.Array(Type.String(), { default: [] }),
	iterationLimit: ToolIterationLimitSchema,
	resultTruncation: ToolResultTruncationSchema,
	timeouts: ToolTimeoutsSchema,
	rateLimits: Type.Optional(ToolRateLimitsSchema),
});

const OrchestrationConfigSchema = Type.Object({
	enabled: Type.Boolean({ default: true }),
	mode: Type.Union(
		[Type.Literal("durable"), Type.Literal("legacy"), Type.Literal("hybrid")],
		{ default: "durable" },
	),
	maxArms: Type.Integer({ default: 8, minimum: 1, maximum: 8 }),
	workerTimeoutMs: Type.Number({ default: 600000, minimum: 1000 }),
	maxToolIterationsPerArm: Type.Integer({ default: 32, minimum: 1 }),
	maxIterationsPerRun: Type.Optional(
		Type.Integer({ default: 192, minimum: 1 }),
	),
	decompositionTimeoutMs: Type.Number({ default: 30000, minimum: 1000 }),
	synthesisTimeoutMs: Type.Number({ default: 10000, minimum: 1000 }),
	synthesisMaxTokens: Type.Integer({ default: 1200, minimum: 128 }),
	maxStagnantAttempts: Type.Integer({ default: 5, minimum: 1 }),
	maxSpawnDepth: Type.Integer({ default: 2, minimum: 0, maximum: 5 }),
	enableDynamicAssessment: Type.Optional(Type.Boolean({ default: false })),
	assessmentModel: Type.Optional(Type.String()),
	assessmentTimeoutMs: Type.Optional(
		Type.Number({ default: 6000, minimum: 1000 }),
	),
	assessmentMinLengthForLlm: Type.Optional(
		Type.Integer({ default: 40, minimum: 1 }),
	),
});

const MascotIdSchema = Type.Union(
	[
		Type.Literal("abeja-bibi"),
		Type.Literal("anemona-anita"),
		Type.Literal("arana-ari"),
		Type.Literal("calamar-cali"),
		Type.Literal("cangrejo-crabby"),
		Type.Literal("estrella-estelita"),
		Type.Literal("langosta-langi"),
		Type.Literal("medusa-medi"),
		Type.Literal("pulpo-octavio"),
	],
	{ default: "pulpo-octavio" },
);

const MascotsConfigSchema = Type.Object({
	defaultId: MascotIdSchema,
});

const TenacidadSchema = Type.Object({
	level: Type.Union([Type.Literal("normal"), Type.Literal("tenaz")], {
		default: "default",
	}),
	maxGenuineApiErrors: Type.Integer({ default: 3, minimum: 1 }),
	streamErrorRetries: Type.Integer({ default: 3, minimum: 0, maximum: 10 }),
	emptyResponseRetries: Type.Integer({ default: 3, minimum: 0, maximum: 10 }),
});

// Health/quota probing for external web tools (search + reader MCP servers).
// The agent consults this before calling a tool so it can steer directly to a
// fallback (browser_search / pdf_read) instead of wasting turns discovering an
// out-of-quota failure at call time.
const WebToolsHealthBreakerSchema = Type.Object({
	consecutiveFailures: Type.Integer({ default: 4, minimum: 1 }),
	windowMinutes: Type.Integer({ default: 10, minimum: 1 }),
});

const WebToolsHealthSchema = Type.Object({
	enabled: Type.Boolean({ default: false }),
	probeOnStartup: Type.Boolean({ default: true }),
	probeCron: Type.String({ default: "17 3 * * *" }),
	cacheTtlMinutes: Type.Integer({ default: 360, minimum: 5 }),
	breaker: WebToolsHealthBreakerSchema,
});

const CompressionSchema = Type.Object({
	threshold: Type.Number({ default: 0.8, minimum: 0.1, maximum: 0.99 }),
	targetRatio: Type.Number({ default: 0.3, minimum: 0.05, maximum: 0.95 }),
	protectLastN: Type.Integer({ default: 20, minimum: 1 }),
	protectFirstN: Type.Integer({ default: 0, minimum: 0 }),
	outputReserve: Type.Integer({ default: 16384, minimum: 1024 }),
	summaryMaxTokens: Type.Integer({ default: 4096, minimum: 256 }),
	condenseMaxTokens: Type.Integer({ default: 2048, minimum: 256 }),
	hygieneHardMessageLimit: Type.Integer({ default: 5000, minimum: 0 }),
});

const ContextSchema = Type.Object({
	compression: CompressionSchema,
});

const ToolLoopGuardrailsSchema = Type.Object({
	warningsEnabled: Type.Boolean({ default: true }),
	hardStopEnabled: Type.Boolean({ default: false }),
	/** Swarm workers circuit-break on hard-stop (unattended) while the interactive loop warns only. */
	workerHardStopEnabled: Type.Optional(Type.Boolean({ default: true })),
	warnAfter: Type.Object({
		exactFailure: Type.Integer({ default: 2, minimum: 1 }),
		sameToolFailure: Type.Integer({ default: 3, minimum: 1 }),
		idempotentNoProgress: Type.Integer({ default: 2, minimum: 1 }),
	}),
	hardStopAfter: Type.Object({
		exactFailure: Type.Integer({ default: 5, minimum: 1 }),
		sameToolFailure: Type.Integer({ default: 8, minimum: 1 }),
		idempotentNoProgress: Type.Integer({ default: 5, minimum: 1 }),
	}),
});

export const ConfigSchema = Type.Object({
	version: Type.Number({ default: 1 }),
	server: ServerSchema,
	browser: BrowserSchema,
	mascots: MascotsConfigSchema,
	ai: AiSchema,
	channels: ChannelsSchema,
	connection: ConnectionSchema,
	memory: MemorySchema,
	skills: SkillsSchema,
	learning: LearningSchema,
	plugins: PluginsSchema,
	storage: StorageSchema,
	security: SecuritySchema,
	tools: ToolsConfigSchema,
	context: Type.Optional(ContextSchema),
	orchestration: Type.Optional(OrchestrationConfigSchema),
	continuityGuard: Type.Optional(ContinuityGuardSchema),
	toolLoopGuardrails: Type.Optional(ToolLoopGuardrailsSchema),
	tenacidad: Type.Optional(TenacidadSchema),
	mcp: Type.Optional(MCPchema),
	webToolsHealth: Type.Optional(WebToolsHealthSchema),
});

export type OctopusConfig = Static<typeof ConfigSchema>;
