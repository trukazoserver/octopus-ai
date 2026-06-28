import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import * as os from "node:os";
import { join } from "node:path";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	AgentManager,
	AgentMessageBus,
	AgentRuntime,
	ArtifactVerifier,
	AutomationManager,
	AutomationRunner,
	BrowserTool,
	ChatManager,
	CodeExecutor,
	ConfigLoader,
	ConnectionManager,
	ContextAssembler,
	EmbeddingProvider,
	EnvVarManager,
	EnvironmentFilter,
	EventStream,
	FTSSearchEngine,
	GlobalDailyMemory,
	KanbanDispatcher,
	KanbanPlanner,
	KnowledgeManager,
	LLMRouter,
	LearningEngine,
	LongTermMemory,
	MCPManager,
	MemoryConsolidator,
	MemoryOrchestrator,
	MemoryRetentionScheduler,
	MemoryRetrieval,
	PluginMarketplace,
	PluginRegistry,
	RequirementResolver,
	Scheduler,
	SecretRedactor,
	ShortTermMemory,
	SkillForge,
	SkillImprover,
	SkillLoader,
	SkillMarketplace,
	SkillRegistry,
	SkillResearcher,
	TaskManager,
	TeamBlackboard,
	TokenCounter,
	ToolExecutor,
	ToolRegistry,
	ToolHealthManager,
	PdfReader,
	UserProfileManager,
	WorkflowManager,
	WorkflowScheduler,
	createAgentCommsTools,
	createAgentSpawnTools,
	createAutomationTools,
	createConfiguredKnowledgeExtractor,
	createDatabaseAdapter,
	createFileSystemTools,
	createKanbanCardTools,
	createLogger,
	createCodexImageTools,
	createMediaTools,
	createSandboxTools,
	createShellTool,
	createTeamCommTools,
	createTeamTools,
	createVectorStore,
	createWorkflowTools,
	expandTildePath,
	generateEncryptionKey,
	getZaiMCPConfigs,
	UsageStore,
	getModelCapabilitiesFromRef,
	coerceReasoningEffort,
	handleProviderResponseHeaders,
	getCachedQuota,
	refreshCodexToken,
} from "@octopus-ai/core";
import type {
	AgentConfig,
	AgentReasoningEffort,
	AgentRecord,
	DatabaseAdapter,
	EmbeddingFunction,
	MCPServerConfig,
	OctopusConfig,
	ProviderConfig,
	ToolDefinition,
} from "@octopus-ai/core";

export interface OctopusSystem {
	config: OctopusConfig;
	db: DatabaseAdapter;
	router: LLMRouter;
	usageStore: UsageStore;
	stm: ShortTermMemory;
	ltm: LongTermMemory;
	dailyMemory: GlobalDailyMemory;
	userProfileManager: UserProfileManager;
	memoryOrchestrator: MemoryOrchestrator;
	memoryRetentionScheduler: MemoryRetentionScheduler;
	contextAssembler: ContextAssembler;
	memoryRetrieval: MemoryRetrieval;
	memoryConsolidator: MemoryConsolidator;
	skillRegistry: SkillRegistry;
	skillLoader: SkillLoader;
	skillForge: SkillForge;
	skillImprover: SkillImprover;
	learningEngine: LearningEngine;
	skillMarketplace: SkillMarketplace;
	agentRuntime: AgentRuntime;
	connectionManager: ConnectionManager;
	pluginRegistry: PluginRegistry;
	pluginMarketplace: PluginMarketplace;
	toolRegistry: ToolRegistry;
	toolExecutor: ToolExecutor;
	toolHealth: ToolHealthManager;
	codeExecutor: CodeExecutor;
	chatManager: ChatManager;
	agentManager: AgentManager;
	agentMessageBus: AgentMessageBus;
	workflowManager: WorkflowManager;
	workflowScheduler: WorkflowScheduler;
	requirementResolver: RequirementResolver;
	kanbanPlanner: KanbanPlanner;
	kanbanDispatcher: KanbanDispatcher;
	knowledgeManager: KnowledgeManager;
	envVarManager: EnvVarManager;
	taskManager: TaskManager;
	automationManager: AutomationManager;
	automationRunner: AutomationRunner;
	systemScheduler: Scheduler;
	mcpManager: MCPManager;
	browserTool: BrowserTool | null;
	refreshBrowserTools: (nextConfig?: OctopusConfig) => Promise<boolean>;
	refreshEmbeddingProvider: (nextConfig?: OctopusConfig) => Promise<boolean>;
	reloadDynamicTool: (name: string) => Promise<boolean>;
	embedFn: EmbeddingFunction;
	shutdown: () => Promise<void>;
}

type DynamicToolParameter = {
	type: string;
	description: string;
	required?: boolean;
};

type OptionalProviderConfig = {
	apiKey?: string;
	apiKeyEnv?: string;
	baseUrl?: string;
	authMode?: string;
	accessToken?: string;
	accessTokenEnv?: string;
	credentialsFile?: string;
	credentialsJson?: string;
	projectId?: string;
	location?: string;
};

type BrowserRuntimeConfig = {
	provider?: "auto" | "embedded" | "brightdata" | "decodo" | string;
	headless?: boolean;
	userDataDir?: string;
	chromiumSandbox?: boolean;
	nativeFingerprint?: boolean;
	stealth?: boolean;
	brightDataEnabled?: boolean;
	brightDataWsUrl?: string;
	decodoEnabled?: boolean;
	decodoProxyUrl?: string;
	decodoProxyUsername?: string;
	decodoProxyPassword?: string;
	decodoProxyCountry?: string;
	decodoProxyCity?: string;
	decodoProxyState?: string;
	decodoProxyZip?: string;
	decodoProxySession?: string;
	decodoProxySessionDuration?: string;
	decodoScraperToken?: string;
	decodoScraperUsername?: string;
	decodoScraperPassword?: string;
	solveCaptchas?: boolean;
	captchaProvider?: string;
	captchaTimeoutMs?: number;
	captchaApiKey?: string;
	persistCookies?: boolean;
	sessionStorageDir?: string;
	sessionTtlHours?: number;
	autoFallbackOnBlock?: boolean;
	blockFallbackProvider?: string;
	confirmBlockWithVision?: boolean;
	blockResources?: string[];
	blockTrackerDomains?: boolean;
	humanBehavior?: boolean;
	autoDismissPopups?: boolean;
};

const JSON_SCHEMA_TYPES = new Set([
	"string",
	"number",
	"integer",
	"boolean",
	"object",
	"array",
]);

function normalizeSchemaType(value: unknown): string {
	if (typeof value === "string" && JSON_SCHEMA_TYPES.has(value)) return value;
	if (Array.isArray(value)) {
		const firstSupported = value.find(
			(item) => typeof item === "string" && JSON_SCHEMA_TYPES.has(item),
		);
		if (typeof firstSupported === "string") return firstSupported;
	}
	return "string";
}

function normalizeDynamicToolParameters(
	parameters: unknown,
): Record<string, DynamicToolParameter> {
	if (
		!parameters ||
		typeof parameters !== "object" ||
		Array.isArray(parameters)
	) {
		return {};
	}

	const schema = parameters as Record<string, unknown>;
	const requiredFields = new Set(
		Array.isArray(schema.required)
			? schema.required.filter(
					(field): field is string => typeof field === "string",
				)
			: [],
	);
	const source =
		schema.type === "object" &&
		schema.properties &&
		typeof schema.properties === "object" &&
		!Array.isArray(schema.properties)
			? (schema.properties as Record<string, unknown>)
			: schema;

	const normalized: Record<string, DynamicToolParameter> = {};
	for (const [key, value] of Object.entries(source)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			normalized[key] = {
				type: normalizeSchemaType(value),
				description: "",
				required: requiredFields.has(key),
			};
			continue;
		}

		const param = value as Record<string, unknown>;
		normalized[key] = {
			type: normalizeSchemaType(param.type),
			description:
				typeof param.description === "string" ? param.description : "",
			required:
				typeof param.required === "boolean"
					? param.required
					: requiredFields.has(key),
		};
	}

	return normalized;
}

function createDynamicToolDefinition(
	toolDir: string,
	manifest: Record<string, unknown>,
	fallbackName: string,
): ToolDefinition {
	const toolName = String(manifest.name || fallbackName);
	const language = String(manifest.language || "javascript");
	const ext = language === "typescript" ? "mts" : "mjs";
	const codePath = join(toolDir, `index.${ext}`);
	const toolDesc = String(manifest.description || `Dynamic tool: ${toolName}`);
	const toolParams = normalizeDynamicToolParameters(manifest.parameters);
	let handlerFn:
		| ((
				params: Record<string, unknown>,
				context?: unknown,
		  ) => Promise<{
				success: boolean;
				output?: string;
				error?: string;
				metadata?: Record<string, unknown>;
		  }>)
		| null = null;
	let handlerMtimeMs = -1;

	return {
		name: toolName,
		description: toolDesc,
		uiIcon: typeof manifest.uiIcon === "string" ? manifest.uiIcon : undefined,
		parameters: toolParams,
		metadata: { source: "dynamic", path: codePath },
		handler: async (params: Record<string, unknown>, context) => {
			try {
				const mtimeMs = statSync(codePath).mtimeMs;
				if (!handlerFn || handlerMtimeMs !== mtimeMs) {
					const url = pathToFileURL(codePath);
					url.searchParams.set("mtime", String(mtimeMs));
					const mod = await import(url.href);
					handlerFn = mod.default || mod;
					handlerMtimeMs = mtimeMs;
				}
			} catch (err) {
				return {
					success: false,
					output: "",
					error: `Failed to load tool "${toolName}": ${err instanceof Error ? err.message : String(err)}`,
				};
			}

			try {
				const result = await handlerFn?.(params, context);
				return {
					success: result?.success ?? true,
					output: result?.output ?? "",
					error: result?.error,
					metadata: result?.metadata,
				};
			} catch (err) {
				return {
					success: false,
					output: "",
					error: `Tool "${toolName}" failed: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
		},
	};
}

function registerDynamicTool(
	toolRegistry: ToolRegistry,
	toolDir: string,
	fallbackName: string,
): string | null {
	const manifestPath = join(toolDir, "manifest.json");
	if (!existsSync(manifestPath)) return null;

	const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<
		string,
		unknown
	>;
	const language = String(manifest.language || "javascript");
	const ext = language === "typescript" ? "mts" : "mjs";
	const codePath = join(toolDir, `index.${ext}`);
	if (!existsSync(codePath)) return null;

	const tool = createDynamicToolDefinition(toolDir, manifest, fallbackName);
	toolRegistry.register(tool);
	return tool.name;
}

function readConfiguredEnv(name?: string): string {
	return name ? process.env[name]?.trim() || "" : "";
}

function firstNonEmpty(...values: Array<string | undefined | null>): string {
	return (
		values.find((value) => typeof value === "string" && value.trim()) ?? ""
	);
}

function isGoogleVertexConfigured(provider: OptionalProviderConfig): boolean {
	return Boolean(
		firstNonEmpty(
			provider.accessToken,
			readConfiguredEnv(provider.accessTokenEnv),
			process.env.GOOGLE_VERTEX_ACCESS_TOKEN,
			process.env.GOOGLE_ACCESS_TOKEN,
			provider.credentialsFile,
			process.env.GOOGLE_APPLICATION_CREDENTIALS,
		),
	);
}

function readServiceAccountProjectId(
	credentialsJson?: string,
	credentialsFile?: string,
): string {
	try {
		const raw = credentialsJson?.trim()
			? credentialsJson
			: credentialsFile && existsSync(credentialsFile)
				? readFileSync(credentialsFile, "utf8")
				: "";
		if (!raw) return "";
		const parsed = JSON.parse(raw) as { project_id?: string };
		return parsed.project_id?.trim() ?? "";
	} catch {
		return "";
	}
}

// --- Real Embedding Provider (Multi-Provider) ---
export function createEmbeddingProvider(
	config: OctopusConfig,
): EmbeddingProvider {
	type ApiType = "openai" | "google" | "cohere" | "ollama";
	type AuthMode = "api-key" | "vertex";

	let apiKey = "";
	let baseUrl = "";
	let model = "";
	let apiType: ApiType = "openai";
	let authMode: AuthMode = "api-key";
	let accessToken = "";
	let accessTokenEnv = "";
	let credentialsFile = "";
	let credentialsJson = "";
	let projectId = "";
	let location = "";
	let dimensions = 1024;
	let providerName = "";

	const providers = config.ai.providers;
	const optionalProviders = providers as Record<
		string,
		OptionalProviderConfig | undefined
	>;

	const embeddingConfig = config.memory.embeddings;
	const explicitApiKey = firstNonEmpty(
		embeddingConfig.apiKey,
		readConfiguredEnv(embeddingConfig.apiKeyEnv),
		process.env.OCTOPUS_EMBEDDING_API_KEY,
	);
	const embeddingsEnabled = embeddingConfig.enabled === true;
	const hasCustomDimensions = embeddingConfig.dimensions !== 1024;

	if (!embeddingsEnabled) {
		const provider = new EmbeddingProvider({
			dimensions: embeddingConfig.dimensions,
			maxBatchSize: embeddingConfig.maxBatchSize,
			maxTextLength: embeddingConfig.maxTextLength,
			cacheSize: embeddingConfig.cacheSize,
			failureRetryMs: embeddingConfig.failureRetryMs,
			task: embeddingConfig.task,
		});
		console.log(
			"  ⚠ No embedding API — using hash fallback (semantic search limited)",
		);
		return provider;
	}

	const requestedProvider = embeddingConfig.provider;
	const zhipuMode = providers.zhipu?.mode;
	const zhipuSupportsAutoEmbeddings =
		zhipuMode !== "coding-plan" && zhipuMode !== "coding-global";
	const geminiProvider = optionalProviders.gemini ?? {};
	const vertexProviderCfg = optionalProviders.vertex ?? {};
	// Merged view: api-key fields come from the `gemini` provider, Vertex
	// fields from the `vertex` provider (they used to live under `google`).
	const googleProvider = {
		apiKey: geminiProvider.apiKey,
		apiKeyEnv: geminiProvider.apiKeyEnv,
		baseUrl: geminiProvider.baseUrl ?? vertexProviderCfg.baseUrl,
		authMode:
			vertexProviderCfg.projectId ||
			vertexProviderCfg.credentialsFile ||
			vertexProviderCfg.credentialsJson ||
			vertexProviderCfg.accessToken
				? "vertex"
				: "api-key",
		accessToken: vertexProviderCfg.accessToken,
		accessTokenEnv: vertexProviderCfg.accessTokenEnv,
		credentialsFile: vertexProviderCfg.credentialsFile,
		credentialsJson: vertexProviderCfg.credentialsJson,
		projectId: vertexProviderCfg.projectId,
		location: vertexProviderCfg.location,
	};
	const googleAuthMode: AuthMode =
		embeddingConfig.authMode === "vertex" ||
		googleProvider.authMode === "vertex"
			? "vertex"
			: "api-key";
	const googleApiKey = firstNonEmpty(
		explicitApiKey,
		googleProvider.apiKey,
		readConfiguredEnv(googleProvider.apiKeyEnv),
		process.env.GEMINI_API_KEY,
		process.env.GOOGLE_API_KEY,
	);
	const openAiProvider = optionalProviders.openai ?? {};
	const openAiApiKey = firstNonEmpty(
		explicitApiKey,
		openAiProvider.apiKey,
		readConfiguredEnv(openAiProvider.apiKeyEnv),
		process.env.OPENAI_API_KEY,
	);

	const autoProvider =
		requestedProvider !== "auto"
			? requestedProvider
			: openAiApiKey
				? "openai"
				: googleApiKey
					? "google"
					: googleAuthMode === "vertex" &&
							isGoogleVertexConfigured(googleProvider)
						? "google"
						: zhipuSupportsAutoEmbeddings && providers.zhipu?.apiKey
							? "zhipu"
							: "auto";

	// 1. Zhipu/Z.ai (OpenAI-compatible). Coding Plan keys do not expose /embeddings.
	if (
		autoProvider === "zhipu" &&
		providers.zhipu?.apiKey &&
		zhipuSupportsAutoEmbeddings
	) {
		apiKey = providers.zhipu.apiKey;
		// Always use global API for embeddings (embedding-3 only exists on api.z.ai)
		baseUrl = "https://api.z.ai/api/paas/v4";
		model = "embedding-3";
		apiType = "openai";
		dimensions = 1024;
		providerName = "Z.ai";
	}

	// 2. OpenAI
	if (autoProvider === "openai") {
		if (!openAiApiKey) {
			throw new Error(
				"OpenAI embeddings are enabled but no OpenAI API key was found. Set memory.embeddings.apiKeyEnv to OPENAI_API_KEY, set ai.providers.openai.apiKey, or export OPENAI_API_KEY. ChatGPT/Codex login tokens are not valid for /v1/embeddings.",
			);
		}
		apiKey = openAiApiKey;
		baseUrl =
			embeddingConfig.baseUrl ||
			openAiProvider.baseUrl ||
			"https://api.openai.com/v1";
		model = embeddingConfig.model || "text-embedding-3-small";
		apiType = "openai";
		dimensions = hasCustomDimensions ? embeddingConfig.dimensions : 1536;
		providerName = "OpenAI";
	}

	// 3. Google/Gemini (native API)
	if (autoProvider === "google") {
		authMode = googleAuthMode;
		baseUrl =
			embeddingConfig.baseUrl ||
			googleProvider.baseUrl ||
			(authMode === "vertex"
				? ""
				: "https://generativelanguage.googleapis.com/v1beta");
		model = embeddingConfig.model || "gemini-embedding-2";
		apiType = "google";
		dimensions = hasCustomDimensions ? embeddingConfig.dimensions : 768;
		providerName = authMode === "vertex" ? "Google Vertex AI" : "Google Gemini";

		if (authMode === "api-key") {
			if (!googleApiKey) {
				throw new Error(
					"Google Gemini embeddings are enabled but no API key was found. Set memory.embeddings.apiKeyEnv to GEMINI_API_KEY, set ai.providers.gemini.apiKey, or export GEMINI_API_KEY/GOOGLE_API_KEY.",
				);
			}
			apiKey = googleApiKey;
		} else {
			apiKey = "vertex";
			accessToken = firstNonEmpty(
				embeddingConfig.accessToken,
				googleProvider.accessToken,
				process.env.GOOGLE_VERTEX_ACCESS_TOKEN,
				process.env.GOOGLE_ACCESS_TOKEN,
			);
			const configuredAccessTokenEnv = firstNonEmpty(
				embeddingConfig.accessTokenEnv,
				googleProvider.accessTokenEnv,
			);
			accessTokenEnv =
				configuredAccessTokenEnv === "GOOGLE_APPLICATION_CREDENTIALS"
					? ""
					: configuredAccessTokenEnv;
			credentialsFile = firstNonEmpty(
				embeddingConfig.credentialsFile,
				googleProvider.credentialsFile,
				process.env.GOOGLE_APPLICATION_CREDENTIALS,
			);
			credentialsJson = firstNonEmpty(
				embeddingConfig.credentialsJson,
				googleProvider.credentialsJson,
			);
			projectId = firstNonEmpty(
				embeddingConfig.projectId,
				googleProvider.projectId,
				readServiceAccountProjectId(credentialsJson, credentialsFile),
				process.env.GOOGLE_CLOUD_PROJECT,
				process.env.GCLOUD_PROJECT,
			);
			location = firstNonEmpty(
				embeddingConfig.location,
				googleProvider.location,
				process.env.GOOGLE_CLOUD_LOCATION,
				process.env.GOOGLE_CLOUD_REGION,
				"us-central1",
			);
			if (!projectId) {
				throw new Error(
					"Google Vertex embeddings are enabled but no project ID was found. Set memory.embeddings.projectId, ai.providers.vertex.projectId, or GOOGLE_CLOUD_PROJECT.",
				);
			}
			if (
				!accessToken &&
				!readConfiguredEnv(accessTokenEnv) &&
				!credentialsFile &&
				!credentialsJson
			) {
				throw new Error(
					"Google Vertex embeddings are enabled but no credentials were found. Set memory.embeddings.accessTokenEnv, ai.providers.vertex.accessTokenEnv, GOOGLE_VERTEX_ACCESS_TOKEN, GOOGLE_ACCESS_TOKEN, or GOOGLE_APPLICATION_CREDENTIALS.",
				);
			}
		}
	}

	// 4. DeepSeek (OpenAI-compatible)
	const deepseek = optionalProviders.deepseek;
	const deepseekApiKey = deepseek?.apiKey;
	if (autoProvider === "deepseek" && deepseekApiKey) {
		apiKey = deepseekApiKey;
		baseUrl = deepseek.baseUrl || "https://api.deepseek.com/v1";
		model = "deepseek-embed";
		apiType = "openai";
		dimensions = 1024;
		providerName = "DeepSeek";
	}

	// 5. Mistral (OpenAI-compatible)
	const mistral = optionalProviders.mistral;
	const mistralApiKey = mistral?.apiKey;
	if (autoProvider === "mistral" && mistralApiKey) {
		apiKey = mistralApiKey;
		baseUrl = mistral.baseUrl || "https://api.mistral.ai/v1";
		model = "mistral-embed";
		apiType = "openai";
		dimensions = 1024;
		providerName = "Mistral";
	}

	// 6. xAI/Grok (OpenAI-compatible)
	const xaiProvider = optionalProviders.xai;
	const xaiApiKey = xaiProvider?.apiKey;
	if (autoProvider === "xai" && xaiApiKey) {
		apiKey = xaiApiKey;
		baseUrl = xaiProvider.baseUrl || "https://api.x.ai/v1";
		model = "v1";
		apiType = "openai";
		dimensions = 1024;
		providerName = "xAI";
	}

	// 7. Cohere (native API)
	const cohere = optionalProviders.cohere;
	const cohereApiKey = cohere?.apiKey;
	if (autoProvider === "cohere" && cohereApiKey) {
		apiKey = cohereApiKey;
		baseUrl = cohere.baseUrl || "https://api.cohere.com";
		model = "embed-multilingual-v3.0";
		apiType = "cohere";
		dimensions = 1024;
		providerName = "Cohere";
	}

	// 8. Ollama (local, no API key needed). Use only when explicitly selected,
	// because providers.local exists in defaults even when no Ollama daemon runs.
	if (autoProvider === "ollama") {
		const localUrl = providers.local.baseUrl || "http://localhost:11434";
		apiKey = "ollama"; // Ollama doesn't need real key, but we use it as flag
		baseUrl = localUrl;
		model = "nomic-embed-text";
		apiType = "ollama";
		dimensions = 768;
		providerName = "Ollama";
	}

	if (apiKey && !model && embeddingConfig.model) {
		model = embeddingConfig.model;
	}
	if (apiKey && embeddingConfig.baseUrl) {
		baseUrl = embeddingConfig.baseUrl;
	}

	const provider = new EmbeddingProvider({
		apiKey: apiKey === "ollama" ? "nokey" : apiKey,
		baseUrl,
		model,
		apiType,
		authMode,
		accessToken,
		accessTokenEnv,
		credentialsFile,
		credentialsJson,
		projectId,
		location,
		task: embeddingConfig.task,
		dimensions,
		maxBatchSize:
			apiType === "ollama"
				? Math.min(embeddingConfig.maxBatchSize, 8)
				: embeddingConfig.maxBatchSize,
		maxTextLength: embeddingConfig.maxTextLength,
		cacheSize: embeddingConfig.cacheSize,
		failureRetryMs: embeddingConfig.failureRetryMs,
	});

	if (apiKey) {
		console.log(
			`  ✓ Embedding provider: ${model} via ${providerName} (${apiType})`,
		);
	} else {
		console.log(
			"  ⚠ No embedding API — using hash fallback (semantic search limited)",
		);
	}

	return provider;
}

function normalizeBrowserWsUrl(
	...values: Array<string | undefined | null>
): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && /^wss?:\/\//i.test(value.trim())) {
			return value.trim();
		}
	}
	return undefined;
}

function normalizeBrowserProxyUrl(
	...values: Array<string | undefined | null>
): string | undefined {
	for (const value of values) {
		if (
			typeof value === "string" &&
			/^(https?|socks5):\/\//i.test(value.trim())
		) {
			return value.trim();
		}
	}
	return undefined;
}

function parseJsonRecord(value?: string | null): Record<string, unknown> {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function parseJsonStringArray(value?: string | null): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === "string")
			: [];
	} catch {
		return [];
	}
}

function buildAgentRuntimeConfig(
	agent: AgentRecord,
	fallbackConfig: AgentConfig,
	reasoningEffort?: import("@octopus-ai/core").AgentReasoningEffort,
): AgentConfig {
	const config = parseJsonRecord(agent.config);
	const defaultSkills = Array.isArray(config.defaultSkills)
		? config.defaultSkills.filter(
				(item): item is string => typeof item === "string",
			)
		: [];
	const defaultTools = Array.isArray(config.defaultTools)
		? config.defaultTools.filter(
				(item): item is string => typeof item === "string",
			)
		: [];
	const capabilities = parseJsonStringArray(agent.capabilities);
	const identityParts = [
		"# Active Agent Identity",
		`- Name: ${agent.name}`,
		`- Role: ${agent.role}`,
		agent.personality ? `- Personality: ${agent.personality}` : null,
		capabilities.length > 0
			? `- Capabilities: ${capabilities.join(", ")}`
			: null,
		defaultSkills.length > 0
			? `- Preferred skills: ${defaultSkills.join(", ")}`
			: null,
		defaultTools.length > 0
			? `- Preferred tools: ${defaultTools.join(", ")}`
			: null,
		agent.knowledge_base_ids
			? `- Knowledge bases: ${parseJsonStringArray(agent.knowledge_base_ids).join(", ") || "none"}`
			: null,
	]
		.filter(Boolean)
		.join("\n");
	return {
		id: agent.id,
		name: agent.name,
		description: agent.description ?? fallbackConfig.description,
		systemPrompt: `${identityParts}\n\n${agent.system_prompt || fallbackConfig.systemPrompt}`,
		model: agent.model ?? fallbackConfig.model,
		reasoningEffort: reasoningEffort ?? fallbackConfig.reasoningEffort,
		maxTokens: fallbackConfig.maxTokens,
		toolIterationLimit: fallbackConfig.toolIterationLimit,
		continuityGuard: fallbackConfig.continuityGuard,
		tenacidad: fallbackConfig.tenacidad,
	};
}

/**
 * Resolve an agent's initial reasoning effort for its effective model. Uses the
 * persisted per-(agent,model) profile when present, otherwise seeds from the
 * global `ai.thinking` setting (coerced against model capabilities) and persists
 * nothing here — persistence happens when the user explicitly changes it.
 */
async function resolveInitialReasoning(
	agentManager: {
		resolveReasoningForModel: (
			id: string,
			model: string,
			fallback: AgentReasoningEffort,
		) => Promise<AgentReasoningEffort>;
	},
	config: OctopusConfig,
	agentId: string,
	effectiveModel: string,
): Promise<AgentReasoningEffort> {
	const caps = getModelCapabilitiesFromRef(config, effectiveModel);
	const globalThinking =
		(config.ai.thinking as AgentReasoningEffort | undefined) ?? "none";
	const seeded = caps ? coerceReasoningEffort(caps, globalThinking) : "none";
	return agentManager.resolveReasoningForModel(agentId, effectiveModel, seeded);
}

export async function bootstrap(options?: {
	configPath?: string;
}): Promise<OctopusSystem> {
	const loader = new ConfigLoader(options?.configPath);
	let config = loader.load();

	const storageConnectionString =
		config.storage.connectionString ||
		process.env.OCTOPUS_POSTGRES_URL ||
		process.env.DATABASE_URL ||
		"";
	const db = createDatabaseAdapter(
		config.storage.backend as "sqlite" | "postgresql" | "mysql" | "mongodb",
		{
			path: config.storage.path,
			connectionString: storageConnectionString,
			options:
				config.storage.ssl || process.env.OCTOPUS_POSTGRES_SSL === "true"
					? { ssl: { rejectUnauthorized: false } }
					: undefined,
		},
	);
	await db.initialize();

	const tokenCounter = new TokenCounter();

	const stm = new ShortTermMemory({
		maxTokens: config.memory.shortTerm.maxTokens,
		scratchPadSize: config.memory.shortTerm.scratchPadSize,
		autoEviction: config.memory.shortTerm.autoEviction,
		tokenCounter: {
			countTokens: (text: string) => tokenCounter.countTokens(text),
			countMessagesTokens: (msgs: { content: string }[]) =>
				msgs.reduce((sum, m) => sum + tokenCounter.countTokens(m.content), 0),
		},
	});

	const vectorStore = createVectorStore(
		config.memory.longTerm.backend,
		db,
		config.memory.longTerm.vectorStore,
	);
	const ltm = new LongTermMemory(vectorStore, db);

	// Real Embedding Provider — kept behind a stable function so config changes
	// can refresh embeddings without rebuilding every memory subsystem.
	let embeddingProvider = createEmbeddingProvider(config);
	const embedFn: EmbeddingFunction = (text, task) =>
		embeddingProvider.embed(text, task);
	const refreshEmbeddingProvider = async (
		nextConfig: OctopusConfig = config,
	): Promise<boolean> => {
		embeddingProvider = createEmbeddingProvider(nextConfig);
		return true;
	};

	const memoryRetrieval = new MemoryRetrieval(ltm, stm, embedFn, {
		maxResults: config.memory.retrieval.maxResults,
		maxTokens: config.memory.retrieval.maxTokens,
		minRelevance: config.memory.retrieval.minRelevance,
		weights: config.memory.retrieval.weights,
	});

	const memoryConsolidator = new MemoryConsolidator(ltm, db, embedFn, {
		importanceThreshold: config.memory.longTerm.importanceThreshold,
		batchSize: config.memory.consolidation.batchSize,
		extractFacts: config.memory.consolidation.extractFacts,
		extractEvents: config.memory.consolidation.extractEvents,
		extractProcedures: config.memory.consolidation.extractProcedures,
	});
	const ftsSearch = new FTSSearchEngine(db);
	await ftsSearch.initialize();
	const memoryOrchestrator = new MemoryOrchestrator({
		db,
		ltm,
		embeddingFn: embedFn,
		ftsSearch,
		config: {
			defaultTenantId: "local",
			defaultUserId: "owner",
			defaultProjectId: process.cwd(),
			minRelevance: config.memory.retrieval.minRelevance,
			maxReadCandidates: config.memory.retrieval.maxResults * 3,
		},
	});
	await memoryOrchestrator.initialize();
	const contextAssembler = new ContextAssembler(memoryOrchestrator, {
		reserveTokens: 128,
		maxSimilarEpisodes: 4,
		maxAgentLessons: 5,
	});
	(
		memoryConsolidator as MemoryConsolidator & {
			setMemoryOrchestrator?: (
				orchestrator: MemoryOrchestrator,
				scope: {
					tenantId: string;
					userId: string;
					projectId: string;
				},
			) => void;
		}
	).setMemoryOrchestrator?.(memoryOrchestrator, {
		tenantId: "local",
		userId: "owner",
		projectId: process.cwd(),
	});

	const providers: Record<string, ProviderConfig> = {};
	const providerEntries = Object.entries(config.ai.providers) as Array<
		[string, ProviderConfig]
	>;
	for (const [name, pConfig] of providerEntries) {
		if (name === "local") {
			providers.local = {
				...pConfig,
				baseUrl: pConfig.baseUrl || "http://localhost:11434",
			};
		} else {
			providers[name] = { ...pConfig };
		}
	}

	const router = new LLMRouter({
		default: config.ai.default,
		fallback: config.ai.fallback,
		providers,
		thinking: config.ai.thinking,
	});
	await router.initialize();

	// Durable usage ledger — persists token/cost events across restarts.
	const usageStore = new UsageStore(db);
	router.setUsageSink(usageStore);
	// Capture real quota headers (Codex x-codex-*) from provider responses and
	// persist the snapshot so it survives restarts.
	router.setQuotaHeaderHandler((provider, headers) => {
		handleProviderResponseHeaders(provider, headers);
		const snap = getCachedQuota(provider);
		if (snap) void usageStore.saveQuotaSnapshot(snap);
	});

	// Reactive Codex token refresh: when the ChatGPT access_token expires
	// mid-task (HTTP 401), the CodexProvider calls this to obtain a fresh token
	// (via the stored refresh_token), persist it to config, and retry — so an
	// expiring token no longer kills long-running turns. Returns undefined on
	// any failure so the provider surfaces the 401 and the router's fallback
	// takes over.
	router.setTokenRefreshHandler(async (provider) => {
		if (provider !== "openai") return undefined;
		try {
			const loader = new ConfigLoader();
			const cfg = loader.load();
			const openai = cfg.ai.providers.openai as Record<string, unknown>;
			if (openai.authMode !== "codex" || !openai.oauthRefreshToken) {
				return undefined;
			}
			const refreshed = await refreshCodexToken(
				String(openai.oauthRefreshToken),
			);
			openai.accessToken = refreshed.accessToken;
			if (refreshed.refreshToken) {
				openai.oauthRefreshToken = refreshed.refreshToken;
			}
			if (refreshed.expiresAt) {
				openai.oauthExpiresAt = refreshed.expiresAt;
			}
			loader.save(cfg);
			console.log("[codex-auth] access_token refreshed after 401 and persisted");
			return refreshed.accessToken;
		} catch (err) {
			console.error(
				`[codex-auth] token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return undefined;
		}
	});

	// Wire STM condensation callback — uses LLM to summarize before evicting
	stm.setCondensationCallback(async (turns) => {
		try {
			const text = turns
				.map((t) => `[${t.role}]: ${t.content.slice(0, 300)}`)
				.join("\n");
			const response = await router.chat({
				model: config.ai.default,
				messages: [
					{
						role: "system",
						content:
							"Extract a brief summary (max 150 words) preserving: user goals, decisions made, errors encountered, file paths, URLs, and key data points. Output ONLY the summary, nothing else.",
					},
					{ role: "user", content: text },
				],
				maxTokens: 300,
				temperature: 0.1,
			});
			return response.content;
		} catch {
			return "";
		}
	});

	// Wire LLM-based fact extraction for consolidator
	memoryConsolidator.setLLMExtractor(async (conversationText) => {
		try {
			const response = await router.chat({
				model: config.ai.default,
				messages: [
					{
						role: "system",
						content: `Extract structured information from this conversation. Return ONLY valid JSON with this schema:
{"facts": ["string"], "decisions": ["string"], "errors": ["string"], "toolsUsed": ["string"]}
- facts: Important facts, preferences, or knowledge mentioned
- decisions: Decisions made or preferences stated  
- errors: Errors encountered and their resolutions
- toolsUsed: Names of tools/commands used
Keep each item concise (1 sentence max). Return empty arrays if nothing relevant found.`,
					},
					{ role: "user", content: conversationText },
				],
				maxTokens: 500,
				temperature: 0.1,
			});
			const parsed = JSON.parse(
				response.content
					.replace(/```json?\n?/g, "")
					.replace(/```/g, "")
					.trim(),
			);
			return {
				facts: Array.isArray(parsed.facts) ? parsed.facts : [],
				decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
				errors: Array.isArray(parsed.errors) ? parsed.errors : [],
				toolsUsed: Array.isArray(parsed.toolsUsed) ? parsed.toolsUsed : [],
			};
		} catch {
			return { facts: [], decisions: [], errors: [], toolsUsed: [] };
		}
	});

	const dailyMemory = new GlobalDailyMemory(db, router, tokenCounter, {
		maxTokens: 1500,
		triggerMessageCount: 10,
	});
	await dailyMemory.initialize();

	const userProfileManager = new UserProfileManager(db, router, {
		minTurnsForUpdate: 3,
		maxDecisions: 50,
		maxWorkflows: 20,
	});
	await userProfileManager.initialize();

	const skillRegistry = new SkillRegistry(db, embedFn);
	const skillLoader = new SkillLoader(skillRegistry, embedFn, {
		maxTokenBudget: config.skills.loading.maxTokenBudget,
		progressiveLevels: config.skills.loading.progressiveLevels,
		autoUnload: config.skills.loading.autoUnload,
		searchThreshold: config.skills.loading.searchThreshold,
		contentScanning: config.security.contentScanning,
	});
	(
		skillLoader as unknown as {
			updateConfig?: (config: { enabled: boolean }) => void;
		}
	).updateConfig?.({ enabled: config.skills.enabled });

	const skillForge = new SkillForge(skillRegistry, embedFn, {
		complexityThreshold: config.skills.forge.complexityThreshold,
		selfCritique: config.skills.forge.selfCritique,
		minQualityScore: config.skills.forge.minQualityScore,
		includeExamples: config.skills.forge.includeExamples,
		includeTemplates: config.skills.forge.includeTemplates,
		includeAntiPatterns: config.skills.forge.includeAntiPatterns,
	});

	const skillImprover = new SkillImprover(skillRegistry, embedFn, {
		triggerOnSuccessRate: config.skills.improvement.triggerOnSuccessRate,
		triggerOnRating: config.skills.improvement.triggerOnRating,
		reviewEveryNUses: config.skills.improvement.reviewEveryNUses,
		abTestMajorChanges: config.skills.improvement.abTestMajorChanges,
		abTestSampleSize: config.skills.improvement.abTestSampleSize,
	});
	(
		skillImprover as unknown as {
			updateConfig?: (config: { enabled: boolean }) => void;
		}
	).updateConfig?.({ enabled: config.skills.autoImprove });

	const learningEngine = new LearningEngine(db, embedFn, {
		ltm,
		router,
		skillRegistry,
		skillForge,
		skillImprover,
		config: {
			...config.learning,
			autoCreateSkills:
				config.learning.autoCreateSkills && config.skills.autoCreate,
		},
	});
	await learningEngine.initialize();

	const chatManager = new ChatManager(db);
	const agentManager = new AgentManager(db);
	const agentMessageBus = new AgentMessageBus();
	const workflowManager = new WorkflowManager(db);
	await workflowManager.markStaleRunsInterrupted();
	const artifactVerifier = new ArtifactVerifier(db);
	const requirementResolver = new RequirementResolver(
		workflowManager,
		artifactVerifier,
	);
	const kanbanPlanner = new KanbanPlanner(workflowManager, router, {
		model: config.ai.default,
		maxTokens: 3000,
	});
	const knowledgeManager = new KnowledgeManager(
		db,
		embedFn,
		createConfiguredKnowledgeExtractor(router, config.ai),
	);
	const teamBlackboard = new TeamBlackboard();
	let envEncryptionKey =
		config.security.encryptionKey ||
		process.env.OCTOPUS_ENV_ENCRYPTION_KEY ||
		process.env.OCTOPUS_ENCRYPTION_KEY ||
		"";
	if (!envEncryptionKey) {
		envEncryptionKey = generateEncryptionKey();
		config = {
			...config,
			security: { ...config.security, encryptionKey: envEncryptionKey },
		};
		try {
			loader.save(config);
		} catch {
			/* config will still be used in-memory for this boot */
		}
	}
	const envVarManager = new EnvVarManager(db, {
		encryptionKey: envEncryptionKey,
	});
	const managedEnv = await envVarManager.toProcessEnv();
	for (const [key, value] of Object.entries(managedEnv)) {
		if (!(key in process.env)) {
			process.env[key] = value;
		}
	}
	const taskManager = new TaskManager(db);
	const automationManager = new AutomationManager(db);
	const mcpEnvFilter = new EnvironmentFilter(config.security.envFiltering);
	const mcpRedactor = new SecretRedactor({
		enabled: config.security.redaction.enabled,
		mask: config.security.redaction.mask,
		extraSecretKeys: config.security.redaction.extraSecretKeys,
	});
	const mcpManager = new MCPManager({
		envFilter: mcpEnvFilter,
		redactor: mcpRedactor,
	});

	const toolRegistry = new ToolRegistry();
	const toolConfig = config.tools as OctopusConfig["tools"] & {
		disabled?: string[];
		allowedPaths?: string[];
	};
	const disabledTools = toolConfig.disabled || [];
	// Canonical workspace for agent-generated projects and files. Relative paths
	// in the filesystem tools resolve here, and it is the only place the agent
	// should write by default; other locations require an explicit user request
	// (and must be within the allowed paths below).
	const workspaceDir = path.join(os.homedir(), ".octopus", "workspace");
	try {
		mkdirSync(workspaceDir, { recursive: true });
	} catch {
		// Best-effort: tool handlers create missing parents on write anyway.
	}
	// Where Octopus itself is installed (the directory that contains packages/).
	// Resolved from this module's own location, NEVER from process.cwd() (which
	// changes depending on how the backend is launched). Exposed to the agent via
	// the system prompt so it treats its own install as off-limits.
	const installRoot = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../../..",
	);
	const defaultAllowedPaths = [
		os.homedir(),
		path.join(os.homedir(), ".octopus"),
	];
	const legacyToolAllowedPaths = toolConfig.allowedPaths || [];
	const securityAllowedPaths = config.security.allowedPaths || [];
	const allowedPaths = [
		...new Set([
			...defaultAllowedPaths,
			...securityAllowedPaths,
			...legacyToolAllowedPaths,
		]),
	];
	const dynamicToolsDir = join(homedir(), ".octopus", "tools");
	const reloadDynamicTool = async (name: string): Promise<boolean> => {
		const toolDir = join(dynamicToolsDir, name);
		return Boolean(registerDynamicTool(toolRegistry, toolDir, name));
	};

	const codeExecutor = new CodeExecutor(
		{ allowedPaths, workspaceDir, envFiltering: config.security.envFiltering },
		{
			onToolCreated: async ({ name }) => {
				await reloadDynamicTool(name);
			},
		},
	);
	await codeExecutor.initialize();
	mcpManager.setToolRegistry(toolRegistry);

	mcpManager.setPersistCallback((servers) => {
		try {
			const loader = new ConfigLoader();
			const cfg = loader.load();
			const currentMcp = (cfg as Record<string, unknown>).mcp as
				| Record<string, unknown>
				| undefined;
			(cfg as Record<string, unknown>).mcp = { ...currentMcp, servers };
			loader.save(cfg);
		} catch {
			/* ignore persist errors */
		}
	});

	const registerSystemTool = (tool: ToolDefinition) => {
		if (disabledTools.includes(tool.name)) return;
		tool.metadata = { ...tool.metadata, source: "system" };
		toolRegistry.register(tool);
	};

	const redactor = new SecretRedactor({
		enabled: config.security.redaction.enabled,
		mask: config.security.redaction.mask,
		extraSecretKeys: config.security.redaction.extraSecretKeys,
	});
	const commandApproval = config.security.commandApproval;

	const toolExecutor = new ToolExecutor(toolRegistry, {
		sandboxCommands: config.security.sandboxCommands,
		allowedPaths,
		timeouts: config.tools.timeouts,
		rateLimits: config.tools.rateLimits,
		commandApproval,
		redactor,
	});

	// PDF reader: extract text from PDFs (the browser can open but not read
	// them). OCR fallback for scanned PDFs runs when the native canvas module is
	// available. Registered unconditionally; no browser required.
	const pdfReader = new PdfReader({
		urlPolicy: config.security.urlPolicy,
		allowedLocalRoots: allowedPaths,
	});
	for (const tool of pdfReader.createTools()) {
		registerSystemTool(tool);
	}

	// Skill researcher (Context7 → web → browser) for fresh-info-grounded skills.
	// Wired after the tool executor exists; forge/improver are already shared with
	// the LearningEngine by reference, so setDeps propagates to skill creation.
	const skillResearcher = new SkillResearcher(
		toolExecutor,
		router,
		config.skills.research ?? {},
	);
	skillForge.setDeps({ router, researcher: skillResearcher });
	skillImprover.setDeps({ router, researcher: skillResearcher });

	const filesystemTools = createFileSystemTools(allowedPaths, workspaceDir);
	for (const tool of filesystemTools) {
		registerSystemTool(tool);
	}

	const shellTool = createShellTool({
		sandboxCommands: config.security.sandboxCommands,
		allowedPaths,
		workspaceDir,
		commandApproval,
		envFiltering: config.security.envFiltering,
		redactor,
	});
	registerSystemTool(shellTool);

	const codeTools = codeExecutor.createTools();
	for (const tool of codeTools) {
		registerSystemTool(tool);
	}

	const mediaTools = createMediaTools(allowedPaths);
	for (const tool of mediaTools) {
		registerSystemTool(tool);
	}

	// Codex image generation (uses the ChatGPT-account token from Codex login).
	for (const tool of createCodexImageTools()) {
		registerSystemTool(tool);
	}

	const kanbanCardTools = createKanbanCardTools(
		workflowManager,
		requirementResolver,
	);
	for (const tool of kanbanCardTools) {
		registerSystemTool(tool);
	}

	registerSystemTool({
		name: "recall_conversation",
		description:
			"Search raw saved conversation messages in the database. Use this before saying you do not remember when the user asks if you remember/recall something, refers to another conversation, or needs exact prior wording, file paths, URLs, media IDs, command output, errors, or tool results. It can search the current conversation and automatically fall back to all saved conversations.",
		parameters: {
			query: {
				type: "string",
				description:
					"Exact keyword or phrase to search for. Prefer strings from [Retrieval Hints]: filename, path, URL, media ID, error fragment, command, or user phrase.",
				required: true,
			},
			conversationId: {
				type: "string",
				description:
					"Optional conversation id. If omitted, searches the active/current conversation first, then all conversations if needed.",
			},
			scope: {
				type: "string",
				description:
					"Search scope: current or all. Defaults to current with automatic fallback to all saved conversations when current has no matches.",
			},
			limit: {
				type: "number",
				description:
					"Maximum matching messages to return, 1-20. Defaults to 8.",
			},
			contextRadius: {
				type: "number",
				description:
					"Number of neighboring messages before/after each match when searching one conversation, 0-4. Defaults to 1.",
			},
		},
		handler: async (params, context) => {
			const query = typeof params.query === "string" ? params.query.trim() : "";
			if (!query) {
				return {
					success: false,
					output: "",
					error: "query is required",
				};
			}

			const clamp = (
				value: unknown,
				fallback: number,
				min: number,
				max: number,
			) => {
				const parsed = Number(value);
				if (!Number.isFinite(parsed)) return fallback;
				return Math.min(max, Math.max(min, Math.floor(parsed)));
			};
			const limit = clamp(params.limit, 8, 1, 20);
			const contextRadius = clamp(params.contextRadius, 1, 0, 4);
			const scope = params.scope === "all" ? "all" : "current";
			const activeConversationId = context.agent?.channelId;
			const requestedConversationId =
				typeof params.conversationId === "string"
					? params.conversationId.trim()
					: "";
			const conversationId =
				requestedConversationId ||
				(scope === "current" ? activeConversationId : undefined);
			const truncate = (text: string, max = 700) =>
				text.length > max
					? `${text.slice(0, Math.floor(max / 2))}\n...[truncated]...\n${text.slice(-Math.floor(max / 2))}`
					: text;
			const normalizeText = (text: string) =>
				text
					.toLowerCase()
					.normalize("NFD")
					.replace(/\p{Diacritic}/gu, "");
			const stopwords = new Set([
				"acuerdas",
				"recuerdas",
				"recordar",
				"recuerdo",
				"como",
				"dije",
				"dijiste",
				"dijimos",
				"digo",
				"deben",
				"debe",
				"hacer",
				"hacen",
				"sobre",
				"algo",
				"otra",
				"otro",
				"conversacion",
				"conversación",
				"hablamos",
				"hablar",
				"para",
				"porque",
				"cuando",
				"donde",
				"esto",
				"esta",
				"este",
				"estos",
				"estas",
				"the",
				"and",
				"for",
				"with",
				"that",
				"this",
			]);
			const queryNorm = normalizeText(query);
			const terms = [
				...new Set(
					queryNorm
						.split(/[^a-z0-9_/-]+/i)
						.map((term) => term.trim())
						.filter((term) => term.length >= 3 && !stopwords.has(term)),
				),
			].slice(0, 8);
			const variantsFor = (term: string) => {
				const variants = new Set([term]);
				if (term.endsWith("s")) variants.add(term.slice(0, -1));
				if (term.startsWith("extend")) {
					variants.add("extend");
					variants.add("extender");
					variants.add("extension");
					variants.add("extend_video");
				}
				if (term.startsWith("video")) {
					variants.add("video");
					variants.add("videos");
				}
				return [...variants];
			};
			const scoreMessage = (content: string) => {
				const contentNorm = normalizeText(content);
				if (contentNorm.includes(queryNorm)) return 1000 + queryNorm.length;
				let matchedTerms = 0;
				let score = 0;
				for (const term of terms) {
					const matched = variantsFor(term).some((variant) =>
						contentNorm.includes(variant),
					);
					if (matched) {
						matchedTerms += 1;
						score += 20 + Math.min(term.length, 20);
					}
				}
				const requiredMatches =
					terms.length >= 2 ? Math.min(2, terms.length) : 1;
				return matchedTerms >= requiredMatches ? score : 0;
			};
			const formatConversationMatches = async (
				searchConversationId: string,
				prefix: string,
			) => {
				const messages = await chatManager.getConversationMessages(
					searchConversationId,
					{
						limit: 5000,
					},
				);
				const matchIndexes = messages
					.map((message, index) => ({ message, index }))
					.map((item) => ({
						...item,
						score: scoreMessage(item.message.content),
					}))
					.filter(({ score }) => score > 0)
					.sort((a, b) => b.score - a.score || b.index - a.index)
					.slice(0, limit);

				if (matchIndexes.length === 0) {
					return null;
				}

				const blocks = matchIndexes.map(({ index }) => {
					const start = Math.max(0, index - contextRadius);
					const end = Math.min(messages.length, index + contextRadius + 1);
					const contextLines = messages
						.slice(start, end)
						.map((message, offset) => {
							const absoluteIndex = start + offset + 1;
							const marker = start + offset === index ? "MATCH" : "context";
							return `[${marker} #${absoluteIndex} ${message.timestamp} ${message.role} messageId=${message.id}]\n${truncate(message.content)}`;
						});
					return contextLines.join("\n");
				});

				return {
					success: true,
					output: `${prefix}Found ${matchIndexes.length} raw match(es) for "${query}" in conversation ${searchConversationId}.\n\n${blocks.join("\n\n---\n\n")}`,
					metadata: {
						conversationId: searchConversationId,
						matches: matchIndexes.length,
						terms,
					},
				};
			};

			if (conversationId) {
				const currentResult = await formatConversationMatches(
					conversationId,
					"",
				);
				if (currentResult) return currentResult;
				if (requestedConversationId || scope === "all") {
					return {
						success: true,
						output: `No raw messages matched "${query}" in conversation ${conversationId}. Try a shorter exact fragment, filename, URL, media ID, or path.`,
						metadata: { conversationId, matches: 0, terms },
					};
				}
			}

			const candidateLimit = Math.max(200, limit * 50);
			const candidates = await chatManager.searchMessages(query, {
				limit: candidateLimit,
			});
			const matches = candidates
				.map((message) => ({ message, score: scoreMessage(message.content) }))
				.filter(({ score }) => score > 0)
				.sort(
					(a, b) =>
						b.score - a.score ||
						b.message.timestamp.localeCompare(a.message.timestamp),
				)
				.slice(0, limit);
			if (matches.length === 0) {
				return {
					success: true,
					output: `No raw messages matched "${query}" across saved conversations. Try a shorter exact fragment, filename, URL, media ID, path, or user phrase. Search terms used: ${terms.join(", ") || "none"}.`,
					metadata: { matches: 0, scope: "all", terms },
				};
			}

			const blocks: string[] = [];
			for (let index = 0; index < matches.length; index++) {
				const match = matches[index]?.message;
				if (!match) continue;
				const messages = await chatManager.getConversationMessages(
					match.conversation_id,
					{ limit: 5000 },
				);
				const matchIndex = messages.findIndex((item) => item.id === match.id);
				if (matchIndex === -1) {
					blocks.push(
						`[MATCH ${index + 1} conversationId=${match.conversation_id} ${match.timestamp} ${match.role} messageId=${match.id}]\n${truncate(match.content)}`,
					);
					continue;
				}
				const start = Math.max(0, matchIndex - contextRadius);
				const end = Math.min(messages.length, matchIndex + contextRadius + 1);
				blocks.push(
					messages
						.slice(start, end)
						.map((message, offset) => {
							const absoluteIndex = start + offset + 1;
							const marker =
								start + offset === matchIndex ? "MATCH" : "context";
							return `[${marker} #${absoluteIndex} conversationId=${message.conversation_id} ${message.timestamp} ${message.role} messageId=${message.id}]\n${truncate(message.content)}`;
						})
						.join("\n"),
				);
			}

			return {
				success: true,
				output: `${conversationId ? "No raw matches were found in the current conversation, so I searched all saved conversations.\n\n" : ""}Found ${matches.length} raw match(es) for "${query}" across saved conversations.\nSearch terms used: ${terms.join(", ") || "exact phrase only"}.\n\n${blocks.join("\n\n---\n\n")}`,
				metadata: { matches: matches.length, scope: "all", terms },
			};
		},
	});

	registerSystemTool({
		name: "manage_tool_timeouts",
		description:
			"Read and update live tool execution timeouts. Use this when a tool needs more time than the default timeout.",
		parameters: {
			action: {
				type: "string",
				description: "Action: get, set-defaults, set-tool, or unset-tool.",
				required: true,
			},
			toolName: {
				type: "string",
				description: "Tool name for set-tool or unset-tool.",
			},
			timeoutMs: {
				type: "number",
				description: "Timeout in milliseconds for set-tool.",
			},
			defaultMs: {
				type: "number",
				description: "Default timeout in milliseconds for regular tools.",
			},
			longRunningMs: {
				type: "number",
				description: "Timeout in milliseconds for browser/web/search tools.",
			},
			captchaMs: {
				type: "number",
				description: "Timeout in milliseconds for CAPTCHA tools.",
			},
			scrapingMs: {
				type: "number",
				description: "Timeout in milliseconds for scraping tools.",
			},
		},
		handler: async (params: Record<string, unknown>) => {
			const loader = new ConfigLoader();
			const cfg = loader.load();
			cfg.tools.timeouts = {
				...cfg.tools.timeouts,
				byTool: { ...(cfg.tools.timeouts.byTool ?? {}) },
			};
			const action = String(params.action ?? "get");
			const positiveTimeout = (value: unknown, field: string): number => {
				const timeout = typeof value === "number" ? value : Number(value);
				if (!Number.isFinite(timeout) || timeout < 1000) {
					throw new Error(`${field} must be a number >= 1000`);
				}
				return timeout;
			};

			if (action === "set-defaults") {
				if (params.defaultMs !== undefined) {
					cfg.tools.timeouts.defaultMs = positiveTimeout(
						params.defaultMs,
						"defaultMs",
					);
				}
				if (params.longRunningMs !== undefined) {
					cfg.tools.timeouts.longRunningMs = positiveTimeout(
						params.longRunningMs,
						"longRunningMs",
					);
				}
				if (params.captchaMs !== undefined) {
					cfg.tools.timeouts.captchaMs = positiveTimeout(
						params.captchaMs,
						"captchaMs",
					);
				}
				if (params.scrapingMs !== undefined) {
					cfg.tools.timeouts.scrapingMs = positiveTimeout(
						params.scrapingMs,
						"scrapingMs",
					);
				}
			} else if (action === "set-tool") {
				const toolName = String(params.toolName ?? "").trim();
				if (!toolName) throw new Error("toolName is required for set-tool");
				cfg.tools.timeouts.byTool[toolName] = positiveTimeout(
					params.timeoutMs,
					"timeoutMs",
				);
			} else if (action === "unset-tool") {
				const toolName = String(params.toolName ?? "").trim();
				if (!toolName) throw new Error("toolName is required for unset-tool");
				delete cfg.tools.timeouts.byTool[toolName];
			} else if (action !== "get") {
				throw new Error(`Unsupported action: ${action}`);
			}

			if (action !== "get") {
				loader.save(cfg);
				config.tools.timeouts = cfg.tools.timeouts;
				toolExecutor.updateConfig({ timeouts: cfg.tools.timeouts });
			}

			return {
				success: true,
				output: JSON.stringify(toolExecutor.getTimeoutConfig(), null, 2),
			};
		},
	});

	const automationTools = createAutomationTools(automationManager);
	for (const tool of automationTools) {
		registerSystemTool(tool);
	}

	const teamTools = createTeamTools(async (task, role, options) => {
		// Obtener contexto de la conversación actual para el worker
		const contextSummary = agentRuntime.getContextSummary(1500);
		const contextBlock = contextSummary
			? `\n\nConversation context from the main agent:\n${contextSummary}`
			: "";

		const workerStm = new ShortTermMemory({
			maxTokens: config.memory?.shortTerm?.maxTokens ?? 16000,
			scratchPadSize: config.memory?.shortTerm?.scratchPadSize ?? 10,
			autoEviction: config.memory?.shortTerm?.autoEviction ?? true,
			tokenCounter: new TokenCounter(),
		});

		const workerId = `worker-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
		const workerRuntime = new AgentRuntime(
			{
				...agentConfig,
				id: workerId,
				name: `Worker (${role})`,
				model: options?.model ?? agentConfig.model,
				systemPrompt: `You are a specialist worker deployed by Octopus Manager. Your role is: ${role}. Solve the task directly and report back concisely. Respond ONLY with the final result, no small talk.${contextBlock}`,
			},
			router,
			workerStm,
			memoryRetrieval,
			memoryConsolidator,
			skillLoader,
		);

		// Workers get tools but NOT delegate_task to prevent infinite recursion
		const workerToolRegistry = new ToolRegistry();
		for (const tool of toolRegistry.list()) {
			if (tool.name !== "delegate_task") {
				workerToolRegistry.register(tool);
			}
		}
		const workerToolExecutor = new ToolExecutor(workerToolRegistry, {
			sandboxCommands: config.security.sandboxCommands,
			allowedPaths,
			timeouts: config.tools.timeouts,
			rateLimits: config.tools.rateLimits,
			commandApproval,
			redactor,
		});
		workerToolExecutor.setHealth(toolHealth);
		workerRuntime.setToolSystem(workerToolRegistry, workerToolExecutor);
		workerRuntime.setLearningEngine(learningEngine);
		workerRuntime.setMemoryOrchestrator(memoryOrchestrator);
		workerRuntime.setContextAssembler(contextAssembler);

		teamBlackboard.registerWorker(workerId, workerRuntime);

		return await workerRuntime.processMessage(task, "system_worker");
	});

	for (const tool of teamTools) {
		registerSystemTool(tool);
	}

	// Register team communication tools globally
	const teamCommTools = createTeamCommTools(teamBlackboard, "main_agent");
	for (const tool of teamCommTools) {
		registerSystemTool(tool);
	}

	for (const tool of createAgentCommsTools(agentManager)) {
		registerSystemTool(tool);
	}
	for (const tool of createAgentSpawnTools(agentManager)) {
		registerSystemTool(tool);
	}

	// Browser tools (configurable)
	const browserPaths = [
		"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
		"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium-browser",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	];
	let detectedBrowserPath: string | null = null;
	for (const p of browserPaths) {
		if (existsSync(p)) {
			detectedBrowserPath = p;
			break;
		}
	}

	let browserTool: BrowserTool | null = null;
	const refreshBrowserTools = async (
		nextConfig?: OctopusConfig,
	): Promise<boolean> => {
		if (nextConfig) config = nextConfig;
		const browserCfg = (
			config as OctopusConfig & { browser?: BrowserRuntimeConfig }
		).browser || { provider: "auto" };
		const brightDataEnabled = browserCfg.brightDataEnabled !== false;
		const brightDataWsUrl = brightDataEnabled
			? normalizeBrowserWsUrl(
					browserCfg.brightDataWsUrl,
					process.env.BRIGHTDATA_WS_URL,
				)
			: undefined;
		const decodoEnabled = browserCfg.decodoEnabled !== false;
		const decodoProxyUrl = decodoEnabled
			? normalizeBrowserProxyUrl(
					browserCfg.decodoProxyUrl,
					process.env.DECODO_PROXY_URL,
					process.env.DECODO_PROXY_SERVER,
				)
			: undefined;
		const isEmbedded =
			browserCfg.provider === "embedded" && detectedBrowserPath;
		const isBrightData =
			browserCfg.provider === "brightdata" && brightDataWsUrl;
		const hasDecodoProxy = Boolean(
			decodoProxyUrl ||
				browserCfg.decodoProxyUrl ||
				process.env.DECODO_PROXY_SERVER ||
				process.env.DECODO_PROXY_USERNAME ||
				process.env.DECODO_PROXY_USER,
		);
		const isDecodo =
			browserCfg.provider === "decodo" &&
			detectedBrowserPath &&
			decodoEnabled &&
			hasDecodoProxy;
		const isAuto =
			browserCfg.provider === "auto" &&
			(detectedBrowserPath || brightDataWsUrl);
		const toolConfig = {
			executablePath: detectedBrowserPath,
			headless: browserCfg.headless,
			userDataDir: browserCfg.userDataDir,
			chromiumSandbox: browserCfg.chromiumSandbox,
			nativeFingerprint: browserCfg.nativeFingerprint,
			stealth: browserCfg.stealth,
			provider: browserCfg.provider,
			brightDataEnabled,
			brightDataWsUrl,
			decodoEnabled,
			decodoProxyUrl,
			decodoProxyUsername:
				browserCfg.decodoProxyUsername ||
				process.env.DECODO_PROXY_USERNAME ||
				process.env.DECODO_PROXY_USER,
			decodoProxyPassword:
				browserCfg.decodoProxyPassword ||
				process.env.DECODO_PROXY_PASSWORD ||
				process.env.DECODO_PROXY_PASS,
			decodoProxyCountry:
				browserCfg.decodoProxyCountry || process.env.DECODO_PROXY_COUNTRY,
			decodoProxyCity:
				browserCfg.decodoProxyCity || process.env.DECODO_PROXY_CITY,
			decodoProxyState:
				browserCfg.decodoProxyState || process.env.DECODO_PROXY_STATE,
			decodoProxyZip: browserCfg.decodoProxyZip || process.env.DECODO_PROXY_ZIP,
			decodoProxySession:
				browserCfg.decodoProxySession || process.env.DECODO_PROXY_SESSION,
			decodoProxySessionDuration:
				browserCfg.decodoProxySessionDuration ||
				process.env.DECODO_PROXY_SESSION_DURATION,
			decodoScraperToken:
				browserCfg.decodoScraperToken ||
				process.env.DECODO_SCRAPER_TOKEN ||
				process.env.DECODO_API_TOKEN,
			decodoScraperUsername:
				browserCfg.decodoScraperUsername ||
				process.env.DECODO_SCRAPER_USERNAME ||
				process.env.DECODO_API_USERNAME,
			decodoScraperPassword:
				browserCfg.decodoScraperPassword ||
				process.env.DECODO_SCRAPER_PASSWORD ||
				process.env.DECODO_API_PASSWORD,
			solveCaptchas: browserCfg.solveCaptchas,
			captchaProvider: browserCfg.captchaProvider,
			captchaTimeoutMs: browserCfg.captchaTimeoutMs,
			captchaApiKey:
				browserCfg.captchaApiKey ||
				process.env.TWOCAPTCHA_API_KEY ||
				process.env.TWO_CAPTCHA_API_KEY ||
				process.env.TWOCAPTCHA_TOKEN,
			persistCookies: browserCfg.persistCookies,
			sessionStorageDir: browserCfg.sessionStorageDir,
			sessionTtlHours: browserCfg.sessionTtlHours,
			autoFallbackOnBlock: browserCfg.autoFallbackOnBlock,
			blockFallbackProvider: browserCfg.blockFallbackProvider,
			confirmBlockWithVision: browserCfg.confirmBlockWithVision,
			blockResources: browserCfg.blockResources,
			blockTrackerDomains: browserCfg.blockTrackerDomains,
			humanBehavior: browserCfg.humanBehavior,
			autoDismissPopups: browserCfg.autoDismissPopups,
			urlPolicy: config.security.urlPolicy,
		};

		if (!(isEmbedded || isBrightData || isDecodo || isAuto)) {
			if (browserTool) await browserTool.updateConfig(toolConfig);
			return false;
		}

		if (browserTool) {
			await browserTool.updateConfig(toolConfig);
		} else {
			browserTool = new BrowserTool(toolConfig);
			for (const tool of browserTool.createTools()) {
				registerSystemTool(tool);
			}
		}

		const mode = isBrightData
			? "Bright Data"
			: isDecodo
				? "Decodo"
				: isEmbedded
					? "Embedded"
					: "Auto";
		console.log(`  ✓ Browser tools enabled (${mode})`);
		return true;
	};

	await refreshBrowserTools();

	// Sandbox tools (Docker-based isolated execution)
	const sandboxTools = createSandboxTools();
	for (const tool of sandboxTools) {
		registerSystemTool(tool);
	}

	registerSystemTool({
		name: "manage_env",
		description:
			"Create, update, read, or delete environment variables in the database. Use this instead of .env files.",
		parameters: {
			action: {
				type: "string",
				description: "Action: 'set', 'get', 'list', 'delete'",
				required: true,
			},
			key: {
				type: "string",
				description: "The environment variable key (e.g. API_KEY)",
			},
			value: {
				type: "string",
				description: "The value to set (required for 'set' action)",
			},
			isSecret: {
				type: "boolean",
				description:
					"Whether the value should be encrypted (true) or plain text (false). Default true.",
			},
		},
		handler: async (params: Record<string, unknown>) => {
			const action = String(params.action);
			const key = params.key ? String(params.key) : undefined;
			const value = params.value ? String(params.value) : undefined;

			try {
				if (action === "list") {
					const vars = await envVarManager.list(false);
					return { success: true, output: JSON.stringify(vars, null, 2) };
				}
				if (!key)
					return {
						success: false,
						output: "",
						error: "Missing 'key' parameter",
					};

				if (action === "get") {
					const vars = await envVarManager.list(false);
					const entry = vars.find((item) => item.key === key);
					if (!entry)
						return { success: true, output: `Variable ${key} not found` };
					return {
						success: true,
						output: entry.is_secret
							? `Variable ${key} is configured as a secret; value is hidden.`
							: entry.value,
					};
				}
				if (action === "set") {
					if (!value)
						return {
							success: false,
							output: "",
							error: "Missing 'value' parameter for set action",
						};
					const isSecret = params.isSecret !== false; // default true
					await envVarManager.set(key, value, { isSecret });
					process.env[key] = value;
					if (
						[
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
						].includes(key)
					) {
						await refreshBrowserTools();
					}
					return {
						success: true,
						output: `Environment variable ${key} set successfully`,
					};
				}
				if (action === "delete") {
					const deleted = await envVarManager.delete(key);
					if (deleted) {
						delete process.env[key];
						if (
							[
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
							].includes(key)
						) {
							await refreshBrowserTools();
						}
					}
					return {
						success: true,
						output: deleted
							? `Variable ${key} deleted`
							: `Variable ${key} not found`,
					};
				}
				return { success: false, output: "", error: "Unknown action" };
			} catch (err) {
				return { success: false, output: "", error: String(err) };
			}
		},
	});

	// Load dynamic tools from ~/.octopus/tools/
	if (existsSync(dynamicToolsDir)) {
		try {
			const toolDirs = readdirSync(dynamicToolsDir, { withFileTypes: true });
			for (const entry of toolDirs) {
				if (!entry.isDirectory()) continue;
				try {
					const toolDir = join(dynamicToolsDir, entry.name);
					const toolName = registerDynamicTool(
						toolRegistry,
						toolDir,
						entry.name,
					);
					if (toolName) console.log(`  Loaded dynamic tool: ${toolName}`);
				} catch (err) {
					console.error(
						`  Failed to load dynamic tool from ${entry.name}:`,
						err instanceof Error ? err.message : err,
					);
				}
			}
		} catch (err) {
			console.error(
				"  Failed to read dynamic tools directory:",
				err instanceof Error ? err.message : err,
			);
		}
	}

	// Resolve the Z.ai/Zhipu API key from any of the configured sources: the
	// coding-plan key, the normal API key, its env-var name, or the well-known
	// env vars. This makes all four Z.ai MCP servers activate automatically
	// regardless of whether the user configured the normal key or the coding
	// plan key.
	const zhipuProvider = (
		config.ai.providers as Record<string, Record<string, unknown>>
	)?.zhipu as
		| {
				apiKey?: string;
				codingApiKey?: string;
				apiKeyEnv?: string;
				mode?: string;
		  }
		| undefined;
	const isZhipuCodingMode =
		zhipuProvider?.mode === "coding-plan" ||
		zhipuProvider?.mode === "coding-global";
	const zhipuApiKey = firstNonEmpty(
		isZhipuCodingMode ? zhipuProvider?.codingApiKey : zhipuProvider?.apiKey,
		zhipuProvider?.codingApiKey,
		zhipuProvider?.apiKey,
		readConfiguredEnv(zhipuProvider?.apiKeyEnv),
		process.env.ZHIPU_API_KEY,
		process.env.Z_AI_API_KEY,
		process.env.ZAI_API_KEY,
	);
	const mcpAutoDisabled = (config.mcp?.autoDisabled || []) as string[];
	if (zhipuApiKey) {
		const officialZaiConfigs = getZaiMCPConfigs(zhipuApiKey);
		config.mcp = config.mcp ?? { servers: {}, autoDisabled: [] };
		config.mcp.servers = config.mcp.servers ?? {};
		// Force-enable every official Z.ai server each boot so "all MCPs
		// activate" holds; users disable via the mcp.autoDisabled list.
		for (const [serverName, officialConfig] of Object.entries(
			officialZaiConfigs,
		)) {
			if (mcpAutoDisabled.includes(serverName)) continue;
			config.mcp.servers[serverName] = {
				...officialConfig,
				enabled: true,
			};
		}
		try {
			new ConfigLoader().save(config);
		} catch {
			/* config will still be used in-memory for this boot */
		}
	}

	if (config.mcp?.servers && Object.keys(config.mcp.servers).length > 0) {
		await mcpManager.loadPersisted(
			config.mcp.servers as Record<string, MCPServerConfig>,
		);
	}

	if (zhipuApiKey) {
		for (const [serverName, serverConfig] of Object.entries(
			getZaiMCPConfigs(zhipuApiKey),
		)) {
			if (mcpAutoDisabled.includes(serverName)) continue;
			if (mcpManager.getServer(serverName)) continue;
			const server = await mcpManager.addServer(serverName, serverConfig);
			if (server.status === "connected") {
				console.log(`  ✓ Z.AI MCP Server registered: ${serverName}`);
			} else {
				console.warn(
					`  ⚠ Z.AI MCP Server failed to start: ${serverName}${server.error ? ` - ${server.error}` : ""}`,
				);
			}
		}
	}

	// Web tool health/quota: probe the Z.ai search + reader servers (startup +
	// daily cron) so the agent steers straight to a fallback (browser_search /
	// pdf_read) instead of discovering an out-of-quota failure at call time.
	const toolHealth = new ToolHealthManager(db, mcpManager, {
		enabled: config.webToolsHealth?.enabled ?? true,
		cacheTtlMinutes: config.webToolsHealth?.cacheTtlMinutes ?? 360,
		breaker: config.webToolsHealth?.breaker ?? {
			consecutiveFailures: 4,
			windowMinutes: 10,
		},
	});
	toolExecutor.setHealth(toolHealth);
	if (config.webToolsHealth?.probeOnStartup !== false) {
		await toolHealth
			.runProbe()
			.catch((e: unknown) =>
				console.error("[ToolHealth] startup probe failed:", e),
			);
	}

	const agentConfig: AgentConfig = {
		id: "default-agent",
		name: "Octavio",
		description: "Agente principal de Octopus AI",
		systemPrompt: `You are Octopus AI, an intelligent assistant with memory, tool execution, and code generation capabilities.

You can:
- Execute code in JavaScript, TypeScript, Python, and Bash using the execute_code tool
- Create new reusable tools using the create_tool tool
- Read, write, and manage files using filesystem tools and manage_workspace
- Browse and search the media library using list_media
- Manage environment variables using the manage_env tool
- Run shell commands using run_command
- Install packages using install_package
- Generate and save images, audio, and video using the dedicated media tools first; use save_media only for small base64 outputs that no dedicated tool saved for you
- Remember information across conversations via your memory system
- Schedule recurring automated tasks using schedule_task (cron expressions)
- List all scheduled automations using list_tasks
- Delegate complex sub-tasks to a specialist worker agent using delegate_task
- Read and update tool execution timeouts with manage_tool_timeouts when a tool needs more time than the current limit

IMPORTANT - Tool Usage Guidelines:
1. When calling execute_code, you MUST provide BOTH "code" (the source code) AND "language" (one of: javascript, typescript, python, bash).
2. When calling run_command, you MUST provide "command" (the shell command string).
3. When calling manage_workspace, you MUST provide "action" (list/read/write/delete/mkdir) AND "path".
4. When generating images, audio, or video: use the dedicated generation tool (for example veo-video-generator, nano-banana-generate, nano-banana-edit, or TTS/audio tools) and reuse the media URL it returns. Do NOT build provider API calls manually with execute_code/run_command when a dedicated tool exists.
5. When managing API keys or environment variables, ALWAYS use manage_env. NEVER try shell commands like export/set and NEVER write .env files manually.
6. If a tool already returns a saved media URL, use that URL directly and DO NOT call save_media again.
7. To find previously generated media, use the list_media tool. NEVER use manage_workspace to search for media files — media is stored in a separate library, not the workspace.
8. If a tool times out but the task is still valid, use manage_tool_timeouts to increase that specific tool timeout before retrying. Prefer per-tool overrides instead of raising every timeout.
9. API keys, tokens, credentials JSON, private keys, proxy credentials, cookies, and passwords MUST be stored with manage_env using isSecret=true. Never print, summarize, or reveal secret values; report only whether they are configured.
10. To preview an HTML file (or any local file) you created, use browser_open_file with the absolute file path as-is, not a hand-written file:/// URL. Treat the preview as successful only if the tool result shows Current URL starting with file:/// and the snapshot/read_page reflects the expected content. If the result is about:blank, File not found, or a URL safety error, report that exact blocker; do not infer that the sandbox has no filesystem or internet. Do not use browser_eval to paste or reconstruct the whole HTML document as a fallback.

IMPORTANT - Continuity & Reconnection:
- Before replying, inspect the injected Task Ledger, Working Memory, and recent conversation context for active or recent work.
- If the user says anything ambiguous such as "hola", "continua", "sigue", "donde ibamos", "se reconecto", or asks about prior progress, assume this may be a reconnection and verify continuity before responding.
- When active or recent work exists, do not answer with a generic greeting. First state the recovered status: what was in progress, what is already complete, and what remains.
- For media-generation or file-output tasks, verify real artifacts with list_media or workspace tools before claiming counts, regenerating assets, or continuing.
- If injected context is insufficient, call recall_conversation before giving a status answer.

IMPORTANT - Shell & Platform Compatibility:
- run_command uses the host operating system's default shell. On Windows, prefer PowerShell/cmd-compatible commands instead of Unix-only commands such as head, grep, export, rm, or chmod unless the environment explicitly provides them.

IMPORTANT - Media Handling:
- Media files (images, audio, video) are stored in the Octopus media library, NOT in the workspace filesystem.
- To find a previously generated image, use list_media (optionally with search/type filters).
- Media URLs from your previous messages in the conversation history (like /api/media/file/...) are always valid and can be reused directly.
- When a dedicated media tool returns a /api/media/file/... URL, use that URL directly and do not call save_media again.
- Use save_media only when you already have a small base64 media payload and no dedicated tool saved it.
- After saving or receiving a saved media URL, include the media in your response using markdown image/audio syntax.
- Never output <tool_call>, <tool_call_block>, or pseudo-tool XML/HTML as text. Tool calls must be real structured tool calls only.

IMPORTANT - Autonomy & Delegation:
- When the user asks you to do something periodically (e.g. "every morning", "cada hora", "todos los domingos"), create an automation using schedule_task with the appropriate cron expression.
- When a request is extremely complex and involves multiple independent sub-problems (e.g. "research X AND write code for Y AND create a document for Z"), use delegate_task to assign isolated sub-tasks to specialist worker agents. Each worker runs independently with its own context. This prevents your memory from overflowing and speeds up execution.
- You are the Manager. Workers report back to you. Synthesize their results into a coherent final answer for the user.

IMPORTANT - Browser Automation:
- You have browser tools: browser_open_file, browser_navigate, browser_screenshot, browser_click, browser_type, browser_eval, browser_read_page, browser_extract_images, browser_observe, browser_solve_captchas, browser_etsy_task.
- Use browser_navigate for http(s) web URLs. Use browser_open_file for local files. Browser tools are separate from sandbox_execute; Docker sandbox limitations do not imply browser/local-file limitations.
- Use these to visit websites, fill forms, scrape content, and interact with web applications on behalf of the user.
- For generated websites, before sending a screenshot, verify image loading through the browser_open_file/browser_screenshot image summary or page inspection. If external images fail in the agent browser but work for the user, report the exact failed URLs/statuses instead of rewriting the design or silently substituting assets.
- Use the simplest sufficient browser action first. Prefer direct URLs or specialized extract tools before manual click/type loops.
- Navigate step by step and decide intelligently: before each browser action, evaluate what changed after the previous action and what observable change the next action should produce.
- Use browser_observe when uncertain about the current page, available buttons/inputs/listings, or whether a previous action made progress.
- You can also take screenshots with browser_screenshot and interact with page elements.
- For CAPTCHA or anti-bot pages, never say the CAPTCHA was solved unless a fresh snapshot/read/screenshot shows the verification UI is gone. browser_solve_captchas is only an attempt unless it returns verifiedClear=true; if the challenge remains visible, report the blocker, ask for manual completion, or use a source-specific/non-Google alternative.

IMPORTANT - Image/Product Page Extraction:
- For Etsy requests, prefer normal step-by-step navigation with direct search URLs, browser_observe, listing links, product page screenshots, and browser_extract_images. browser_etsy_task is only a fallback if step-by-step navigation repeatedly stalls or the user explicitly requests a compact flow.
- When the user asks to show, list, retrieve, or capture multiple images from a page or product, do not start by clicking thumbnails one by one.
- First use browser_extract_images on the product/page to collect img currentSrc/src/srcset, picture/source srcset, anchors, inline styles, CSS background images, OpenGraph, and embedded JSON.
- Use browser_eval only if browser_extract_images misses required data.
- Deduplicate normalized URLs, prefer the largest/highest-resolution version, keep an internal obtained/pending count, and avoid recapturing images already found.
- Only use screenshots or thumbnail clicks when direct DOM/network extraction cannot reveal the requested images.
- If browser_extract_images returns image URLs, answer immediately with what is available and do not keep navigating unless a required artifact is still missing.
- Final answers should present the images or URLs in a compact ordered list/table and mention only missing items or blockers. Keep action narration out of the final answer, but before a tool call you may provide one concise present-tense activity sentence such as "Ingresando la búsqueda", "Tomando captura", or "Extrayendo URLs"; the UI will show it as transient progress.

IMPORTANT - Sandbox Execution:
- Use sandbox_execute to run potentially dangerous or untrusted code in an isolated Docker container.
- The container has no network access, limited memory, and is destroyed after execution.
- Use this when the user asks you to run code you generated, test scripts, or execute commands that could affect the system.
- If Docker is not installed, inform the user they need Docker Desktop for sandbox features.

IMPORTANT - File Creation & Workspace (two explicit roots, never derived from process.cwd()):
- workspaceDir = ${workspaceDir} — where you CREATE files. Relative paths in read_file/write_file/list_directory/search_files/create_directory/move_file/copy_file/delete_file resolve here and cannot escape it with "..".
- installRoot = ${installRoot} — where Octopus itself is installed. NEVER read, modify, or delete anything under installRoot (its own source/code/config) unless the user explicitly asks for it.
- For the user's OWN files outside the workspace, use an absolute or ~/ path within the allowed paths, only when the user asks.
- Create new projects, documents, and generated artifacts inside the workspace by default (e.g. "myproject/index.html"). The tool result returns the absolute path where the file landed.
- To organize files (move, copy, rename, delete), PREFER move_file/copy_file/delete_file over run_command; they enforce the same workspace and allowed-paths policy and reject ".." escapes.
- Only touch a different absolute/~/ location when the user explicitly asks for it and that path is within the allowed paths. Never write into the application's own source directory or assume a layout there.
- Destructive actions (delete_file) OUTSIDE the workspace require explicit user confirmation before you run them; inside the workspace they are fine.

				IMPORTANT - Z.AI MCP Tools:
				- When a user shares an image, the message can contain a media URL like ![Image](/api/media/file/uuid.png) plus a runtime-injected local media path, or a file path like [Uploaded image: C:\\Users\\...\\media\\uuid.png].
				- MANDATORY when the active model CANNOT see images natively (text-only models, including Z.ai/Zhipu GLM, which is not reliably multimodal): if ANY user message, assistant message, or tool result in this conversation references an image — a media URL like ![Image](/api/media/file/<uuid>.png), a tag like [Uploaded image: <local-path>], or an <!-- octopus-local-media-paths: "<local-path>" --> comment — you MUST call the analyze_image Z.AI Vision MCP tool (or its namespaced alias) with that image's local media path, and rely on the tool's result, BEFORE you answer about, describe, regenerate, or act on the image. Never say you cannot see or analyze the image, and never describe it from the filename alone. Resolve the local path from the media URL filename (/api/media/file/<uuid>.png maps to ~/.octopus/media/<uuid>.png, e.g. C:\\Users\\<you>\\.octopus\\media\\<uuid>.png) or take it directly from the [Uploaded image: ...] tag or the octopus-local-media-paths comment. Available tool names may be plain (analyze_image, extract_text_from_screenshot, diagnose_error_screenshot, understand_technical_diagram, analyze_data_visualization, ui_to_artifact, ui_diff_check, analyze_video) or namespaced aliases containing those names.
				- If the user asks you to analyze an image and a vision tool is available, call it. Do not claim that image analysis is unavailable just because the image was referenced through /api/media/file/...; use the local media path injected by runtime.
				- If the active model CAN see images natively (it is multimodal), inspect image content directly from the embedded image and do not call Z.AI Vision MCP tools solely to inspect screenshots.
				- Example: if the user asks "what is in this image?" and the message contains or is followed by a local media path, call the available analyze_image tool (or its namespaced alias) with that path using the parameter required by the tool schema.
				- Use extract_text_from_screenshot for screenshots with code or text
				- Use understand_technical_diagram for diagrams and flowcharts
				- Use analyze_data_visualization for charts and graphs
				- Use ui_to_artifact to generate code from UI screenshots
				- Use webReader when the user wants the full contents of a specific URL, article, or documentation page.
				- Use webSearchPrime when the user needs fresh public web results, current events, or recent external information.
				- Use search_doc and get_repo_structure to research public GitHub repositories through ZRead.
				- Use zai-zread__read_file to read files from public GitHub repositories through ZRead.
				- Use the local read_file tool for files in the current workspace. Use zai-zread__read_file only for remote/public GitHub repository content.
				
Use the simplest sufficient action first. Answer directly when no tool is required. Prefer local/read-only/specialized tools before browser, shell, generic code execution, or delegation.
Always be concise, helpful, and thorough.`,
		model: config.ai.default,
		maxTokens: config.ai.maxTokens,
		toolIterationLimit: config.tools.iterationLimit,
		continuityGuard: config.continuityGuard,
		tenacidad: config.tenacidad,
	};

	// Octavio's persisted `agents.model` is the source of truth. Apply it to the
	// runtime config so the main agent respects the model chosen by the user
	// instead of always falling back to `config.ai.default`.
	const existingMainAgent = await agentManager.getMainAgent();
	if (existingMainAgent?.model) {
		agentConfig.model = existingMainAgent.model;
	}

	const agentRuntime = new AgentRuntime(
		agentConfig,
		router,
		stm,
		memoryRetrieval,
		memoryConsolidator,
		skillLoader,
	);
	agentRuntime.setToolSystem(toolRegistry, toolExecutor);
	agentRuntime.setResearcher(skillResearcher);
	agentRuntime.setDailyMemory(dailyMemory);
	agentRuntime.setUserProfileManager(userProfileManager);
	agentRuntime.setMemoryOrchestrator(memoryOrchestrator);
	agentRuntime.setContextAssembler(contextAssembler);
	agentRuntime.setLearningEngine(learningEngine);
	agentRuntime.setChatManager(chatManager);
	agentRuntime.setWorkflowManager(workflowManager);
	agentRuntime.setKanbanPlanner(kanbanPlanner);
	agentRuntime.setRequirementResolver(requirementResolver);
	agentRuntime.enableOrchestrator({
		maxWorkers: config.orchestration?.maxArms ?? 8,
		getAgentRuntime: (agentId: string) => agentManager.getRuntime(agentId),
		complexityThreshold: 5,
		decompositionTimeoutMs:
			config.orchestration?.decompositionTimeoutMs ?? 30_000,
		synthesisTimeoutMs: config.orchestration?.synthesisTimeoutMs ?? 10_000,
		synthesisMaxTokens: config.orchestration?.synthesisMaxTokens ?? 1200,
		workerConfig: {
			maxToolIterations: config.orchestration?.maxToolIterationsPerArm ?? 32,
			timeoutMs: config.orchestration?.workerTimeoutMs ?? 600_000,
		},
	});
	agentRuntime
		.getOrchestrator()
		?.setKanbanPlanner(kanbanPlanner, requirementResolver);
	await agentRuntime.initialize();
	teamBlackboard.registerOrchestrator(agentRuntime);

	const mainAgentRecord: AgentRecord = {
		id: agentConfig.id,
		name: agentConfig.name,
		description: agentConfig.description,
		role: "coordinator",
		personality:
			"Director estrategico, cercano y resolutivo. Coordina a sus brazos con calma, exige evidencia verificable y sintetiza decisiones sin perder el contexto del usuario.",
		system_prompt: agentConfig.systemPrompt,
		model: agentConfig.model ?? null,
		avatar: "Pulpo_octavio.png",
		color: "#3b82f6",
		is_default: 1,
		is_main: 1,
		parent_id: null,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		config: null,
	};
	const existingMain = await agentManager.getMainAgent();
	if (!existingMain) {
		await db.run(
			"INSERT OR IGNORE INTO agents (id, name, description, role, personality, system_prompt, model, avatar, color, is_default, is_main, parent_id, created_at, updated_at, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				mainAgentRecord.id,
				mainAgentRecord.name,
				mainAgentRecord.description,
				mainAgentRecord.role,
				mainAgentRecord.personality,
				mainAgentRecord.system_prompt,
				mainAgentRecord.model,
				mainAgentRecord.avatar,
				mainAgentRecord.color,
				mainAgentRecord.is_default,
				mainAgentRecord.is_main,
				mainAgentRecord.parent_id,
				mainAgentRecord.created_at,
				mainAgentRecord.updated_at,
				mainAgentRecord.config,
			],
		);
	} else if (
		existingMain.name === "Octopus AI" ||
		!existingMain.avatar ||
		existingMain.description === "Default Octopus AI agent" ||
		!existingMain.personality
	) {
		await db.run(
			"UPDATE agents SET name = ?, description = ?, personality = CASE WHEN personality IS NULL OR personality = '' THEN ? ELSE personality END, avatar = ?, color = COALESCE(color, ?), updated_at = ? WHERE id = ?",
			[
				mainAgentRecord.name,
				mainAgentRecord.description,
				mainAgentRecord.personality,
				mainAgentRecord.avatar,
				mainAgentRecord.color,
				new Date().toISOString(),
				existingMain.id,
			],
		);
	}
	await agentManager.ensureBuiltinArmAgents(config.ai.default);
	agentManager.registerRuntime(agentConfig.id, agentRuntime);

	// Seed Octavio's per-model reasoning profile so the main agent starts with a
	// sensible thinking level (from the global setting, validated vs capabilities).
	try {
		const octavioModel = agentConfig.model ?? config.ai.default;
		const octavioReasoning = await resolveInitialReasoning(
			agentManager,
			config,
			agentConfig.id,
			octavioModel,
		);
		agentConfig.reasoningEffort = octavioReasoning;
		agentRuntime.updateConfig({ reasoningEffort: octavioReasoning });
	} catch (err) {
		console.error("[bootstrap] failed to seed Octavio reasoning profile:", err);
	}

	const persistedAgents = await agentManager.listAgents();
	for (const agent of persistedAgents) {
		if (agent.id === agentConfig.id) continue;
		const armEffectiveModel = agent.model ?? config.ai.default;
		const armReasoning = await resolveInitialReasoning(
			agentManager,
			config,
			agent.id,
			armEffectiveModel,
		);
		const runtimeConfig = buildAgentRuntimeConfig(
			agent,
			agentConfig,
			armReasoning,
		);
		const runtimeStm = new ShortTermMemory({
			maxTokens: config.memory.shortTerm.maxTokens,
			scratchPadSize: config.memory.shortTerm.scratchPadSize,
			autoEviction: config.memory.shortTerm.autoEviction,
			tokenCounter: {
				countTokens: (text: string) => tokenCounter.countTokens(text),
				countMessagesTokens: (msgs: { content: string }[]) =>
					msgs.reduce((sum, m) => sum + tokenCounter.countTokens(m.content), 0),
			},
		});
		const runtime = new AgentRuntime(
			runtimeConfig,
			router,
			runtimeStm,
			memoryRetrieval,
			memoryConsolidator,
			skillLoader,
		);
		runtime.setToolSystem(toolRegistry, toolExecutor);
		runtime.setResearcher(skillResearcher);
		runtime.setDailyMemory(dailyMemory);
		runtime.setUserProfileManager(userProfileManager);
		runtime.setMemoryOrchestrator(memoryOrchestrator);
		runtime.setContextAssembler(contextAssembler);
		runtime.setLearningEngine(learningEngine);
		runtime.setChatManager(chatManager);
		runtime.setWorkflowManager(workflowManager);
		runtime.setKanbanPlanner(kanbanPlanner);
		runtime.setRequirementResolver(requirementResolver);
		runtime.enableOrchestrator({
			maxWorkers: config.orchestration?.maxArms ?? 8,
			getAgentRuntime: (agentId: string) => agentManager.getRuntime(agentId),
			complexityThreshold: 5,
			decompositionTimeoutMs:
				config.orchestration?.decompositionTimeoutMs ?? 30_000,
			synthesisTimeoutMs: config.orchestration?.synthesisTimeoutMs ?? 10_000,
			synthesisMaxTokens: config.orchestration?.synthesisMaxTokens ?? 1200,
			workerConfig: {
				maxToolIterations: config.orchestration?.maxToolIterationsPerArm ?? 32,
				timeoutMs: config.orchestration?.workerTimeoutMs ?? 600_000,
			},
		});
		runtime
			.getOrchestrator()
			?.setKanbanPlanner(kanbanPlanner, requirementResolver);
		await runtime.initialize();
		agentManager.registerRuntime(agent.id, runtime);
	}

	const connectionManager = new ConnectionManager({
		retryMaxAttempts: config.connection.retryMaxAttempts,
		retryBaseDelay: config.connection.retryBaseDelay,
		circuitBreakerThreshold: config.connection.circuitBreakerThreshold,
		healthCheckInterval: config.connection.healthCheckInterval,
		offlineQueueSize: config.connection.offlineQueueSize,
		preferIPv4: config.connection.preferIPv4,
	});

	const pluginRegistry = new PluginRegistry();
	const pluginMarketplace = new PluginMarketplace(pluginRegistry);

	const skillMarketplace = new SkillMarketplace(skillRegistry, embedFn);

	const automationRunner = new AutomationRunner(
		automationManager,
		async (actionType, actionConfig) => {
			if (actionType === "agent_prompt") {
				const promptConfig =
					typeof actionConfig === "object" && actionConfig !== null
						? (actionConfig as Record<string, unknown>)
						: {};
				const prompt = String(promptConfig.prompt ?? "") || "Tick";
				console.log(
					`[CronRunner] Spawning background prompt to Agent: ${prompt}`,
				);
				// Start background turn by bypassing human input requirements.
				const systemTurn = {
					role: "user" as const,
					content: `[SYSTEM TRIGGER] ${prompt}`,
					timestamp: new Date(),
				};
				agentRuntime.stm.add(systemTurn);
				const context = await memoryRetrieval.retrieveForContext(
					systemTurn.content,
				);

				const stream = agentRuntime.processMessageStream(
					systemTurn.content,
					"system_cron",
				);
				for await (const _chunk of stream) {
					// Fire and forget
				}
			}
		},
	);

	const systemScheduler = new Scheduler();
	const bootstrapLogger = createLogger("bootstrap");
	const orchestrator = agentRuntime.getOrchestrator();
	if (!orchestrator) {
		throw new Error("Orchestrator was not initialized for durable workflows.");
	}
	const workflowScheduler = new WorkflowScheduler(
		workflowManager,
		orchestrator,
		{
			limit: config.orchestration?.maxArms ?? 3,
			onError: (error, run) => {
				bootstrapLogger.error(
					`Error resuming workflow '${run.id}': ${error instanceof Error ? error.message : String(error)}`,
				);
			},
		},
	);
	const durableOrchestrationEnabled =
		config.orchestration?.enabled !== false &&
		config.orchestration?.mode !== "legacy";
	// Shared event stream for durable workflows: the dispatcher's taskExecutor
	// appends progress events here, and the agent runtime subscribes to stream
	// them live into the chat (Hermes-style) after kanban_create_plan_from_goal.
	const durableEventStream = new EventStream();
	const kanbanDispatcher = new KanbanDispatcher(
		workflowManager,
		requirementResolver,
		{
			enabled: durableOrchestrationEnabled,
			limit: config.orchestration?.maxArms ?? 5,
			maxConcurrentTasks: config.orchestration?.maxArms ?? 5,
			maxConcurrentPerArm: 2,
			leaseTtlMs: config.orchestration?.workerTimeoutMs ?? 600_000,
			defaultAgentId: agentConfig.id,
			onError: (error, task) => {
				bootstrapLogger.error(
					`Error executing Kanban task '${task.id}': ${error instanceof Error ? error.message : String(error)}`,
				);
				durableEventStream.append({
					runId: task.run_id,
					taskId: task.id,
					workerId: task.assigned_agent_id ?? agentConfig.id,
					type: "error",
					data: {
						error: error instanceof Error ? error.message : String(error),
						message: `Error en: ${task.title}`,
					},
				});
			},
			taskExecutor: async ({ task, leaseToken }) => {
				const taskContext = await workflowManager.getTaskContext(task.id);
				const missingRequirements = taskContext?.missingRequirements
					.slice(0, 10)
					.map(
						(requirement) =>
							`- ${requirement.requirement_key}: ${requirement.requirement_type} ${requirement.artifact_key ?? requirement.required_task_id ?? "manual/time"} (${requirement.artifact_type ?? requirement.required_status ?? "pending"})`,
					)
					.join("\n");
				const matchingArtifacts = taskContext?.matchingArtifacts
					.slice(0, 10)
					.map(
						(artifact) =>
							`- ${artifact.artifact_key ?? artifact.id}: ${artifact.artifact_type}, verified=${artifact.exists_verified === 1}, location=${artifact.url ?? artifact.path ?? "none"}`,
					)
					.join("\n");
				const blockers = taskContext?.blockers
					.filter((blocker) => !blocker.resolved_at)
					.slice(0, 5)
					.map((blocker) => `- ${blocker.severity}: ${blocker.reason}`)
					.join("\n");
				const recentComments = taskContext?.comments
					.slice(-5)
					.map((comment) => `- ${comment.comment_type}: ${comment.body}`)
					.join("\n");
				const runtime = task.assigned_agent_id
					? agentManager.getRuntime(task.assigned_agent_id)
					: undefined;
				const selectedRuntime = runtime ?? agentRuntime;
				const prompt = [
					"Subtarea Kanban Swarm asignada por Octavio.",
					`Task ID: ${task.id}`,
					`Claim token: ${leaseToken}`,
					task.arm_key ? `Arm key: ${task.arm_key}` : "",
					`Titulo: ${task.title}`,
					task.description ? `Descripcion: ${task.description}` : "",
					task.acceptance_criteria
						? `Criterios de aceptacion JSON: ${task.acceptance_criteria}`
						: "",
					task.produces ? `Artifacts esperados JSON: ${task.produces}` : "",
					missingRequirements
						? `Requisitos obligatorios pendientes:\n${missingRequirements}`
						: "Requisitos obligatorios pendientes: ninguno.",
					matchingArtifacts
						? `Artifacts relacionados disponibles:\n${matchingArtifacts}`
						: "Artifacts relacionados disponibles: ninguno registrado aun.",
					blockers
						? `Blockers abiertos:\n${blockers}`
						: "Blockers abiertos: ninguno.",
					recentComments
						? `Comentarios recientes:\n${recentComments}`
						: "Comentarios recientes: ninguno.",
					"Este contexto es artifact-agnostico: puede representar research, report, spec, implementation, dataset, analysis, image, video, QA u otros tipos. Respeta artifact_key y artifact_type exactamente.",
					"Puedes usar workflow_get_task_context para ver el contexto completo si necesitas mas detalle.",
					"Durante tareas largas usa workflow_heartbeat con task_id y claim_token.",
					"Si produces un artifact, registralo con workflow_record_artifact usando el artifact_key esperado.",
					"Termina con workflow_complete_task. Si necesitas revision humana usa workflow_request_review. Si no puedes avanzar usa workflow_block_task.",
				]
					.filter(Boolean)
					.join("\n\n");
				durableEventStream.append({
					runId: task.run_id,
					taskId: task.id,
					workerId: task.assigned_agent_id ?? agentConfig.id,
					type: "task_claimed",
					data: { message: `Iniciando: ${task.title}` },
				});
				for await (const _chunk of selectedRuntime.processMessageStream(
					prompt,
					"kanban_dispatcher",
					{
						disableOrchestrator: true,
						disableDelegation: true,
					},
				)) {
					/* progress is persisted through workflow tools */
				}
				const latest = await workflowManager.getTask(task.id);
				durableEventStream.append({
					runId: task.run_id,
					taskId: task.id,
					workerId: task.assigned_agent_id ?? agentConfig.id,
					type: latest?.status === "done" ? "result" : "progress",
					data: {
						message:
							latest?.status === "done"
								? `Completada: ${task.title}`
								: `Requiere revisión: ${task.title}`,
					},
				});
				if (latest?.status === "running") {
					await workflowManager.updateTaskStatus(task.id, "review", {
						metadata: {
							reviewReason:
								"Worker finished without explicit workflow_complete_task.",
						},
					});
					await workflowManager.recordEvent({
						runId: task.run_id,
						taskId: task.id,
						agentId: task.assigned_agent_id ?? agentConfig.id,
						eventType: "review_requested",
						message:
							"Worker stream ended without explicit completion; Octavio review required.",
					});
				}
			},
		},
	);
	await kanbanDispatcher.loadPersistedState();
	agentRuntime.setKanbanDispatcher(kanbanDispatcher);
	agentRuntime.setDurableEventStream(durableEventStream);
	const workflowTools = createWorkflowTools(
		workflowManager,
		requirementResolver,
		kanbanPlanner,
		artifactVerifier,
		kanbanDispatcher,
	);
	for (const tool of workflowTools) {
		registerSystemTool(tool);
	}
	if (durableOrchestrationEnabled) {
		void workflowScheduler.tick();
		void kanbanDispatcher.tick();
		systemScheduler.schedule("workflow-resume", "*/1 * * * *", async () => {
			await workflowManager.markStaleRunsInterrupted();
			await workflowScheduler.tick();
			await kanbanDispatcher.tick();
		});
	}
	const memoryRetentionScheduler = new MemoryRetentionScheduler(
		memoryOrchestrator,
		systemScheduler,
		config.memory.retention,
		bootstrapLogger,
	);
	memoryRetentionScheduler.start();

	// Re-probe web tool quota on a schedule (default daily ~03:17) so the
	// cached health stays fresh and the agent keeps steering correctly.
	systemScheduler.schedule(
		"web-tools-health",
		config.webToolsHealth?.probeCron ?? "17 3 * * *",
		async () => {
			try {
				await toolHealth.runProbe();
			} catch (e) {
				bootstrapLogger.error(`Tool health scheduled probe failed: ${e}`);
			}
		},
	);

	systemScheduler.schedule("daily-memory-dump", "0 0 * * *", async () => {
		try {
			bootstrapLogger.info("Executing End-of-Day Global Memory Flush...");
			const todayStr = new Date().toISOString().split("T")[0];
			const dump = await dailyMemory.dumpAndClear(todayStr);
			if (dump) {
				const fullContent = `Daily Digest:\n${dump}`;
				const source = {
					sourceId: `daily_${todayStr}`,
					sourceType: "system" as const,
					title: `Daily memory digest ${todayStr}`,
					channelId: "system_cron",
					conversationId: `daily_${todayStr}`,
					quotedEvidence: dump.slice(0, 2000),
					authorityScore: 1,
				};
				await memoryOrchestrator.write({
					type: "episodic",
					content: fullContent,
					sourceTrust: "system",
					scope: {
						tenantId: "local",
						userId: "owner",
						projectId: process.cwd(),
						sessionId: "system_cron",
						taskId: `daily_${todayStr}`,
					},
					importance: 0.9,
					confidence: 0.9,
					source,
					metadata: { type: "daily_summary", date: todayStr },
					evidence: {
						sourceType: "task_result",
						sourceId: `daily_${todayStr}`,
						excerpt: dump.slice(0, 1200),
					},
				});
			}
		} catch (err) {
			bootstrapLogger.error(`Error during End-of-Day LTM sync: ${err}`);
		}
	});

	return {
		config,
		db,
		router,
		usageStore,
		stm,
		ltm,
		dailyMemory,
		userProfileManager,
		memoryOrchestrator,
		memoryRetentionScheduler,
		contextAssembler,
		memoryRetrieval,
		memoryConsolidator,
		skillRegistry,
		skillLoader,
		skillForge,
		skillImprover,
		learningEngine,
		skillMarketplace,
		agentRuntime,
		connectionManager,
		pluginRegistry,
		pluginMarketplace,
		codeExecutor,
		toolHealth,
		toolRegistry,
		chatManager,
		agentManager,
		agentMessageBus,
		workflowManager,
		workflowScheduler,
		requirementResolver,
		kanbanPlanner,
		kanbanDispatcher,
		knowledgeManager,
		taskManager,
		automationManager,
		automationRunner,
		systemScheduler,
		envVarManager,
		mcpManager,
		browserTool,
		refreshBrowserTools,
		refreshEmbeddingProvider,
		reloadDynamicTool,
		toolExecutor,
		embedFn,
		shutdown: async () => {
			memoryRetentionScheduler.stop();
			systemScheduler.cancel("workflow-resume");
			systemScheduler.cancel("daily-memory-dump");
			systemScheduler.cancel("web-tools-health");
			await mcpManager.shutdown();
			connectionManager.shutdown();
			await db.close();
		},
	};
}
