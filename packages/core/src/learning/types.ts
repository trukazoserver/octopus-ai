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

export interface ExperienceOutcomeVerification {
	verified: boolean;
	checks: Array<{
		name: string;
		passed: boolean;
		evidence?: string;
	}>;
}

export interface LearningScope {
	tenantId: string;
	userId: string;
	projectId: string;
	agentRole: string;
	sessionId?: string;
	taskId?: string;
}

export type LearningAccess =
	| { kind: "admin" }
	| { kind: "scoped"; scope: LearningScope };

export interface ExperienceRecordInput {
	scope: LearningScope;
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
	outcome?: ExperienceOutcomeVerification;
}

export interface ExperienceRecord
	extends Required<
		Pick<ExperienceRecordInput, "userRequest" | "finalResponse">
	> {
	id: string;
	scope: LearningScope;
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
	scope: LearningScope;
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
	invalidatedAt?: Date;
	invalidationReason?: string;
	invalidatedByExperienceId?: string;
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
