export interface ToolIterationLimitConfig {
	enabled?: boolean;
	maxIterations?: number;
}

export interface ContinuityGuardRuntimeConfig {
	enabled?: boolean;
	maxAutoContinuations?: number;
	truncationDetection?: boolean;
	/** Detect "promised-but-not-acted" responses and repeated text without tool calls. */
	stallDetection?: boolean;
	/** Max number of forced re-prompts before giving up (warning + stop). */
	maxStallForcings?: number;
	/** How many recent response signatures to remember for repetition detection. */
	stallSignatureHistory?: number;
}

export type TenacidadLevel = "normal" | "tenaz";

export interface TenacidadConfig {
	/** Enable relentless mode where the agent continues until task completion */
	level?: TenacidadLevel;
	/** Maximum consecutive genuine API/auth errors before stopping (default: 3) */
	maxGenuineApiErrors?: number;
	/** Retry attempts for stream errors before giving up (default: 3) */
	streamErrorRetries?: number;
	/** Retry attempts for empty model responses (default: 3) */
	emptyResponseRetries?: number;
}

export interface AgentConfig {
	id: string;
	name: string;
	description: string;
	systemPrompt: string;
	model?: string;
	tools?: string[];
	channels?: string[];
	maxTokens?: number;
	temperature?: number;
	toolIterationLimit?: ToolIterationLimitConfig;
	continuityGuard?: ContinuityGuardRuntimeConfig;
	tenacidad?: TenacidadConfig;
}

export interface TaskState {
	id: string;
	description: string;
	status: "pending" | "running" | "completed" | "failed";
	result?: string;
	error?: string;
	startedAt?: Date;
	completedAt?: Date;
}

export interface ConversationTurn {
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: Date;
	metadata?: Record<string, unknown>;
}

export interface TaskDescription {
	description: string;
	complexity: number;
	domains: string[];
	keywords: string[];
}

export interface TaskResult {
	summary: string;
	whatWorked: string;
	whatCouldImprove: string;
	patterns: string[];
}

export interface AgentMessage {
	from: string;
	to: string;
	type: "task" | "result" | "query" | "broadcast" | "progress" | "delegation";
	content: string;
	timestamp: Date;
}

export interface AgentRecord {
	id: string;
	name: string;
	description: string | null;
	role: string;
	personality: string | null;
	system_prompt: string;
	model: string | null;
	avatar: string | null;
	color: string | null;
	is_default: number;
	is_main: number;
	parent_id: string | null;
	created_at: string;
	updated_at: string;
	config: string | null;
	is_builtin_arm?: number;
	arm_key?: string | null;
	base_profile?: string | null;
	user_overrides?: string | null;
	capabilities?: string | null;
	tool_permissions?: string | null;
	knowledge_base_ids?: string | null;
	fallback_model?: string | null;
	can_spawn_subagents?: number;
	max_spawn_depth?: number;
}

export type AgentStoredMessageType =
	| "message"
	| "broadcast"
	| "progress"
	| "question"
	| "result"
	| "spawn_request";

export interface AgentStoredMessage {
	id: string;
	run_id: string | null;
	from_agent_id: string;
	to_agent_id: string | null;
	task_id: string | null;
	message_type: AgentStoredMessageType;
	content: string;
	created_at: string;
	read_at: string | null;
	metadata: string | null;
}

export interface CreateAgentMessageInput {
	runId?: string;
	fromAgentId: string;
	toAgentId?: string | null;
	taskId?: string;
	messageType?: AgentStoredMessageType;
	content: string;
	metadata?: Record<string, unknown>;
}

export interface ListAgentMessagesInput {
	agentId: string;
	runId?: string;
	includeBroadcasts?: boolean;
	unreadOnly?: boolean;
	limit?: number;
}

export interface SpawnSubagentInput extends CreateAgentInput {
	parentAgentId: string;
}

export interface CreateAgentInput {
	name: string;
	role?: string;
	personality?: string;
	description?: string;
	systemPrompt?: string;
	model?: string;
	avatar?: string;
	color?: string;
	isMain?: boolean;
	parentId?: string;
	config?: Record<string, unknown>;
	fallbackModel?: string;
	capabilities?: string[];
	toolPermissions?: Record<string, unknown>;
	knowledgeBaseIds?: string[];
	canSpawnSubagents?: boolean;
	maxSpawnDepth?: number;
}

export interface DelegationResult {
	taskId: string;
	agentId: string;
	agentName: string;
	status: "pending" | "running" | "completed" | "failed";
	result?: string;
	progress?: string[];
}
