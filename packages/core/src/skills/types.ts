export interface Skill {
	id: string;
	name: string;
	version: string;
	description: string;
	tags: string[];
	embedding: number[];
	instructions: string;
	examples: string[];
	templates: string[];
	triggerConditions: {
		keywords: string[];
		taskPatterns: string[];
		domains: string[];
	};
	contextEstimate: {
		instructions: number;
		perExample: number;
		templates: number;
	};
	metrics: {
		timesUsed: number;
		successRate: number;
		avgUserRating: number;
		lastUsed: string;
		improvementsCount: number;
		createdAt: string;
	};
	quality: {
		completeness: number;
		accuracy: number;
		clarity: number;
	};
	dependencies: string[];
	related: string[];
}

export interface SkillUsage {
	id: string;
	skillId: string;
	task: string;
	success: boolean;
	failureReason?: string;
	userFeedback?: string;
	successReason?: string;
	timestamp: Date;
}

export interface SkillMatch {
	skill: Skill;
	similarity: number;
	rankScore: number;
}

export interface LoadedSkill {
	skill: Skill;
	content: string;
	level: 1 | 2 | 3 | 4;
}

export interface TaskNeeds {
	domains: string[];
	complexity: number;
	needsSkill: boolean;
	keywords: string[];
	description: string;
	embedding: number[];
}

export interface ABTest {
	id: string;
	skillId: string;
	versionA: string;
	versionB: string;
	startDate: Date;
	sampleSize: number;
	results: {
		a: { successes: number; total: number };
		b: { successes: number; total: number };
	};
	status: "running" | "completed" | "cancelled";
}

export interface SkillForgeConfig {
	complexityThreshold: number;
	selfCritique: boolean;
	minQualityScore: number;
	includeExamples: boolean;
	includeTemplates: boolean;
	includeAntiPatterns: boolean;
}
