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
	GlobalDailyMemory,
	UserProfileManager,
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
	createAutomationTools,
	createTeamTools,
	createSandboxTools,
	createShellTool,
	createVectorStore,
	expandTildePath,
	AutomationRunner,
	BrowserTool,
	Scheduler,
	createLogger,
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
	dailyMemory: GlobalDailyMemory;
	userProfileManager: UserProfileManager;
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
	automationRunner: AutomationRunner;
	systemScheduler: Scheduler;
	mcpManager: MCPManager;
	embedFn: EmbeddingFunction;
	shutdown: () => Promise<void>;
}

const embedFn: EmbeddingFunction = async (text: string) => {
	const dim = 384;
	const vec = new Array(dim).fill(0);
	
	const cleanText = text.toLowerCase().replace(/[^\w\s]/g, "");
	const words = cleanText.split(/\s+/).filter((w) => w.length > 0);
	
	if (words.length === 0) {
		return vec;
	}

	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		let hash = 0;
		for (let j = 0; j < word.length; j++) {
			hash = (hash << 5) - hash + word.charCodeAt(j);
			hash |= 0; // Convert to 32bit integer
		}
		
		const idx = Math.abs(hash) % dim;
		vec[idx] += 1;
	}
	
	const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
	if (norm > 0) {
		return vec.map((v) => v / norm);
	}
	return vec;
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

	const dailyMemory = new GlobalDailyMemory(db, router, tokenCounter, {
		maxTokens: 1500,
		triggerMessageCount: 10,
	});
	await dailyMemory.initialize();

	const userProfileManager = new UserProfileManager(db, router, {
		minTurnsForUpdate: 5,
		maxDecisions: 50,
		maxWorkflows: 20
	});
	await userProfileManager.initialize();

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

	const automationTools = createAutomationTools(automationManager);
	for (const tool of automationTools) {
		toolRegistry.register(tool);
	}

	const teamTools = createTeamTools(async (task, role) => {
		const workerStm = new ShortTermMemory({
			maxTokens: config.memory?.shortTerm?.maxTokens ?? 16000,
			scratchPadSize: config.memory?.shortTerm?.scratchPadSize ?? 10,
			autoEviction: config.memory?.shortTerm?.autoEviction ?? true,
			tokenCounter: new TokenCounter(),
		});
		
		const workerRuntime = new AgentRuntime(
			{ 
				...agentConfig, 
				id: `worker-${Date.now()}`, 
				name: `Worker (${role})`, 
				systemPrompt: `You are a specialist worker deployed by Octopus Manager. Your role is: ${role}. Solve the task directly and report back concisely. Respond ONLY with the final result, no small talk.` 
			},
			router,
			workerStm,
			memoryRetrieval,
			memoryConsolidator,
			skillLoader
		);
		workerRuntime.setToolSystem(toolRegistry, toolExecutor);
		
		return await workerRuntime.processMessage(task, "system_worker");
	});
	
	for (const tool of teamTools) {
		toolRegistry.register(tool);
	}


	// Browser tools (auto-detect Chrome/Edge/Brave)
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
	if (detectedBrowserPath) {
		const browserTool = new BrowserTool({ executablePath: detectedBrowserPath });
		for (const tool of browserTool.createTools()) {
			toolRegistry.register(tool);
		}
		console.log(`  ✓ Browser tools enabled (${detectedBrowserPath.split(/[/\\]/).pop()})`);
	}

	// Sandbox tools (Docker-based isolated execution)
	const sandboxTools = createSandboxTools();
	for (const tool of sandboxTools) {
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
								context?: any
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
						handler: async (params: Record<string, unknown>, context) => {
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
- Browse and search the media library using list_media
- Manage environment variables using the manage_env tool
- Run shell commands using run_command
- Install packages using install_package
- Save images, audio, and video to the media library using save_media
- Remember information across conversations via your memory system
- Schedule recurring automated tasks using schedule_task (cron expressions)
- List all scheduled automations using list_tasks
- Delegate complex sub-tasks to a specialist worker agent using delegate_task

IMPORTANT - Tool Usage Guidelines:
1. When calling execute_code, you MUST provide BOTH "code" (the source code) AND "language" (one of: javascript, typescript, python, bash).
2. When calling run_command, you MUST provide "command" (the shell command string).
3. When calling manage_workspace, you MUST provide "action" (list/read/write/delete/mkdir) AND "path".
4. When generating images, audio, or video: first generate the file using execute_code, then save it with save_media, and finally include the returned URL in your response using markdown: ![description](url)
5. When managing API keys or environment variables, ALWAYS use manage_env. NEVER try shell commands like export/set and NEVER write .env files manually.
6. If a tool already returns a saved media URL, use that URL directly and DO NOT call save_media again.
7. To find previously generated media, use the list_media tool. NEVER use manage_workspace to search for media files — media is stored in a separate library, not the workspace.

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
- You have browser tools: browser_navigate, browser_screenshot, browser_click, browser_type, browser_eval, browser_read_page.
- Use these to visit websites, fill forms, scrape content, and interact with web applications on behalf of the user.
- Typical flow: browser_navigate to a URL -> browser_read_page to extract text -> process the content.
- You can also take screenshots with browser_screenshot and interact with page elements.

IMPORTANT - Sandbox Execution:
- Use sandbox_execute to run potentially dangerous or untrusted code in an isolated Docker container.
- The container has no network access, limited memory, and is destroyed after execution.
- Use this when the user asks you to run code you generated, test scripts, or execute commands that could affect the system.
- If Docker is not installed, inform the user they need Docker Desktop for sandbox features.

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
	agentRuntime.setDailyMemory(dailyMemory);
	agentRuntime.setUserProfileManager(userProfileManager);
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

	const automationRunner = new AutomationRunner(automationManager, async (actionType, actionConfig) => {
		if (actionType === "agent_prompt") {
			const prompt = String(actionConfig.prompt) || "Tick";
			console.log(`[CronRunner] Spawning background prompt to Agent: ${prompt}`);
			// Start background turn by bypassing human input requirements.
			const systemTurn = {
				role: "user" as const,
				content: `[SYSTEM TRIGGER] ${prompt}`,
				timestamp: new Date()
			};
			agentRuntime.stm.add(systemTurn);
			const context = await memoryRetrieval.retrieveForContext(systemTurn.content);
			
			const stream = agentRuntime.processMessageStream(systemTurn.content, "system_cron");
			for await (const _chunk of stream) {
				// Fire and forget
			}
		}
	});

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
					source: { channelId: "system_cron", conversationId: `daily_${todayStr}` },
					metadata: { type: "daily_summary", date: todayStr }
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
		automationRunner,
		systemScheduler,
		envVarManager,
		mcpManager,
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
