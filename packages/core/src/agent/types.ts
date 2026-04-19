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
}

export interface DelegationResult {
	taskId: string;
	agentId: string;
	agentName: string;
	status: "pending" | "running" | "completed" | "failed";
	result?: string;
	progress?: string[];
}
