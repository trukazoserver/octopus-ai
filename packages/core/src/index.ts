export {
	ConfigSchema,
	DEFAULT_CONFIG,
	getDefaults,
	ConfigLoader,
	ConfigValidator,
} from "./config/index.js";
export type { OctopusConfig, ValidationResult } from "./config/index.js";

export {
	DEFAULT_MASCOT_ID,
	MASCOT_IDS,
	MASCOT_PROFILES,
	getMascotById,
	getMascotOptions,
} from "./mascots/index.js";
export type {
	MascotId,
	MascotProfile,
	MascotSpecialty,
	MascotTone,
} from "./mascots/index.js";

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
	UsageStore,
	getModelCapabilities,
	getModelCapabilitiesFromRef,
	resolveProviderForModel,
	coerceReasoningEffort,
	handleProviderResponseHeaders,
	getCachedQuota,
} from "./ai/index.js";
export type {
	LLMProvider,
	LLMRequest,
	LLMRequestMetadata,
	LLMMessage,
	LLMResponse,
	LLMChunk,
	LLMTool,
	LLMToolCall,
	ProviderConfig,
	UsageStats,
	LLMRouterConfig,
	ProviderInfo,
	UsageSink,
	UsageEvent,
	UsageAggregate,
	UsageQueryFilters,
	ProviderUsageSlice,
	ModelCapabilityInfo,
} from "./ai/index.js";

export {
	AgentRuntime,
	TaskPlanner,
	AgentCoordinator,
	ReflectionEngine,
	HeartbeatDaemon,
	OctopusDaemon,
	EventStream,
	WorkerPool,
	OCTOPUS_ARM_KEYS,
	OCTOPUS_ARM_PROFILES,
	getOctopusArmProfile,
	OctopusOrchestrator,
	ContextManager,
	WorkflowManager,
	WorkflowScheduler,
	RequirementResolver,
	deriveInitialTaskStatus,
	KanbanPlanner,
	KanbanDispatcher,
	createProgressSignature,
	decideRetryAfterFailure,
	ArtifactVerifier,
	SubtaskTracker,
	ReconciliationService,
	ContinuityGuard,
} from "./agent/index.js";
export type {
	AgentConfig,
	AgentReasoningEffort,
	ToolIterationLimitConfig,
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
	AgentEvent,
	AgentEventType,
	EventFilter,
	SubTask,
	WorkerConfig,
	OctopusArmKey,
	OctopusArmProfile,
	TaskDecomposition,
	OrchestratorConfig,
	OrchestratorEvent,
	ContextManagerConfig,
	WorkflowArtifactRecord,
	WorkflowBlockerRecord,
	WorkflowTaskCommentRecord,
	WorkflowTaskContext,
	WorkflowDependencyEdge,
	KanbanRunMetrics,
	WorkflowRequirementStatus,
	WorkflowRequirementType,
	WorkflowRunRecord,
	WorkflowStatus,
	WorkflowTaskLeaseRecord,
	WorkflowTaskRequirementRecord,
	WorkflowTaskRecord,
	WorkflowRunResumer,
	WorkflowSchedulerOptions,
	RequirementResolverResult,
	KanbanArtifactSpec,
	KanbanPlanSpec,
	KanbanPlanTaskSpec,
	KanbanPlannerOptions,
	KanbanRequirementSpec,
	PersistedKanbanPlan,
	KanbanDispatcherOptions,
	KanbanDispatcherStatus,
	KanbanDispatcherTickResult,
	KanbanTaskExecutionContext,
	KanbanTaskExecutor,
	RetryDecision,
	RetryProgressState,
	ArtifactVerificationResult,
	ExpectedArtifact,
	ProducedArtifact,
	PersistedLedgerSnapshot,
	ReconciliationReport,
	ContinuityGuardConfig,
	ContinuityState,
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
	ContextAssembler,
	MemoryIntegrityLayer,
	MemoryOrchestrator,
	MemoryRetentionScheduler,
	ProactiveMemoryScanner,
	UncertaintyEstimator,
	SqliteVectorStore,
	ExternalVectorStore,
	PgVectorStore,
	createVectorStore,
	resolveVectorGeneration,
	embeddingDescriptorFromMetadata,
	FTSSearchEngine,
	UserProfileManager,
	GlobalDailyMemory,
	EmbeddingProvider,
	WorkingMemory,
	KnowledgeManager,
	createConfiguredKnowledgeExtractor,
	createGoogleKnowledgeExtractor,
	createOpenAIKnowledgeExtractor,
	evaluateMemoryConditions,
	MemoryBenchmarkStore,
	normalizeMemoryBenchmarkSource,
	scoreMemoryBenchmarkCase,
} from "./memory/index.js";
export type {
	MemoryType,
	MemoryItem,
	RetrieveOptions,
	ConsolidationResult,
	MemoryContext,
	ScoredMemory,
	VectorSearchResult,
	ExternalVectorBackend,
	ExternalVectorStoreConfig,
	PgVectorStoreConfig,
	VectorStoreFactoryOptions,
	EmbeddingDescriptor,
	EmbeddingFunction,
	MemoryEvaluationCase,
	MemoryEvaluationCondition,
	MemoryEvaluationResult,
	FTSSearchConfig,
	FTSResult,
	UserProfile,
	UserModelingConfig,
	UserDecision,
	WorkflowPattern,
	GlobalDailyMemoryConfig,
	WorkingState,
	CondensationCallback,
	MemorySourceTrustLevel,
	MemoryRelationType,
	MemorySensitivity,
	MemoryPermissions,
	MemorySource,
	MemoryVerification,
	MemoryVerificationReport,
	MemoryVerificationStatus,
	MemoryGraphNode,
	MemoryGraphRelation,
	MemoryGraphPath,
	MemoryGraphTraversalOptions,
	MemoryGraphSnapshot,
	MemoryAuditEntry,
	MemoryActionLogEntry,
	MemoryBackfillReport,
	EmbeddingReindexReport,
	LegacyClaimBackfillReport,
	MemoryMetricsSnapshot,
	MemoryOperationType,
	MemoryOperationStatus,
	MemoryOperationControlAction,
	VectorGeneration,
	LegacyVectorPayloadMigrationInput,
	LegacyVectorPayloadMigrationReport,
	MemoryBenchmarkFormat,
	MemoryBenchmarkDocument,
	MemoryBenchmarkCase,
	NormalizedMemoryBenchmark,
	MemoryBenchmarkCaseMetrics,
	MemoryBenchmarkCondition,
	MemoryBenchmarkHit,
	MemoryBenchmarkIsolatedRuntime,
	MemoryBenchmarkRuntimeFactory,
	MemoryOperationLeaseState,
	MemoryOperationCreateInput,
	MemoryOperationRecord,
	MemoryOperationListOptions,
	VectorSearchConstraints,
	VectorSearchOptions,
	VersionedEmbedding,
	MemoryAuditIntegrityReport,
	MemoryLogIntegrityResult,
	MemoryRetentionRunner,
	MemoryRetentionScheduleConfig,
	MemoryRetentionSchedulerLike,
	MemoryRetentionSchedulerLogger,
	RetrievalSignals,
	MemoryStatus,
	MemoryUncertaintyLevel,
	MemoryScope,
	MemoryCandidate,
	MemoryValidationResult,
	MemoryPack,
	MemoryReadContext,
	MemoryReadOptions,
	MemoryWriteResult,
	MemoryFeedbackType,
	MemoryFeedbackInput,
	MemoryFeedbackResult,
	ActiveForgettingOptions,
	ActiveForgettingReport,
	MemoryUsageRecord,
	MemoryCoverageSnapshot,
	MemoryUncertaintyEstimate,
	MemoryExplanation,
	ProspectiveReminder,
	ProactiveMemoryScanResult,
	ProactiveMemoryScannerConfig,
	ContextAssemblyInput,
	ContextAssemblyResult,
	ContextAssemblerConfig,
	UncertaintyEstimatorConfig,
	KnowledgeChunkModality,
	KnowledgeChunkRecord,
	KnowledgeCollectionRecord,
	ExtractedKnowledgeChunk,
	KnowledgeFileExtractionInput,
	KnowledgeFileExtractor,
	GoogleKnowledgeExtractorOptions,
	OpenAIKnowledgeExtractorOptions,
	KnowledgeItemRecord,
	KnowledgeItemSourceType,
	KnowledgeItemStatus,
} from "./memory/index.js";

export {
	SkillRegistry,
	SkillLoader,
	SkillForge,
	SkillImprover,
	SkillEvaluator,
	SkillMarketplace,
	SkillResearcher,
	Context7HttpClient,
	OFFICE_FILE_MASTERY_SKILL_IDS,
	buildOfficeFileMasterySkills,
	buildWebSelfReviewSkill,
	officeFileMasteryEmbeddingTexts,
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
	Context7Config,
	SkillResearchConfig,
	SkillResearchInput,
	SkillResearchResult,
} from "./skills/index.js";

export { LearningEngine } from "./learning/index.js";
export type {
	ExperienceRecord,
	ExperienceRecordInput,
	ExperienceOutcomeVerification,
	ExperienceSkillTrace,
	ExperienceStatus,
	ExperienceToolTrace,
	LearningEngineConfig,
	LearningFeedbackInput,
	LearningAccess,
	LearningInsight,
	LearningInsightType,
	LearningScope,
} from "./learning/index.js";

export {
	ToolRegistry,
	ToolExecutor,
	createFileSystemTools,
	createShellTool,
	DockerSandbox,
	BrowserTool,
	BrowserSessionPool,
	CodeExecutor,
	createCodeTools,
	createCodexImageTools,
	createNanoBananaImageTools,
	createMediaTools,
	ArtifactIndex,
	hashArtifactUnits,
	createDataFileTools,
	createHtmlToPptxTools,
	createOfficeAdvancedTools,
	createOfficeEditTools,
	createOfficeMediaTools,
	createOfficePreviewTools,
	convertOfficeFile,
	convertOfficeFileToPdf,
	findLibreOfficeExecutable,
	renderPdfPreviewPages,
	createOfficeTools,
	createPdfAdvancedTools,
	getOfflineOcrLanguageStatus,
	getOfflineTessdataPath,
	mediaContext,
	createWorkflowTools,
	createAutomationTools,
	createTeamTools,
	createOrchestrationTools,
	createSandboxTools,
	createTeamCommTools,
	createAgentCommsTools,
	createAgentSpawnTools,
	createKanbanCardTools,
	ProxyManager,
	HumanBehavior,
	ToolHealthManager,
	PdfReader,
} from "./tools/index.js";
export type {
	ArtifactIndexOptions,
	ArtifactIndexSnapshot,
	ArtifactIndexStatus,
	ArtifactSearchMatch,
	ArtifactSearchOptions,
	ArtifactUnit,
	OcrLanguageStatus,
} from "./tools/index.js";

export {
	asBackgroundDeliveryContext,
	createDeliveryContext,
} from "./delivery/context.js";
export type {
	DeliveryCapabilities,
	DeliveryChannel,
	DeliveryContext,
	TrustProfile,
} from "./delivery/context.js";
export type {
	ToolDefinition,
	ToolErrorCode,
	ToolResult,
	ToolHealthStatus,
	ToolHealthRecord,
	ToolHealthConfig,
	ToolCircuitState,
	CodeExecutionResult,
	CodeExecutorConfig,
	CodeExecutorHooks,
	HumanTypingOptions,
	HumanMouseOptions,
	HumanScrollOptions,
} from "./tools/index.js";
export type { ProxyConfig as BrowserProxyConfig } from "./tools/index.js";

export {
	CommandApprovalService,
	ContentSafetyScanner,
	EnvironmentFilter,
	isCommandHardBlocked,
	SecretRedactor,
	secretRedactor,
	PathSafetyPolicy,
	UrlSafetyPolicy,
} from "./security/index.js";
export type {
	CommandApprovalConfig,
	CommandApprovalMode,
	CommandDecision,
	ContentSafetyFinding,
	ContentSafetyMode,
	ContentSafetyScannerConfig,
	ContentSafetyScanResult,
	ContentSafetySeverity,
	EnvironmentFilterConfig,
	PathSafetyPolicyConfig,
	SecretRedactorOptions,
	UrlSafetyDecision,
	UrlSafetyPolicyConfig,
} from "./security/index.js";

export { prepareVertexProject } from "./auth/google-cloud.js";
export type {
	VertexProjectSetupOptions,
	VertexProjectSetupResult,
	GoogleBillingAccount,
} from "./auth/google-cloud.js";
export { refreshAccessToken } from "./auth/oauth.js";
export type { OAuthTokenResponse } from "./auth/oauth.js";
export { refreshCodexToken, CODEX_CLIENT_ID } from "./auth/codex-oauth.js";
export type { CodexRefreshedToken } from "./auth/codex-oauth.js";

export {
	TransportServer,
	TransportClient,
	MessageType,
	createMessage,
	parseMessage,
	serializeMessage,
} from "./transport/index.js";
export type { ProtocolMessage } from "./transport/index.js";

export {
	createDatabaseAdapter,
	PostgresDatabase,
	SqliteDatabase,
} from "./storage/index.js";
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
export { TeamBlackboard } from "./team/blackboard.js";
export type { BlackboardEvent } from "./team/blackboard.js";

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
	TenacidadConfig,
	TenacidadLevel,
} from "./agent/types.js";

export { ChatManager } from "./chat/manager.js";
export { ChatExecutionManager } from "./chat/execution-manager.js";
export type {
	ChatExecutionEvent,
	ChatExecutionStartInput,
} from "./chat/execution-manager.js";
export type {
	ChatExecution,
	ChatExecutionActivity,
	ChatCompletionReason,
	ChatPendingAction,
	ChatExecutionStatus,
	ChatToolAction,
	ChatToolActionStatus,
	Conversation,
	ChatMessage,
} from "./chat/manager.js";

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
export {
	getZaiMCPConfigs,
	resolveZaiMCPAuth,
} from "./plugins/mcp/zai-servers.js";

export { ChannelManager } from "./channels/manager.js";
export { TelegramChannel } from "./channels/telegram/index.js";
export { WhatsAppChannel } from "./channels/whatsapp/index.js";
export { DiscordChannel } from "./channels/discord/index.js";
export { SlackChannel } from "./channels/slack/index.js";
export type { Channel, ChannelMessage } from "./channels/types.js";

export { InputFile } from "grammy";
