export {
	ConfigSchema,
	DEFAULT_CONFIG,
	getDefaults,
	ConfigLoader,
	ConfigValidator,
} from "./config/index.js";
export type { OctopusConfig, ValidationResult } from "./config/index.js";

export {
	LLMRouter,
	getProviderRegistry,
	TokenCounter,
	BaseLLMProvider,
	OpenAIProvider,
	OpenAICompatibleProvider,
	AnthropicProvider,
	OllamaProvider,
	GoogleProvider,
	ZhipuProvider,
	CohereProvider,
} from "./ai/index.js";
export type {
	LLMProvider,
	LLMRequest,
	LLMMessage,
	LLMResponse,
	LLMChunk,
	LLMTool,
	LLMToolCall,
	ProviderConfig,
	UsageStats,
	LLMRouterConfig,
	ProviderInfo,
} from "./ai/index.js";

export { AgentRuntime, TaskPlanner, AgentCoordinator, ReflectionEngine, HeartbeatDaemon, OctopusDaemon } from "./agent/index.js";
export type {
	AgentConfig,
	TaskState,
	ConversationTurn,
	TaskDescription,
	TaskResult,
	AgentMessage,
	ReflectionConfig,
	ReflectionResult,
	TaskEvaluation,
	HeartbeatConfig,
	HeartbeatItem,
	HeartbeatResult,
	HeartbeatAction,
	DaemonConfig,
	DaemonStatus,
} from "./agent/index.js";

export {
	ProxyDetector,
	RetryHandler,
	CircuitBreaker,
	HealthMonitor,
	OfflineQueue,
	NetworkResolver,
	ConnectionManager,
} from "./connection/index.js";
export type {
	ProxyConfig,
	Endpoint,
	CircuitState,
	HealthStatus,
	ManagedConnection,
	MessageQueue,
	RetryConfig,
	CircuitBreakerConfig,
	HealthMonitorConfig,
	OfflineQueueConfig,
	ConnectionManagerConfig,
} from "./connection/index.js";

export {
	ShortTermMemory,
	LongTermMemory,
	MemoryRetrieval,
	MemoryConsolidator,
	SqliteVectorStore,
	createVectorStore,
	FTSSearchEngine,
	UserProfileManager,
	GlobalDailyMemory,
} from "./memory/index.js";
export type {
	MemoryType,
	MemoryItem,
	RetrieveOptions,
	ConsolidationResult,
	MemoryContext,
	ScoredMemory,
	VectorSearchResult,
	EmbeddingFunction,
	FTSSearchConfig,
	FTSResult,
	UserProfile,
	UserModelingConfig,
	UserDecision,
	WorkflowPattern,
	GlobalDailyMemoryConfig,
} from "./memory/index.js";

export {
	SkillRegistry,
	SkillLoader,
	SkillForge,
	SkillImprover,
	SkillEvaluator,
	SkillMarketplace,
} from "./skills/index.js";
export type {
	Skill,
	SkillUsage,
	SkillMatch,
	LoadedSkill,
	TaskNeeds,
	ABTest,
	SkillForgeConfig,
	SharedSkillMetadata,
	SkillMarketplaceConfig,
} from "./skills/index.js";

export {
	ToolRegistry,
	ToolExecutor,
	createFileSystemTools,
	createShellTool,
	DockerSandbox,
	BrowserTool,
	CodeExecutor,
	createCodeTools,
	createMediaTools,
	mediaContext,
	createAutomationTools,
	createTeamTools,
	createSandboxTools,
} from "./tools/index.js";
export type {
	ToolDefinition,
	ToolResult,
	CodeExecutionResult,
	CodeExecutorConfig,
} from "./tools/index.js";

export {
	TransportServer,
	TransportClient,
	MessageType,
	createMessage,
	parseMessage,
	serializeMessage,
} from "./transport/index.js";
export type { ProtocolMessage } from "./transport/index.js";

export { createDatabaseAdapter, SqliteDatabase } from "./storage/index.js";
export type { DatabaseAdapter } from "./storage/index.js";

export { TTSEngine } from "./voice/tts.js";
export { STTEngine } from "./voice/stt.js";
export { WakeWordEngine } from "./voice/wake.js";

export { PluginEngine } from "./plugins/engine.js";
export { PluginRegistry } from "./plugins/registry.js";
export { MCPClient } from "./plugins/mcp/client.js";
export { PluginMarketplace } from "./plugins/marketplace.js";
export type {
	Plugin,
	PluginManifest,
	SlashCommand,
	MCPServerConfig,
	ConversationContext,
} from "./plugins/types.js";
export type {
	MarketplacePluginInfo,
	MarketplaceSearchResult,
	MarketplaceConfig,
} from "./plugins/marketplace.js";

export { Scheduler } from "./tasks/cron.js";
export { WebhookServer } from "./tasks/webhooks.js";

export { PermissionManager } from "./team/permissions.js";
export { DelegationManager } from "./team/delegation.js";
export type { DelegationConfig, DelegationTask, DelegationPlan } from "./team/delegation.js";

export { MetricsCollector } from "./utils/metrics.js";
export type {
	MetricEvent,
	MetricsDashboard,
	ToolMetricsSummary,
	LLMMetricsSummary,
} from "./utils/metrics.js";

export { SoulParser } from "./config/soul-parser.js";
export type { SoulConfig, HeartbeatChecklist } from "./config/soul-parser.js";

export {
	createLogger,
	expandTildePath,
	deepClone,
	generateId,
	sleep,
	retry,
	truncateToTokenBudget,
	hashPassword,
	verifyPassword,
	encrypt,
	decrypt,
	generateEncryptionKey,
	Benchmark,
	SecurityAuditor,
} from "./utils/index.js";
export type {
	BenchmarkResult,
	SecurityAuditResult,
	SecurityCheck,
} from "./utils/index.js";

export { AgentManager } from "./agent/manager.js";
export { AgentMessageBus } from "./agent/message-bus.js";
export type {
	AgentRecord,
	CreateAgentInput,
	DelegationResult,
} from "./agent/types.js";

export { ChatManager } from "./chat/manager.js";
export type { Conversation, ChatMessage } from "./chat/manager.js";

export { TaskManager } from "./tasks/manager.js";
export type { Task, CreateTaskInput } from "./tasks/manager.js";
export { AutomationManager } from "./tasks/automation-manager.js";
export type {
	Automation,
	CreateAutomationInput,
} from "./tasks/automation-manager.js";
export { AutomationRunner } from "./tasks/cron-runner.js";

export { EnvVarManager } from "./config/env-manager.js";
export type { EnvVar } from "./config/env-manager.js";

export { MCPManager } from "./plugins/mcp/manager.js";
export type { MCPManagedServer } from "./plugins/mcp/manager.js";

export { ChannelManager } from "./channels/manager.js";
export { TelegramChannel } from "./channels/telegram/index.js";
export type { Channel, ChannelMessage } from "./channels/types.js";

export { InputFile } from "grammy";
