export type ExperienceStatus = "succeeded" | "failed" | "partial" | "unknown";

export type LearningInsightType =
	| "what_worked"
	| "what_failed"
	| "procedure"
	| "anti_pattern"
	| "tool_strategy"
	| "skill_candidate";

export interface ExperienceToolTrace {
	name: string;
	success: boolean;
	useful?: boolean;
	summary?: string;
	error?: string;
}

export interface ExperienceSkillTrace {
	id: string;
	name: string;
	level?: number;
}

export interface ExperienceRecordInput {
	conversationId?: string;
	taskId?: string;
	agentId?: string;
	channelId?: string;
	userRequest: string;
	finalResponse: string;
	status?: ExperienceStatus;
	confidence?: number;
	toolsUsed?: ExperienceToolTrace[];
	skillsUsed?: ExperienceSkillTrace[];
	durationMs?: number;
	metadata?: Record<string, unknown>;
}

export interface ExperienceRecord
	extends Required<
		Pick<ExperienceRecordInput, "userRequest" | "finalResponse">
	> {
	id: string;
	conversationId?: string;
	taskId?: string;
	agentId?: string;
	channelId?: string;
	status: ExperienceStatus;
	confidence: number;
	toolsUsed: ExperienceToolTrace[];
	skillsUsed: ExperienceSkillTrace[];
	durationMs?: number;
	metadata: Record<string, unknown>;
	createdAt: Date;
}

export interface LearningInsight {
	id: string;
	experienceId: string;
	type: LearningInsightType;
	domain?: string;
	keywords: string[];
	content: string;
	evidence?: string;
	confidence: number;
	importance: number;
	embedding: number[];
	useCount: number;
	lastUsedAt?: Date;
	createdAt: Date;
}

export interface LearningEngineConfig {
	enabled: boolean;
	autoReflect: boolean;
	minConfidenceToStore: number;
	minConfidenceToInject: number;
	maxInsightsPerContext: number;
	maxContextTokens: number;
	autoCreateSkills: boolean;
	minSimilarSuccessesForSkill: number;
	retainFailedInsights: boolean;
}

export interface LearningFeedbackInput {
	experienceId?: string;
	conversationId?: string;
	messageId?: string;
	rating: "positive" | "negative" | number;
	comment?: string;
}
