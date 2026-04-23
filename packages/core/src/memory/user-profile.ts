import type { LLMRouter } from "../ai/router.js";
import type { ConversationTurn } from "../agent/types.js";
import type { DatabaseAdapter } from "../storage/database.js";
import { createLogger } from "../utils/logger.js";

/**
 * UserModeling — Deep User Profile System
 *
 * Inspired by Hermes AI's "Honcho" dialectic user modeling.
 * Builds an evolving semantic profile of the user, including:
 * - Preferences (communication style, tools, languages)
 * - Expertise areas (with confidence levels)
 * - Decision history (what they chose and why)
 * - Workflow patterns (common sequences of actions)
 *
 * Unlike the MemoryConsolidator's regex-based fact extraction,
 * this uses the LLM to semantically model the user's identity.
 */

const logger = createLogger("user-profile");

export interface UserProfile {
	/** User identifier (usually the channel/conversation owner) */
	userId: string;
	/** Display name if known */
	displayName: string | null;
	/** Communication style: concise, detailed, casual, formal */
	communicationStyle: string;
	/** Preferred response language */
	preferredLanguage: string;
	/** Expertise areas with confidence (0-1) */
	expertiseAreas: Record<string, number>;
	/** Explicit preferences (key → value) */
	preferences: Record<string, string>;
	/** Decision history: recent significant choices */
	decisions: UserDecision[];
	/** Workflow patterns: common task sequences */
	workflowPatterns: WorkflowPattern[];
	/** Raw personality traits detected */
	traits: string[];
	/** Timestamps */
	createdAt: string;
	updatedAt: string;
	/** How many conversations have contributed to this profile */
	conversationCount: number;
}

export interface UserDecision {
	description: string;
	choice: string;
	reasoning: string;
	timestamp: string;
}

export interface WorkflowPattern {
	name: string;
	steps: string[];
	frequency: number;
	lastUsed: string;
}

export interface UserModelingConfig {
	/** Minimum turns before updating profile */
	minTurnsForUpdate: number;
	/** Maximum decisions to keep in history */
	maxDecisions: number;
	/** Maximum workflow patterns to track */
	maxWorkflows: number;
	/** Model to use for profile extraction */
	model?: string;
	/** Whether to use LLM for extraction (otherwise regex-only) */
	useLLMExtraction: boolean;
}

export const DEFAULT_USER_MODELING_CONFIG: UserModelingConfig = {
	minTurnsForUpdate: 3,
	maxDecisions: 50,
	maxWorkflows: 20,
	useLLMExtraction: true,
};

const PROFILE_EXTRACTION_PROMPT = `You are analyzing a conversation to update a user profile. Extract information about the user.

Respond in valid JSON:
{
  "communicationStyle": "<concise|detailed|casual|formal>",
  "language": "<detected primary language, e.g., es, en, pt>",
  "expertiseAreas": { "<area>": <confidence 0-1>, ... },
  "preferences": { "<key>": "<value>", ... },
  "decisions": [{ "description": "<what>", "choice": "<chosen>", "reasoning": "<why>" }],
  "workflowSteps": ["<step1>", "<step2>", ...],
  "traits": ["<trait1>", "<trait2>", ...]
}

Rules:
- Only include information you're confident about
- Don't invent or assume — extract from evidence
- expertiseAreas confidence: 0.3=mentioned, 0.6=demonstrated, 0.9=expert-level
- preferences should be actionable (e.g., "editor": "vscode", "framework": "react")
- workflowSteps should be the sequence of actions in this conversation
- Keep traits factual (e.g., "detail-oriented", "prefers Spanish")`;

export class UserProfileManager {
	private config: UserModelingConfig;
	private db: DatabaseAdapter;
	private llmRouter: LLMRouter;
	private initialized = false;
	private profileCache: Map<string, UserProfile> = new Map();

	constructor(
		db: DatabaseAdapter,
		llmRouter: LLMRouter,
		config: Partial<UserModelingConfig> = {},
	) {
		this.config = { ...DEFAULT_USER_MODELING_CONFIG, ...config };
		this.db = db;
		this.llmRouter = llmRouter;
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;

		await this.db.run(
			`CREATE TABLE IF NOT EXISTS user_profiles (
				user_id TEXT PRIMARY KEY,
				display_name TEXT,
				communication_style TEXT NOT NULL DEFAULT 'detailed',
				preferred_language TEXT NOT NULL DEFAULT 'en',
				expertise_areas TEXT NOT NULL DEFAULT '{}',
				preferences TEXT NOT NULL DEFAULT '{}',
				decisions TEXT NOT NULL DEFAULT '[]',
				workflow_patterns TEXT NOT NULL DEFAULT '[]',
				traits TEXT NOT NULL DEFAULT '[]',
				conversation_count INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL DEFAULT (datetime('now')),
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			)`,
		);

		this.initialized = true;
	}

	/**
	 * Get or create a user profile.
	 */
	async getProfile(userId: string): Promise<UserProfile> {
		await this.initialize();

		// Check cache
		const cached = this.profileCache.get(userId);
		if (cached) return cached;

		const row = await this.db.get<{
			user_id: string;
			display_name: string | null;
			communication_style: string;
			preferred_language: string;
			expertise_areas: string;
			preferences: string;
			decisions: string;
			workflow_patterns: string;
			traits: string;
			conversation_count: number;
			created_at: string;
			updated_at: string;
		}>("SELECT * FROM user_profiles WHERE user_id = ?", [userId]);

		if (row) {
			const profile = this.rowToProfile(row);
			this.profileCache.set(userId, profile);
			return profile;
		}

		// Create new profile
		const newProfile: UserProfile = {
			userId,
			displayName: null,
			communicationStyle: "detailed",
			preferredLanguage: "en",
			expertiseAreas: {},
			preferences: {},
			decisions: [],
			workflowPatterns: [],
			traits: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			conversationCount: 0,
		};

		await this.saveProfile(newProfile);
		this.profileCache.set(userId, newProfile);
		return newProfile;
	}

	/**
	 * Update the user profile based on a conversation.
	 * This is the core of the user modeling system.
	 */
	async updateFromConversation(
		userId: string,
		turns: ConversationTurn[],
	): Promise<UserProfile> {
		if (turns.length < this.config.minTurnsForUpdate) {
			return this.getProfile(userId);
		}

		const profile = await this.getProfile(userId);

		if (this.config.useLLMExtraction) {
			return this.updateWithLLM(profile, turns);
		}
		return this.updateWithHeuristics(profile, turns);
	}

	/**
	 * Get a context string suitable for injection into system prompts.
	 */
	getProfileContext(profile: UserProfile): string {
		const parts: string[] = [];

		parts.push(`## User Profile`);

		if (profile.displayName) {
			parts.push(`Name: ${profile.displayName}`);
		}

		parts.push(`Communication style: ${profile.communicationStyle}`);
		parts.push(`Preferred language: ${profile.preferredLanguage}`);

		const expertiseEntries = Object.entries(profile.expertiseAreas)
			.filter(([, v]) => v >= 0.3)
			.sort(([, a], [, b]) => b - a);

		if (expertiseEntries.length > 0) {
			parts.push(`\nExpertise areas:`);
			for (const [area, confidence] of expertiseEntries.slice(0, 10)) {
				const level =
					confidence >= 0.8
						? "expert"
						: confidence >= 0.5
							? "proficient"
							: "familiar";
				parts.push(`- ${area} (${level})`);
			}
		}

		const prefEntries = Object.entries(profile.preferences);
		if (prefEntries.length > 0) {
			parts.push(`\nPreferences:`);
			for (const [key, value] of prefEntries.slice(0, 15)) {
				parts.push(`- ${key}: ${value}`);
			}
		}

		if (profile.traits.length > 0) {
			parts.push(`\nTraits: ${profile.traits.join(", ")}`);
		}

		return parts.join("\n");
	}

	// --- Private ---

	private async updateWithLLM(
		profile: UserProfile,
		turns: ConversationTurn[],
	): Promise<UserProfile> {
		try {
			const recentTurns = turns.slice(-15);
			const conversation = recentTurns
				.map((t) => {
					const content =
						t.content.length > 200
							? `${t.content.substring(0, 200)}...`
							: t.content;
					return `[${t.role}]: ${content}`;
				})
				.join("\n");

			const response = await this.llmRouter.chat({
				model: this.config.model ?? "default",
				messages: [
					{ role: "system", content: PROFILE_EXTRACTION_PROMPT },
					{
						role: "user",
						content: `Existing profile:\n${JSON.stringify({
							style: profile.communicationStyle,
							language: profile.preferredLanguage,
							expertise: profile.expertiseAreas,
							preferences: profile.preferences,
							traits: profile.traits,
						}, null, 2)}\n\nNew conversation:\n${conversation}`,
					},
				],
				maxTokens: 1000,
				temperature: 0.2,
			});

			const extracted = this.parseExtraction(response.content);
			return this.mergeIntoProfile(profile, extracted);
		} catch (err) {
			logger.error(`LLM profile extraction failed, using heuristics: ${String(err)}`);
			return this.updateWithHeuristics(profile, turns);
		}
	}

	private updateWithHeuristics(
		profile: UserProfile,
		turns: ConversationTurn[],
	): UserProfile {
		const updated = { ...profile };
		const userContent = turns
			.filter((t) => t.role === "user")
			.map((t) => t.content)
			.join(" ");

		// Detect language
		const spanishIndicators = /\b(hola|quiero|puedes|necesito|cómo|está|gracias|por favor)\b/gi;
		const englishIndicators = /\b(hello|want|can you|need|how|please|thanks)\b/gi;
		const spanishCount = (userContent.match(spanishIndicators) ?? []).length;
		const englishCount = (userContent.match(englishIndicators) ?? []).length;

		if (spanishCount > englishCount && spanishCount >= 2) {
			updated.preferredLanguage = "es";
		} else if (englishCount > spanishCount && englishCount >= 2) {
			updated.preferredLanguage = "en";
		}

		// Detect communication style
		const avgUserLength =
			turns
				.filter((t) => t.role === "user")
				.reduce((sum, t) => sum + t.content.length, 0) /
			Math.max(turns.filter((t) => t.role === "user").length, 1);

		if (avgUserLength < 50) {
			updated.communicationStyle = "concise";
		} else if (avgUserLength > 200) {
			updated.communicationStyle = "detailed";
		}

		// Detect expertise from technical terms
		const techPatterns: [RegExp, string][] = [
			[/\b(typescript|javascript|node\.js|react|vue|angular)\b/gi, "JavaScript/TypeScript"],
			[/\b(python|django|flask|fastapi)\b/gi, "Python"],
			[/\b(docker|kubernetes|k8s|devops|ci\/cd)\b/gi, "DevOps"],
			[/\b(sql|database|postgres|mysql|sqlite)\b/gi, "Databases"],
			[/\b(api|rest|graphql|grpc)\b/gi, "API Development"],
			[/\b(machine learning|ml|ai|neural|model)\b/gi, "AI/ML"],
			[/\b(css|html|ui|ux|design|tailwind)\b/gi, "Frontend/Design"],
		];

		for (const [pattern, area] of techPatterns) {
			const matches = (userContent.match(pattern) ?? []).length;
			if (matches > 0) {
				const current = updated.expertiseAreas[area] ?? 0;
				updated.expertiseAreas[area] = Math.min(1, current + matches * 0.15);
			}
		}

		updated.conversationCount += 1;
		updated.updatedAt = new Date().toISOString();

		this.saveProfile(updated);
		this.profileCache.set(updated.userId, updated);
		return updated;
	}

	private parseExtraction(content: string): Record<string, unknown> {
		try {
			const jsonMatch = content.match(/\{[\s\S]*\}/);
			if (!jsonMatch) return {};
			return JSON.parse(jsonMatch[0]);
		} catch {
			return {};
		}
	}

	private mergeIntoProfile(
		profile: UserProfile,
		extracted: Record<string, unknown>,
	): UserProfile {
		const updated = { ...profile };

		if (typeof extracted.communicationStyle === "string") {
			updated.communicationStyle = extracted.communicationStyle;
		}
		if (typeof extracted.language === "string") {
			updated.preferredLanguage = extracted.language;
		}

		// Merge expertise areas (keep max confidence)
		if (
			extracted.expertiseAreas &&
			typeof extracted.expertiseAreas === "object"
		) {
			const areas = extracted.expertiseAreas as Record<string, number>;
			for (const [area, confidence] of Object.entries(areas)) {
				const current = updated.expertiseAreas[area] ?? 0;
				updated.expertiseAreas[area] = Math.max(current, confidence);
			}
		}

		// Merge preferences (new values override)
		if (extracted.preferences && typeof extracted.preferences === "object") {
			const prefs = extracted.preferences as Record<string, string>;
			for (const [key, value] of Object.entries(prefs)) {
				updated.preferences[key] = value;
			}
		}

		// Append decisions (trim to max)
		if (Array.isArray(extracted.decisions)) {
			const newDecisions = extracted.decisions
				.filter(
					(d: Record<string, unknown>) =>
						d && typeof d.description === "string",
				)
				.map((d: Record<string, string>) => ({
					description: d.description,
					choice: d.choice ?? "",
					reasoning: d.reasoning ?? "",
					timestamp: new Date().toISOString(),
				}));
			updated.decisions = [
				...updated.decisions,
				...newDecisions,
			].slice(-this.config.maxDecisions);
		}

		// Append workflow patterns
		if (Array.isArray(extracted.workflowSteps) && extracted.workflowSteps.length >= 2) {
			const steps = extracted.workflowSteps as string[];
			const existingPattern = updated.workflowPatterns.find(
				(wp) => wp.steps.length === steps.length &&
					wp.steps.every((s, i) => s === steps[i]),
			);

			if (existingPattern) {
				existingPattern.frequency += 1;
				existingPattern.lastUsed = new Date().toISOString();
			} else {
				updated.workflowPatterns.push({
					name: steps.slice(0, 3).join(" → "),
					steps,
					frequency: 1,
					lastUsed: new Date().toISOString(),
				});
				// Trim to max
				if (updated.workflowPatterns.length > this.config.maxWorkflows) {
					updated.workflowPatterns.sort((a, b) => b.frequency - a.frequency);
					updated.workflowPatterns = updated.workflowPatterns.slice(
						0,
						this.config.maxWorkflows,
					);
				}
			}
		}

		// Merge traits (deduplicate)
		if (Array.isArray(extracted.traits)) {
			const newTraits = extracted.traits as string[];
			const allTraits = new Set([...updated.traits, ...newTraits]);
			updated.traits = Array.from(allTraits).slice(0, 20);
		}

		updated.conversationCount += 1;
		updated.updatedAt = new Date().toISOString();

		this.saveProfile(updated);
		this.profileCache.set(updated.userId, updated);
		return updated;
	}

	private async saveProfile(profile: UserProfile): Promise<void> {
		await this.initialize();
		await this.db.run(
			`INSERT OR REPLACE INTO user_profiles 
			(user_id, display_name, communication_style, preferred_language, expertise_areas, preferences, decisions, workflow_patterns, traits, conversation_count, created_at, updated_at) 
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				profile.userId,
				profile.displayName,
				profile.communicationStyle,
				profile.preferredLanguage,
				JSON.stringify(profile.expertiseAreas),
				JSON.stringify(profile.preferences),
				JSON.stringify(profile.decisions),
				JSON.stringify(profile.workflowPatterns),
				JSON.stringify(profile.traits),
				profile.conversationCount,
				profile.createdAt,
				profile.updatedAt,
			],
		);
	}

	private rowToProfile(row: Record<string, unknown>): UserProfile {
		return {
			userId: String(row.user_id),
			displayName: row.display_name as string | null,
			communicationStyle: String(row.communication_style ?? "detailed"),
			preferredLanguage: String(row.preferred_language ?? "en"),
			expertiseAreas: JSON.parse(String(row.expertise_areas ?? "{}")),
			preferences: JSON.parse(String(row.preferences ?? "{}")),
			decisions: JSON.parse(String(row.decisions ?? "[]")),
			workflowPatterns: JSON.parse(String(row.workflow_patterns ?? "[]")),
			traits: JSON.parse(String(row.traits ?? "[]")),
			conversationCount: Number(row.conversation_count ?? 0),
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
		};
	}

	/**
	 * Manually update and save a profile (used by the web UI API).
	 */
	async updateManual(profile: UserProfile): Promise<void> {
		await this.saveProfile(profile);
		this.profileCache.set(profile.userId, profile);
	}
}
