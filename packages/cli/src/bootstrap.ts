import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as os from "node:os";
import { join } from "node:path";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	AgentManager,
	AgentMessageBus,
	AgentRuntime,
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
	FTSSearchEngine,
	GlobalDailyMemory,
	LLMRouter,
	LearningEngine,
	LongTermMemory,
	MCPManager,
	MemoryConsolidator,
	MemoryOrchestrator,
	MemoryRetrieval,
	PluginMarketplace,
	PluginRegistry,
	Scheduler,
	ShortTermMemory,
	SkillForge,
	SkillImprover,
	SkillLoader,
	SkillMarketplace,
	SkillRegistry,
	TaskManager,
	TeamBlackboard,
	TokenCounter,
	ToolExecutor,
	ToolRegistry,
	UserProfileManager,
	createAutomationTools,
	createDatabaseAdapter,
	createFileSystemTools,
	createLogger,
	createMediaTools,
	createSandboxTools,
	createShellTool,
	createTeamCommTools,
	createTeamTools,
	createVectorStore,
	expandTildePath,
	getZaiMCPConfigs,
} from "@octopus-ai/core";
import type {
	AgentConfig,
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
	stm: ShortTermMemory;
	ltm: LongTermMemory;
	dailyMemory: GlobalDailyMemory;
	userProfileManager: UserProfileManager;
	memoryOrchestrator: MemoryOrchestrator;
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
	codeExecutor: CodeExecutor;
	chatManager: ChatManager;
	agentManager: AgentManager;
	agentMessageBus: AgentMessageBus;
	envVarManager: EnvVarManager;
	taskManager: TaskManager;
	automationManager: AutomationManager;
	automationRunner: AutomationRunner;
	systemScheduler: Scheduler;
	mcpManager: MCPManager;
	browserTool: BrowserTool | null;
	refreshBrowserTools: (nextConfig?: OctopusConfig) => Promise<boolean>;
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
	baseUrl?: string;
};

type BrowserRuntimeConfig = {
	provider?: "auto" | "embedded" | "brightdata" | "decodo" | string;
	headless?: boolean;
	chromiumSandbox?: boolean;
	brightDataEnabled?: boolean;
	brightDataWsUrl?: string;
	decodoEnabled?: boolean;
	decodoProxyUrl?: string;
	solveCaptchas?: boolean;
	captchaProvider?: string;
	captchaTimeoutMs?: number;
	persistCookies?: boolean;
	sessionStorageDir?: string;
	sessionTtlHours?: number;
	autoFallbackOnBlock?: boolean;
	blockFallbackProvider?: string;
	confirmBlockWithVision?: boolean;
	blockResources?: string[];
	blockTrackerDomains?: string[];
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

// --- Real Embedding Provider (Multi-Provider) ---
function createEmbeddingProvider(config: OctopusConfig): EmbeddingProvider {
	type ApiType = "openai" | "google" | "cohere" | "ollama";

	let apiKey = "";
	let baseUrl = "";
	let model = "";
	let apiType: ApiType = "openai";
	let dimensions = 1024;
	let providerName = "";

	// Priority chain: zhipu → openai → google → deepseek → mistral → xai → cohere → ollama
	const providers = config.ai.providers;
	const optionalProviders = providers as Record<
		string,
		OptionalProviderConfig | undefined
	>;

	// 1. Zhipu/Z.ai (OpenAI-compatible)
	if (!apiKey && providers.zhipu?.apiKey) {
		apiKey = providers.zhipu.apiKey;
		// Always use global API for embeddings (embedding-3 only exists on api.z.ai)
		baseUrl = "https://api.z.ai/api/paas/v4";
		model = "embedding-3";
		apiType = "openai";
		dimensions = 1024;
		providerName = "Z.ai";
	}

	// 2. OpenAI
	if (!apiKey && providers.openai?.apiKey) {
		apiKey = providers.openai.apiKey;
		baseUrl = "https://api.openai.com/v1";
		model = "text-embedding-3-small";
		apiType = "openai";
		dimensions = 1536;
		providerName = "OpenAI";
	}

	// 3. Google/Gemini (native API)
	if (!apiKey && providers.google?.apiKey) {
		apiKey = providers.google.apiKey;
		baseUrl = "https://generativelanguage.googleapis.com";
		model = "text-embedding-004";
		apiType = "google";
		dimensions = 768;
		providerName = "Google";
	}

	// 4. DeepSeek (OpenAI-compatible)
	const deepseek = optionalProviders.deepseek;
	const deepseekApiKey = deepseek?.apiKey;
	if (!apiKey && deepseekApiKey) {
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
	if (!apiKey && mistralApiKey) {
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
	if (!apiKey && xaiApiKey) {
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
	if (!apiKey && cohereApiKey) {
		apiKey = cohereApiKey;
		baseUrl = cohere.baseUrl || "https://api.cohere.com";
		model = "embed-multilingual-v3.0";
		apiType = "cohere";
		dimensions = 1024;
		providerName = "Cohere";
	}

	// 8. Ollama (local, no API key needed)
	if (!apiKey && providers.local) {
		const localUrl = providers.local.baseUrl || "http://localhost:11434";
		apiKey = "ollama"; // Ollama doesn't need real key, but we use it as flag
		baseUrl = localUrl;
		model = "nomic-embed-text";
		apiType = "ollama";
		dimensions = 768;
		providerName = "Ollama";
	}

	const provider = new EmbeddingProvider({
		apiKey: apiKey === "ollama" ? "nokey" : apiKey,
		baseUrl,
		model,
		apiType,
		dimensions,
		maxBatchSize: apiType === "ollama" ? 8 : 32,
		maxTextLength: 8000,
		cacheSize: 500,
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

export async function bootstrap(options?: {
	configPath?: string;
}): Promise<OctopusSystem> {
	const loader = new ConfigLoader(options?.configPath);
	let config = loader.load();

	const db = createDatabaseAdapter(
		config.storage.backend as "sqlite" | "postgresql" | "mysql" | "mongodb",
		{
			path: config.storage.path,
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

	const vectorStore = createVectorStore(config.memory.longTerm.backend, db);
	const ltm = new LongTermMemory(vectorStore, db);

	// Real Embedding Provider — replaces the old hash-based stub
	const embeddingProvider = createEmbeddingProvider(config);
	const embedFn: EmbeddingFunction = embeddingProvider.getEmbedFunction();

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

	const providers: Record<string, ProviderConfig & { mode?: string }> = {};
	const providerEntries = Object.entries(config.ai.providers) as Array<
		[
			string,
			{ apiKey?: string; baseUrl?: string; models?: string[]; mode?: string },
		]
	>;
	for (const [name, pConfig] of providerEntries) {
		if (name === "local") {
			providers.local = {
				baseUrl: pConfig.baseUrl || "http://localhost:11434",
			};
		} else if (pConfig.apiKey) {
			providers[name] = {
				apiKey: pConfig.apiKey,
				...(pConfig.baseUrl ? { baseUrl: pConfig.baseUrl } : {}),
				...(pConfig.mode ? { mode: pConfig.mode } : {}),
			};
		}
	}

	const router = new LLMRouter({
		default: config.ai.default,
		fallback: config.ai.fallback,
		providers,
		thinking: config.ai.thinking,
	});
	await router.initialize();

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
	const teamBlackboard = new TeamBlackboard();
	const envVarManager = new EnvVarManager(db);
	const managedEnv = await envVarManager.toProcessEnv();
	for (const [key, value] of Object.entries(managedEnv)) {
		if (!(key in process.env)) {
			process.env[key] = value;
		}
	}
	const taskManager = new TaskManager(db);
	const automationManager = new AutomationManager(db);
	const mcpManager = new MCPManager();

	const toolRegistry = new ToolRegistry();
	const dynamicToolsDir = join(homedir(), ".octopus", "tools");
	const reloadDynamicTool = async (name: string): Promise<boolean> => {
		const toolDir = join(dynamicToolsDir, name);
		return Boolean(registerDynamicTool(toolRegistry, toolDir, name));
	};

	const codeExecutor = new CodeExecutor(undefined, {
		onToolCreated: async ({ name }) => {
			await reloadDynamicTool(name);
		},
	});
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

	const toolConfig = config.tools as OctopusConfig["tools"] & {
		disabled?: string[];
		allowedPaths?: string[];
	};
	const disabledTools = toolConfig.disabled || [];

	const registerSystemTool = (tool: ToolDefinition) => {
		if (disabledTools.includes(tool.name)) return;
		tool.metadata = { ...tool.metadata, source: "system" };
		toolRegistry.register(tool);
	};

	const defaultAllowedPaths = [
		os.homedir(),
		path.join(os.homedir(), ".octopus"),
		process.cwd(),
	];
	const userAllowedPaths = toolConfig.allowedPaths || [];
	const allowedPaths = [
		...new Set([...defaultAllowedPaths, ...userAllowedPaths]),
	];

	const toolExecutor = new ToolExecutor(toolRegistry, {
		sandboxCommands: true,
		allowedPaths,
		timeouts: config.tools.timeouts,
	});

	const filesystemTools = createFileSystemTools(allowedPaths);
	for (const tool of filesystemTools) {
		registerSystemTool(tool);
	}

	const shellTool = createShellTool({
		sandboxCommands: true,
	});
	registerSystemTool(shellTool);

	const codeTools = codeExecutor.createTools();
	for (const tool of codeTools) {
		registerSystemTool(tool);
	}

	const mediaTools = createMediaTools();
	for (const tool of mediaTools) {
		registerSystemTool(tool);
	}

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

	const teamTools = createTeamTools(async (task, role) => {
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
			sandboxCommands: true,
			allowedPaths,
			timeouts: config.tools.timeouts,
		});
		workerRuntime.setToolSystem(workerToolRegistry, workerToolExecutor);
		workerRuntime.setLearningEngine(learningEngine);

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
			chromiumSandbox: browserCfg.chromiumSandbox,
			provider: browserCfg.provider,
			brightDataEnabled,
			brightDataWsUrl,
			decodoEnabled,
			decodoProxyUrl,
			decodoProxyUsername:
				process.env.DECODO_PROXY_USERNAME || process.env.DECODO_PROXY_USER,
			decodoProxyPassword:
				process.env.DECODO_PROXY_PASSWORD || process.env.DECODO_PROXY_PASS,
			decodoProxyCountry: process.env.DECODO_PROXY_COUNTRY,
			decodoProxyCity: process.env.DECODO_PROXY_CITY,
			decodoProxyState: process.env.DECODO_PROXY_STATE,
			decodoProxyZip: process.env.DECODO_PROXY_ZIP,
			decodoProxySession: process.env.DECODO_PROXY_SESSION,
			decodoProxySessionDuration: process.env.DECODO_PROXY_SESSION_DURATION,
			solveCaptchas: browserCfg.solveCaptchas,
			captchaProvider: browserCfg.captchaProvider,
			captchaTimeoutMs: browserCfg.captchaTimeoutMs,
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
					const val = await envVarManager.get(key);
					return { success: true, output: val ?? `Variable ${key} not found` };
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

	const zhipuApiKey = (
		config.ai.providers as Record<string, { apiKey?: string }>
	)?.zhipu?.apiKey;
	const mcpAutoDisabled = (config.mcp?.autoDisabled || []) as string[];
	if (zhipuApiKey) {
		const officialZaiConfigs = getZaiMCPConfigs(zhipuApiKey);
		config.mcp = config.mcp ?? { servers: {}, autoDisabled: [] };
		config.mcp.servers = config.mcp.servers ?? {};
		for (const [serverName, officialConfig] of Object.entries(
			officialZaiConfigs,
		)) {
			if (mcpAutoDisabled.includes(serverName)) continue;
			const previousEnabled = config.mcp.servers[serverName]?.enabled;
			config.mcp.servers[serverName] = {
				...officialConfig,
				enabled: previousEnabled ?? true,
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

	const agentConfig: AgentConfig = {
		id: "default-agent",
		name: "Octopus AI",
		description: "Default Octopus AI agent",
		systemPrompt: `You are Octopus AI, an intelligent assistant with memory, tool execution, and code generation capabilities.

You can:
- Execute code in JavaScript, TypeScript, Python, and Bash using the execute_code tool
- Create new reusable tools using the create_tool tool
- Read, write, and manage files using filesystem tools and manage_workspace
- Browse and search the media library using list_media
- Manage environment variables using the manage_env tool
- Run shell commands using run_command
- Install packages using install_package
- Save images, audio, and video to the media library using save_media
- Remember information across conversations via your memory system
- Schedule recurring automated tasks using schedule_task (cron expressions)
- List all scheduled automations using list_tasks
- Delegate complex sub-tasks to a specialist worker agent using delegate_task
- Read and update tool execution timeouts with manage_tool_timeouts when a tool needs more time than the current limit

IMPORTANT - Tool Usage Guidelines:
1. When calling execute_code, you MUST provide BOTH "code" (the source code) AND "language" (one of: javascript, typescript, python, bash).
2. When calling run_command, you MUST provide "command" (the shell command string).
3. When calling manage_workspace, you MUST provide "action" (list/read/write/delete/mkdir) AND "path".
4. When generating images, audio, or video: first generate the file using execute_code, then save it with save_media, and finally include the returned URL in your response using markdown: ![description](url)
5. When managing API keys or environment variables, ALWAYS use manage_env. NEVER try shell commands like export/set and NEVER write .env files manually.
6. If a tool already returns a saved media URL, use that URL directly and DO NOT call save_media again.
7. To find previously generated media, use the list_media tool. NEVER use manage_workspace to search for media files — media is stored in a separate library, not the workspace.
8. If a tool times out but the task is still valid, use manage_tool_timeouts to increase that specific tool timeout before retrying. Prefer per-tool overrides instead of raising every timeout.

IMPORTANT - Media Handling:
- Media files (images, audio, video) are stored in the Octopus media library, NOT in the workspace filesystem.
- To find a previously generated image, use list_media (optionally with search/type filters).
- Media URLs from your previous messages in the conversation history (like /api/media/file/...) are always valid and can be reused directly.
- When you generate an image, audio, or video file, ALWAYS use the save_media tool to save it to the library.
- The save_media tool requires: "data" (base64-encoded file content), "filename" (with extension), and "mimetype" (e.g. image/png).
- After saving, include the media in your response using markdown image/audio syntax.
- Example flow: execute_code to generate image -> save_media to store it -> respond with ![description](/api/media/file/xxx.png)

IMPORTANT - Autonomy & Delegation:
- When the user asks you to do something periodically (e.g. "every morning", "cada hora", "todos los domingos"), create an automation using schedule_task with the appropriate cron expression.
- When a request is extremely complex and involves multiple independent sub-problems (e.g. "research X AND write code for Y AND create a document for Z"), use delegate_task to assign isolated sub-tasks to specialist worker agents. Each worker runs independently with its own context. This prevents your memory from overflowing and speeds up execution.
- You are the Manager. Workers report back to you. Synthesize their results into a coherent final answer for the user.

IMPORTANT - Browser Automation:
- You have browser tools: browser_navigate, browser_screenshot, browser_click, browser_type, browser_eval, browser_read_page, browser_extract_images, browser_observe, browser_solve_captchas, browser_etsy_task.
- Use these to visit websites, fill forms, scrape content, and interact with web applications on behalf of the user.
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

				IMPORTANT - Z.AI MCP Tools:
				- When a user shares an image, the message will contain a file path like: [Uploaded image: C:\\Users\\...\\media\\uuid.png]
				- You have access to the Z.AI Vision MCP tools: image_analysis, extract_text_from_screenshot, diagnose_error_screenshot, understand_technical_diagram, analyze_data_visualization, ui_to_artifact, ui_diff_check, video_analysis
				- Use these vision tools for image analysis when the active model is Z.ai/Zhipu GLM, or when direct image understanding is unavailable.
				- If the active provider/model is multimodal and is not Z.ai GLM, inspect image content directly and do not call Z.AI Vision MCP tools solely for screenshots.
				- Example: if the user asks "what is in this image?" and the message contains [Uploaded image: /path/to/file.png], call image_analysis with image_path="/path/to/file.png"
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
	};

	const agentRuntime = new AgentRuntime(
		agentConfig,
		router,
		stm,
		memoryRetrieval,
		memoryConsolidator,
		skillLoader,
	);
	agentRuntime.setToolSystem(toolRegistry, toolExecutor);
	agentRuntime.setDailyMemory(dailyMemory);
	agentRuntime.setUserProfileManager(userProfileManager);
	agentRuntime.setMemoryOrchestrator(memoryOrchestrator);
	agentRuntime.setContextAssembler(contextAssembler);
	agentRuntime.setLearningEngine(learningEngine);
	agentRuntime.enableOrchestrator({
		maxWorkers: 5,
		complexityThreshold: 5,
	});
	await agentRuntime.initialize();
	teamBlackboard.registerOrchestrator(agentRuntime);

	const mainAgentRecord: AgentRecord = {
		id: agentConfig.id,
		name: agentConfig.name,
		description: agentConfig.description,
		role: "coordinator",
		personality: null,
		system_prompt: agentConfig.systemPrompt,
		model: agentConfig.model ?? null,
		avatar: null,
		color: null,
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
	}
	agentManager.registerRuntime(agentConfig.id, agentRuntime);

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
	systemScheduler.schedule("daily-memory-dump", "0 0 * * *", async () => {
		try {
			bootstrapLogger.info("Executing End-of-Day Global Memory Flush...");
			const todayStr = new Date().toISOString().split("T")[0];
			const dump = await dailyMemory.dumpAndClear(todayStr);
			if (dump) {
				const fullContent = `Daily Digest:\n${dump}`;
				const embedding = await embedFn(fullContent);
				const memoryItem = {
					id: `daily_${todayStr}`,
					type: "episodic" as const,
					content: fullContent,
					embedding,
					importance: 0.9,
					accessCount: 0,
					lastAccessed: new Date(),
					createdAt: new Date(),
					associations: [],
					source: {
						channelId: "system_cron",
						conversationId: `daily_${todayStr}`,
					},
					metadata: { type: "daily_summary", date: todayStr },
				};
				await ltm.store(memoryItem);
			}
		} catch (err) {
			bootstrapLogger.error(`Error during End-of-Day LTM sync: ${err}`);
		}
	});

	return {
		config,
		db,
		router,
		stm,
		ltm,
		dailyMemory,
		userProfileManager,
		memoryOrchestrator,
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
		toolRegistry,
		chatManager,
		agentManager,
		agentMessageBus,
		taskManager,
		automationManager,
		automationRunner,
		systemScheduler,
		envVarManager,
		mcpManager,
		browserTool,
		refreshBrowserTools,
		reloadDynamicTool,
		toolExecutor,
		embedFn,
		shutdown: async () => {
			systemScheduler.cancel("daily-memory-dump");
			await mcpManager.shutdown();
			connectionManager.shutdown();
			await db.close();
		},
	};
}
