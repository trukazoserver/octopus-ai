import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	AgentManager,
	AgentMessageBus,
	AgentRuntime,
	AutomationManager,
	ChatManager,
	CodeExecutor,
	ConfigLoader,
	ConnectionManager,
	EnvVarManager,
	LLMRouter,
	LongTermMemory,
	MCPManager,
	MemoryConsolidator,
	MemoryRetrieval,
	PluginMarketplace,
	PluginRegistry,
	ShortTermMemory,
	SkillForge,
	SkillLoader,
	SkillMarketplace,
	SkillRegistry,
	TaskManager,
	TokenCounter,
	ToolExecutor,
	ToolRegistry,
	createDatabaseAdapter,
	createFileSystemTools,
	createMediaTools,
	createShellTool,
	createVectorStore,
	expandTildePath,
} from "@octopus-ai/core";
import type {
	AgentConfig,
	AgentRecord,
	DatabaseAdapter,
	EmbeddingFunction,
	OctopusConfig,
	ProviderConfig,
} from "@octopus-ai/core";

export interface OctopusSystem {
	config: OctopusConfig;
	db: DatabaseAdapter;
	router: LLMRouter;
	stm: ShortTermMemory;
	ltm: LongTermMemory;
	memoryRetrieval: MemoryRetrieval;
	memoryConsolidator: MemoryConsolidator;
	skillRegistry: SkillRegistry;
	skillLoader: SkillLoader;
	skillForge: SkillForge;
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
	mcpManager: MCPManager;
	embedFn: EmbeddingFunction;
	shutdown: () => Promise<void>;
}

const embedFn: EmbeddingFunction = async (_text: string) => {
	const dim = 384;
	const vec = Array.from({ length: dim }, () => Math.random() * 2 - 1);
	const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
	return vec.map((v) => v / norm);
};

export async function bootstrap(options?: {
	configPath?: string;
}): Promise<OctopusSystem> {
	const loader = new ConfigLoader(options?.configPath);
	const config = loader.load();

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

	const providers: Record<string, ProviderConfig> = {};
	const providerEntries = Object.entries(config.ai.providers) as Array<
		[string, { apiKey?: string; baseUrl?: string; models?: string[] }]
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
			};
		}
	}

	const router = new LLMRouter({
		default: config.ai.default,
		fallback: config.ai.fallback,
		providers,
	});
	await router.initialize();

	const skillRegistry = new SkillRegistry(db, embedFn);
	const skillLoader = new SkillLoader(skillRegistry, embedFn, {
		maxTokenBudget: config.skills.loading.maxTokenBudget,
		progressiveLevels: config.skills.loading.progressiveLevels,
		autoUnload: config.skills.loading.autoUnload,
		searchThreshold: config.skills.loading.searchThreshold,
	});

	const skillForge = new SkillForge(skillRegistry, embedFn, {
		complexityThreshold: config.skills.forge.complexityThreshold,
		selfCritique: config.skills.forge.selfCritique,
		minQualityScore: config.skills.forge.minQualityScore,
		includeExamples: config.skills.forge.includeExamples,
		includeTemplates: config.skills.forge.includeTemplates,
		includeAntiPatterns: config.skills.forge.includeAntiPatterns,
	});

	const toolRegistry = new ToolRegistry();

	const codeExecutor = new CodeExecutor();
	await codeExecutor.initialize();

	const chatManager = new ChatManager(db);
	const agentManager = new AgentManager(db);
	const agentMessageBus = new AgentMessageBus();
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

	mcpManager.setPersistCallback((servers) => {
		try {
			const loader = new ConfigLoader();
			const cfg = loader.load();
			(cfg as Record<string, unknown>).mcp = { servers };
			loader.save(cfg);
		} catch {
			/* ignore persist errors */
		}
	});

	if (config.mcp?.servers && Object.keys(config.mcp.servers).length > 0) {
		await mcpManager.loadPersisted(config.mcp.servers);
	}

	const filesystemTools = createFileSystemTools([]);
	for (const tool of filesystemTools) {
		toolRegistry.register(tool);
	}

	const shellTool = createShellTool({
		sandboxCommands: false,
	});
	toolRegistry.register(shellTool);

	const codeTools = codeExecutor.createTools();
	for (const tool of codeTools) {
		toolRegistry.register(tool);
	}

	const mediaTools = createMediaTools();
	for (const tool of mediaTools) {
		toolRegistry.register(tool);
	}

	toolRegistry.register({
		name: "manage_env",
		description: "Create, update, read, or delete environment variables in the database. Use this instead of .env files.",
		parameters: {
			action: { type: "string", description: "Action: 'set', 'get', 'list', 'delete'", required: true },
			key: { type: "string", description: "The environment variable key (e.g. API_KEY)" },
			value: { type: "string", description: "The value to set (required for 'set' action)" },
			isSecret: { type: "boolean", description: "Whether the value should be encrypted (true) or plain text (false). Default true." }
		},
		handler: async (params) => {
			const action = String(params.action);
			const key = params.key ? String(params.key) : undefined;
			const value = params.value ? String(params.value) : undefined;
			
			try {
				if (action === "list") {
					const vars = await envVarManager.list(false);
					return { success: true, output: JSON.stringify(vars, null, 2) };
				}
				if (!key) return { success: false, output: "", error: "Missing 'key' parameter" };
				
				if (action === "get") {
					const val = await envVarManager.get(key);
					return { success: true, output: val ?? `Variable ${key} not found` };
				}
				if (action === "set") {
					if (!value) return { success: false, output: "", error: "Missing 'value' parameter for set action" };
					const isSecret = params.isSecret !== false; // default true
					await envVarManager.set(key, value, { isSecret });
					process.env[key] = value;
					return { success: true, output: `Environment variable ${key} set successfully` };
				}
				if (action === "delete") {
					const deleted = await envVarManager.delete(key);
					if (deleted) {
						delete process.env[key];
					}
					return { success: true, output: deleted ? `Variable ${key} deleted` : `Variable ${key} not found` };
				}
				return { success: false, output: "", error: "Unknown action" };
			} catch (err) {
				return { success: false, output: "", error: String(err) };
			}
		}
	});

	// Load dynamic tools from ~/.octopus/tools/
	const dynamicToolsDir = join(homedir(), ".octopus", "tools");
	if (existsSync(dynamicToolsDir)) {
		const { pathToFileURL } = await import("node:url");
		try {
			const toolDirs = readdirSync(dynamicToolsDir, { withFileTypes: true });
			for (const entry of toolDirs) {
				if (!entry.isDirectory()) continue;
				const manifestPath = join(dynamicToolsDir, entry.name, "manifest.json");
				const codePath = join(dynamicToolsDir, entry.name, "index.mjs");
				if (!existsSync(manifestPath) || !existsSync(codePath)) continue;
				try {
					const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
					const toolName: string = manifest.name || entry.name;
					const toolDesc: string =
						manifest.description || `Dynamic tool: ${toolName}`;
					const toolParams: Record<
						string,
						{ type: string; description: string; required?: boolean }
					> = {};
					if (manifest.parameters && typeof manifest.parameters === "object") {
						for (const [key, val] of Object.entries(
							manifest.parameters as Record<string, unknown>,
						)) {
							const p = val as {
								type?: string;
								description?: string;
								required?: boolean;
							};
							toolParams[key] = {
								type: p.type || "string",
								description: p.description || "",
								required: p.required ?? false,
							};
						}
					}
					let handlerFn:
						| ((
								params: Record<string, unknown>,
						  ) => Promise<{
								success: boolean;
								output?: string;
								error?: string;
								metadata?: Record<string, unknown>;
						  }>)
						| null = null;
					toolRegistry.register({
						name: toolName,
						description: toolDesc,
						parameters: toolParams,
						handler: async (params: Record<string, unknown>) => {
							if (!handlerFn) {
								try {
									const mod = await import(pathToFileURL(codePath).href);
									handlerFn = mod.default || mod;
								} catch (err) {
									return {
										success: false,
										output: "",
										error: `Failed to load tool "${toolName}": ${err instanceof Error ? err.message : String(err)}`,
									};
								}
							}
							try {
								const result = await handlerFn?.(params);
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
					});
					console.log(`  Loaded dynamic tool: ${toolName}`);
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

	const toolExecutor = new ToolExecutor(toolRegistry, {
		sandboxCommands: false,
		allowedPaths: [],
	});

	const agentConfig: AgentConfig = {
		id: "default-agent",
		name: "Octopus AI",
		description: "Default Octopus AI agent",
		systemPrompt: `You are Octopus AI, an intelligent assistant with memory, tool execution, and code generation capabilities.

You can:
- Execute code in JavaScript, TypeScript, Python, and Bash using the execute_code tool
- Create new reusable tools using the create_tool tool
- Read, write, and manage files using filesystem tools and manage_workspace
- Read, write, and manage files using filesystem tools and manage_workspace
- Manage environment variables using the manage_env tool
- Run shell commands using run_command
- Install packages using install_package
- Save images, audio, and video to the media library using save_media
- Remember information across conversations via your memory system

IMPORTANT - Tool Usage Guidelines:
1. When calling execute_code, you MUST provide BOTH "code" (the source code) AND "language" (one of: javascript, typescript, python, bash).
2. When calling run_command, you MUST provide "command" (the shell command string).
3. When calling manage_workspace, you MUST provide "action" (list/read/write/delete/mkdir) AND "path".
4. When generating images, audio, or video: first generate the file using execute_code, then save it with save_media, and finally include the returned URL in your response using markdown: ![description](url)
5. When managing API keys or environment variables, ALWAYS use manage_env. NEVER try shell commands like export/set and NEVER write .env files manually.
6. If a tool already returns a saved media URL, use that URL directly and DO NOT call save_media again.

IMPORTANT - Media Generation:
- When you generate an image, audio, or video file, ALWAYS use the save_media tool to save it to the library.
- When using execute_code for media generation, write the media to a file first and use the generated artifact. NEVER print large base64 blobs to stdout.
- The save_media tool requires: "data" (base64-encoded file content), "filename" (with extension), and "mimetype" (e.g. image/png).
- After saving, include the media in your response using markdown image/audio syntax.
- Example flow: execute_code to generate image -> save_media to store it -> respond with ![description](/api/media/file/xxx.png)

Be proactive: if a task could benefit from code execution, use your tools.
Always be concise, helpful, and thorough.`,
		model: config.ai.default,
		maxTokens: config.ai.maxTokens,
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
	await agentRuntime.initialize();

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

	return {
		config,
		db,
		router,
		stm,
		ltm,
		memoryRetrieval,
		memoryConsolidator,
		skillRegistry,
		skillLoader,
		skillForge,
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
		envVarManager,
		mcpManager,
		toolExecutor,
		embedFn,
		shutdown: async () => {
			await mcpManager.shutdown();
			connectionManager.shutdown();
			await db.close();
		},
	};
}
