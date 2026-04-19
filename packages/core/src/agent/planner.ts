import { nanoid } from "nanoid";
import type { LLMRouter } from "../ai/router.js";
import type { LLMMessage } from "../ai/types.js";

export interface PlanStep {
	id: string;
	description: string;
	status: "pending" | "in_progress" | "completed" | "failed";
	dependencies: string[];
}

export class TaskPlanner {
	private llmRouter: LLMRouter;

	constructor(llmRouter: LLMRouter) {
		this.llmRouter = llmRouter;
	}

	async plan(description: string): Promise<{
		steps: PlanStep[];
		complexity: number;
		needsApproval: boolean;
	}> {
		const available = this.llmRouter.getAvailableProviders();
		if (available.length === 0) {
			return this.fallbackPlan(description);
		}

		try {
			const messages: LLMMessage[] = [
				{
					role: "system",
					content: `You are a task planning assistant. Break down the given task into clear, actionable steps.
Return ONLY a JSON array of step descriptions, no other text.
Each step should be a single, concrete action.
If the task is simple (1-2 steps), return a short array.
Example: ["Read the file", "Analyze the content", "Generate a summary"]`,
				},
				{
					role: "user",
					content: `Break this task into steps: "${description}"`,
				},
			];

			const response = await this.llmRouter.chat({
				model: "default",
				messages,
				maxTokens: 1024,
				temperature: 0.3,
			});

			const steps = this.parseStepsFromResponse(response.content);
			return this.buildPlanFromSteps(steps, description);
		} catch {
			return this.fallbackPlan(description);
		}
	}

	async refinePlan(steps: PlanStep[], feedback: string): Promise<PlanStep[]> {
		const available = this.llmRouter.getAvailableProviders();
		if (available.length === 0) {
			return this.fallbackRefine(steps, feedback);
		}

		try {
			const currentSteps = steps
				.map((s) => `- [${s.status}] ${s.description}`)
				.join("\n");
			const messages: LLMMessage[] = [
				{
					role: "system",
					content: `You are a task planning assistant. You are refining an existing plan based on feedback.
Return ONLY a JSON array of step descriptions (strings), no other text.`,
				},
				{
					role: "user",
					content: `Current plan:\n${currentSteps}\n\nFeedback: "${feedback}"\n\nReturn the refined steps as a JSON array.`,
				},
			];

			const response = await this.llmRouter.chat({
				model: "default",
				messages,
				maxTokens: 1024,
				temperature: 0.3,
			});

			const refinedDescriptions = this.parseStepsFromResponse(response.content);
			if (refinedDescriptions.length === 0) {
				return this.fallbackRefine(steps, feedback);
			}

			return refinedDescriptions.map((desc, index) => ({
				id: nanoid(),
				description: desc,
				status: "pending" as const,
				dependencies:
					index > 0
						? [refinedDescriptions.slice(0, index).length > 0 ? "" : ""]
						: [],
			}));
		} catch {
			return this.fallbackRefine(steps, feedback);
		}
	}

	private parseStepsFromResponse(content: string): string[] {
		let cleaned = content.trim();

		const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
		if (jsonMatch) {
			cleaned = jsonMatch[0];
		}

		try {
			const parsed = JSON.parse(cleaned);
			if (Array.isArray(parsed)) {
				return parsed
					.filter(
						(item): item is string =>
							typeof item === "string" && item.trim().length > 0,
					)
					.map((s) => s.trim());
			}
		} catch {
			/* not valid JSON */
		}

		const lines = cleaned
			.split(/\n/)
			.map((l) => l.replace(/^[\s\-\d.)*\]]+/, "").trim())
			.filter((l) => l.length > 5);
		return lines;
	}

	private buildPlanFromSteps(
		stepDescriptions: string[],
		originalDescription: string,
	): {
		steps: PlanStep[];
		complexity: number;
		needsApproval: boolean;
	} {
		const steps: PlanStep[] = stepDescriptions.map((desc, index) => ({
			id: nanoid(),
			description: desc,
			status: "pending" as const,
			dependencies:
				index > 0
					? [stepDescriptions.slice(0, index).length > 0 ? "" : ""]
					: [],
		}));

		for (let i = 1; i < steps.length; i++) {
			steps[i].dependencies = [steps[i - 1].id];
		}

		const stepComplexity = Math.min(steps.length / 5, 1);
		const lengthComplexity = Math.min(originalDescription.length / 500, 1);
		const complexity = Math.min((stepComplexity + lengthComplexity) / 2, 1);

		return {
			steps,
			complexity,
			needsApproval: complexity > 0.7,
		};
	}

	private fallbackPlan(description: string): {
		steps: PlanStep[];
		complexity: number;
		needsApproval: boolean;
	} {
		const delimiters = [
			/\s+then\s+/gi,
			/\s+and\s+then\s+/gi,
			/\s+after\s+that\s*/gi,
			/\s+next[,]\s*/gi,
			/\s+next\s+/gi,
			/\n+/g,
			/;\s*/g,
		];

		let parts: string[] = [description];
		for (const delimiter of delimiters) {
			const newParts: string[] = [];
			for (const part of parts) {
				const split = part
					.split(delimiter)
					.map((s) => s.trim())
					.filter((s) => s.length > 0);
				newParts.push(...split);
			}
			parts = newParts;
		}

		return this.buildPlanFromSteps(parts, description);
	}

	private fallbackRefine(steps: PlanStep[], feedback: string): PlanStep[] {
		const feedbackLower = feedback.toLowerCase();
		const keywords = feedbackLower.split(/\s+/).filter((w) => w.length > 3);

		return steps.map((step) => {
			const stepLower = step.description.toLowerCase();
			const isRelevant = keywords.some((kw) => stepLower.includes(kw));

			if (isRelevant && step.status === "pending") {
				return {
					...step,
					description: `${step.description} [modified: ${feedback.slice(0, 80)}]`,
				};
			}
			return step;
		});
	}
}
