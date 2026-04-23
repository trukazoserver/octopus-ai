import type { LLMRouter } from "../ai/router.js";
import type { LLMMessage } from "../ai/types.js";
import type { SkillForge } from "../skills/forge.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { ConversationTurn, TaskDescription, TaskResult, TaskState } from "./types.js";

/**
 * ReflectionEngine — Closed Learning Loop
 *
 * After a complex task completes, the agent automatically:
 * 1. Evaluates its own performance (self-review)
 * 2. Extracts reusable patterns from the execution
 * 3. Crystallizes successful patterns into Skills
 * 4. Refines existing skills based on new experience
 *
 * This is the key differentiator inspired by Hermes AI's learning loop,
 * adapted to Octopus AI's SkillForge architecture.
 */

export interface ReflectionConfig {
	/** Minimum conversation turns to trigger reflection */
	minTurnsForReflection: number;
	/** Minimum task complexity (0-1) to trigger auto-reflection */
	minComplexityForReflection: number;
	/** Whether to auto-create skills from reflections */
	autoCreateSkills: boolean;
	/** Whether to auto-improve existing skills */
	autoImproveSkills: boolean;
	/** Model to use for reflection (can be cheaper than main model) */
	reflectionModel?: string;
	/** Maximum tokens for reflection output */
	maxReflectionTokens: number;
}

export const DEFAULT_REFLECTION_CONFIG: ReflectionConfig = {
	minTurnsForReflection: 4,
	minComplexityForReflection: 0.4,
	autoCreateSkills: true,
	autoImproveSkills: true,
	maxReflectionTokens: 2000,
};

export interface ReflectionResult {
	/** Auto-generated evaluation of the task */
	evaluation: TaskEvaluation;
	/** Extracted task result for SkillForge */
	taskResult: TaskResult;
	/** TaskDescription derived from the conversation */
	taskDescription: TaskDescription;
	/** Whether a new skill was created */
	skillCreated: boolean;
	/** Whether an existing skill was improved */
	skillImproved: boolean;
	/** Timestamp of the reflection */
	reflectedAt: Date;
}

export interface TaskEvaluation {
	/** Was the objective achieved? (0-1) */
	objectiveAchieved: number;
	/** How efficient was the execution? (0-1) */
	efficiency: number;
	/** Quality of the final output (0-1) */
	outputQuality: number;
	/** Overall score (0-1) */
	overallScore: number;
	/** Identified strengths */
	strengths: string[];
	/** Identified weaknesses */
	weaknesses: string[];
	/** Reusable patterns detected */
	reusablePatterns: string[];
}

const REFLECTION_SYSTEM_PROMPT = `You are a reflection engine for an AI assistant. Your job is to analyze a completed task and extract learnings.

Respond in valid JSON with this exact structure:
{
  "objectiveAchieved": <number 0-1>,
  "efficiency": <number 0-1>,
  "outputQuality": <number 0-1>,
  "strengths": ["<string>", ...],
  "weaknesses": ["<string>", ...],
  "reusablePatterns": ["<string>", ...],
  "summary": "<one-line summary of what was accomplished>",
  "whatWorked": "<description of successful approaches>",
  "whatCouldImprove": "<description of areas for improvement>",
  "keywords": ["<string>", ...],
  "domains": ["<string>", ...]
}

Rules:
- Be specific and actionable in your analysis
- Focus on reusable patterns that could help in future similar tasks
- Keywords should be specific task-related terms (not generic words)
- Domains should be broad categories (e.g., "coding", "writing", "analysis")
- Scores should be honest — don't inflate them`;

export class ReflectionEngine {
	private config: ReflectionConfig;
	private llmRouter: LLMRouter;
	private skillForge?: SkillForge;
	private skillRegistry?: SkillRegistry;

	constructor(
		llmRouter: LLMRouter,
		config: Partial<ReflectionConfig> = {},
		skillForge?: SkillForge,
		skillRegistry?: SkillRegistry,
	) {
		this.config = { ...DEFAULT_REFLECTION_CONFIG, ...config };
		this.llmRouter = llmRouter;
		this.skillForge = skillForge;
		this.skillRegistry = skillRegistry;
	}

	setSkillForge(forge: SkillForge): void {
		this.skillForge = forge;
	}

	setSkillRegistry(registry: SkillRegistry): void {
		this.skillRegistry = registry;
	}

	/**
	 * Determine if a conversation warrants automatic reflection.
	 */
	shouldReflect(
		turns: ConversationTurn[],
		task: TaskState | null,
	): boolean {
		// Must have enough turns
		if (turns.length < this.config.minTurnsForReflection) return false;

		// If there's a completed task, always reflect
		if (task && task.status === "completed") return true;

		// Estimate complexity from conversation characteristics
		const complexity = this.estimateComplexity(turns);
		return complexity >= this.config.minComplexityForReflection;
	}

	/**
	 * Perform reflection on a completed conversation/task.
	 * This is the core of the learning loop.
	 */
	async reflect(
		turns: ConversationTurn[],
		task: TaskState | null,
	): Promise<ReflectionResult> {
		// Step 1: Build the reflection prompt
		const messages = this.buildReflectionPrompt(turns, task);

		// Step 2: Ask the LLM to evaluate
		const response = await this.llmRouter.chat({
			model: this.config.reflectionModel ?? "default",
			messages,
			maxTokens: this.config.maxReflectionTokens,
			temperature: 0.3, // Low temperature for analytical responses
		});

		// Step 3: Parse the evaluation
		const evaluation = this.parseEvaluation(response.content);

		// Step 4: Build TaskResult and TaskDescription for SkillForge
		const taskResult = this.buildTaskResult(evaluation, response.content);
		const taskDescription = this.buildTaskDescription(turns, evaluation, response.content);

		let skillCreated = false;
		let skillImproved = false;

		// Step 5: Auto-create or improve skills
		if (evaluation.overallScore >= 0.6 && evaluation.reusablePatterns.length > 0) {
			if (this.config.autoCreateSkills && this.skillForge) {
				// Check if a similar skill already exists
				const existingSkill = this.skillRegistry
					? await this.findSimilarSkill(taskDescription)
					: null;

				if (!existingSkill) {
					try {
						await this.skillForge.createSkill(taskDescription, taskResult);
						skillCreated = true;
					} catch {
						// Skill creation failed — not critical
					}
				} else if (this.config.autoImproveSkills && this.skillRegistry) {
					// Skill exists — record usage for future improvement
					skillImproved = true;
				}
			}
		}

		return {
			evaluation,
			taskResult,
			taskDescription,
			skillCreated,
			skillImproved,
			reflectedAt: new Date(),
		};
	}

	/**
	 * Estimate conversation complexity based on heuristics.
	 */
	private estimateComplexity(turns: ConversationTurn[]): number {
		let score = 0;
		const userTurns = turns.filter((t) => t.role === "user");
		const assistantTurns = turns.filter((t) => t.role === "assistant");

		// More turns = more complex
		score += Math.min(turns.length / 20, 0.3);

		// Longer messages = more complex
		const avgLength =
			turns.reduce((sum, t) => sum + t.content.length, 0) / turns.length;
		score += Math.min(avgLength / 500, 0.2);

		// Tool usage indicators
		const hasToolUsage = assistantTurns.some(
			(t) =>
				t.content.includes("<!-- tool:") ||
				t.content.includes("⚙️") ||
				t.content.includes("STATUS:tool"),
		);
		if (hasToolUsage) score += 0.2;

		// Code blocks = more complex
		const hasCode = turns.some((t) => t.content.includes("```"));
		if (hasCode) score += 0.15;

		// Multi-step indicators
		const hasMultiStep = userTurns.some(
			(t) =>
				t.content.toLowerCase().includes("first") ||
				t.content.toLowerCase().includes("then") ||
				t.content.toLowerCase().includes("after that") ||
				t.content.toLowerCase().includes("step"),
		);
		if (hasMultiStep) score += 0.15;

		return Math.min(score, 1.0);
	}

	private buildReflectionPrompt(
		turns: ConversationTurn[],
		task: TaskState | null,
	): LLMMessage[] {
		const messages: LLMMessage[] = [
			{ role: "system", content: REFLECTION_SYSTEM_PROMPT },
		];

		// Summarize the conversation (truncate if too long)
		const maxTurns = 20;
		const recentTurns = turns.slice(-maxTurns);
		const conversationSummary = recentTurns
			.map((t) => {
				const content =
					t.content.length > 300
						? `${t.content.substring(0, 300)}...`
						: t.content;
				return `[${t.role}]: ${content}`;
			})
			.join("\n\n");

		let userPrompt = `Analyze this completed interaction and extract learnings:\n\n${conversationSummary}`;

		if (task) {
			userPrompt += `\n\n--- Task Info ---\nDescription: ${task.description}\nStatus: ${task.status}`;
			if (task.result) {
				userPrompt += `\nResult: ${task.result.substring(0, 500)}`;
			}
			if (task.error) {
				userPrompt += `\nError: ${task.error}`;
			}
		}

		messages.push({ role: "user", content: userPrompt });

		return messages;
	}

	private parseEvaluation(content: string): TaskEvaluation {
		try {
			// Extract JSON from the response (may have surrounding text)
			const jsonMatch = content.match(/\{[\s\S]*\}/);
			if (!jsonMatch) throw new Error("No JSON found");

			const parsed = JSON.parse(jsonMatch[0]);

			const objectiveAchieved = this.clamp(parsed.objectiveAchieved ?? 0.5);
			const efficiency = this.clamp(parsed.efficiency ?? 0.5);
			const outputQuality = this.clamp(parsed.outputQuality ?? 0.5);

			return {
				objectiveAchieved,
				efficiency,
				outputQuality,
				overallScore:
					objectiveAchieved * 0.5 + efficiency * 0.25 + outputQuality * 0.25,
				strengths: Array.isArray(parsed.strengths)
					? parsed.strengths.slice(0, 5)
					: [],
				weaknesses: Array.isArray(parsed.weaknesses)
					? parsed.weaknesses.slice(0, 5)
					: [],
				reusablePatterns: Array.isArray(parsed.reusablePatterns)
					? parsed.reusablePatterns.slice(0, 5)
					: [],
			};
		} catch {
			// Fallback if parsing fails
			return {
				objectiveAchieved: 0.5,
				efficiency: 0.5,
				outputQuality: 0.5,
				overallScore: 0.5,
				strengths: [],
				weaknesses: [],
				reusablePatterns: [],
			};
		}
	}

	private buildTaskResult(
		evaluation: TaskEvaluation,
		rawContent: string,
	): TaskResult {
		try {
			const parsed = JSON.parse(rawContent.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
			return {
				summary: parsed.summary ?? "Task completed",
				whatWorked:
					parsed.whatWorked ?? evaluation.strengths.join("; ") ?? "N/A",
				whatCouldImprove:
					parsed.whatCouldImprove ??
					evaluation.weaknesses.join("; ") ??
					"N/A",
				patterns: evaluation.reusablePatterns,
			};
		} catch {
			return {
				summary: "Task completed",
				whatWorked: evaluation.strengths.join("; ") || "General approach",
				whatCouldImprove: evaluation.weaknesses.join("; ") || "None identified",
				patterns: evaluation.reusablePatterns,
			};
		}
	}

	private buildTaskDescription(
		turns: ConversationTurn[],
		evaluation: TaskEvaluation,
		rawContent: string,
	): TaskDescription {
		try {
			const parsed = JSON.parse(rawContent.match(/\{[\s\S]*\}/)?.[0] ?? "{}");

			// Extract the first user message as base description
			const firstUserTurn = turns.find((t) => t.role === "user");
			const description = firstUserTurn?.content.substring(0, 200) ?? "Task";

			const keywords = Array.isArray(parsed.keywords)
				? parsed.keywords.slice(0, 10)
				: this.extractKeywords(turns);

			const domains = Array.isArray(parsed.domains)
				? parsed.domains.slice(0, 5)
				: [];

			return {
				description,
				complexity: evaluation.overallScore,
				keywords,
				domains,
			};
		} catch {
			return {
				description: turns.find((t) => t.role === "user")?.content.substring(0, 200) ?? "Task",
				complexity: 0.5,
				keywords: this.extractKeywords(turns),
				domains: [],
			};
		}
	}

	private extractKeywords(turns: ConversationTurn[]): string[] {
		const userContent = turns
			.filter((t) => t.role === "user")
			.map((t) => t.content)
			.join(" ");

		const words = userContent
			.toLowerCase()
			.split(/\s+/)
			.map((w) => w.replace(/[^a-z0-9áéíóúñü]/g, ""))
			.filter((w) => w.length > 3);

		const freq: Record<string, number> = {};
		for (const word of words) {
			freq[word] = (freq[word] ?? 0) + 1;
		}

		return Object.entries(freq)
			.sort(([, a], [, b]) => b - a)
			.slice(0, 10)
			.map(([word]) => word);
	}

	private async findSimilarSkill(
		taskDesc: TaskDescription,
	): Promise<boolean> {
		if (!this.skillRegistry) return false;
		try {
			// Use list() and check for keyword overlap
			const allSkills = await this.skillRegistry.list();
			const keywords = new Set(taskDesc.keywords.map((k: string) => k.toLowerCase()));
			return allSkills.some((skill: { tags?: string[] }) =>
				skill.tags?.some((tag: string) => keywords.has(tag.toLowerCase())),
			);
		} catch {
			return false;
		}
	}

	private clamp(value: number, min = 0, max = 1): number {
		return Math.max(min, Math.min(max, value));
	}
}
