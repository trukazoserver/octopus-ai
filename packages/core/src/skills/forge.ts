import { nanoid } from "nanoid";
import type { TaskDescription, TaskResult } from "../agent/types.js";
import type { EmbeddingFunction } from "../memory/types.js";
import type { SkillRegistry } from "./registry.js";
import type { Skill, SkillForgeConfig } from "./types.js";

export class SkillForge {
	private registry: SkillRegistry;
	private embedFn: EmbeddingFunction;
	private config: SkillForgeConfig;
	private readonly _FORGE_SYSTEM_PROMPT: string =
		"You are a skill forge engine. Your task is to create, refine, and improve reusable skills from task outcomes. Generate clear, specific, actionable skill instructions with examples.";

	constructor(
		registry: SkillRegistry,
		embedFn: EmbeddingFunction,
		config: SkillForgeConfig,
	) {
		this.registry = registry;
		this.embedFn = embedFn;
		this.config = config;
	}

	async createSkill(task: TaskDescription, result: TaskResult): Promise<Skill> {
		const name = this.generateSkillName(task);
		const instructions = this.generateInstructions(task, result);
		const example = `Task: ${task.description}\nResult: ${result.summary}\nWhat worked: ${result.whatWorked}`;

		const keywords = task.keywords.slice(0, 10);
		const domains = task.domains;

		const skill: Partial<Skill> = {
			id: nanoid(),
			name,
			version: "1.0.0",
			description: task.description.slice(0, 200),
			tags: [...keywords, ...domains],
			instructions,
			examples: this.config.includeExamples ? [example] : [],
			templates: this.config.includeTemplates
				? this.extractTemplates(result)
				: [],
			triggerConditions: {
				keywords,
				taskPatterns: this.extractPatterns(task, result),
				domains,
			},
			contextEstimate: {
				instructions: Math.ceil(instructions.length / 4),
				perExample: Math.ceil(example.length / 4),
				templates: 0,
			},
			metrics: {
				timesUsed: 0,
				successRate: 0,
				avgUserRating: 0,
				lastUsed: new Date().toISOString(),
				improvementsCount: 0,
				createdAt: new Date().toISOString(),
			},
			quality: {
				completeness: 0,
				accuracy: 0,
				clarity: 0,
			},
			dependencies: [],
			related: [],
		};

		if (this.config.selfCritique) {
			const critique = this.selfCritique(skill);
			skill.quality = critique.scores;

			if (
				(critique.scores.completeness +
					critique.scores.accuracy +
					critique.scores.clarity) /
					3 <
				this.config.minQualityScore
			) {
				const improved = this.applyCritique(skill, critique);
				const reCritique = this.selfCritique(improved);
				improved.quality = reCritique.scores;
				Object.assign(skill, improved);
			}
		} else {
			const critique = this.selfCritique(skill);
			skill.quality = critique.scores;
		}

		const embedding = await this.embedFn(
			`${skill.name} ${skill.description} ${skill.instructions}`,
		);
		skill.embedding = embedding;

		if (skill.contextEstimate) {
			skill.contextEstimate.templates = (skill.templates ?? []).reduce(
				(sum: number, t: string) => sum + Math.ceil(t.length / 4),
				0,
			);
		}

		const fullSkill = skill as Skill;
		await this.registry.save(fullSkill);
		return fullSkill;
	}

	private generateSkillName(task: TaskDescription): string {
		const words = task.description
			.toLowerCase()
			.split(/\s+/)
			.map((w) => w.replace(/[^a-z0-9]/g, ""))
			.filter((w) => w.length > 2);
		const unique = [...new Set(words)];
		const selected = unique.slice(0, 3);
		return selected.join("-") || "unnamed-skill";
	}

	private generateInstructions(
		task: TaskDescription,
		result: TaskResult,
	): string {
		const sections: string[] = [];
		sections.push("## Overview");
		sections.push(task.description);
		sections.push("");
		sections.push("## Approach");
		sections.push(result.summary);
		sections.push("");
		sections.push("## What Worked");
		sections.push(result.whatWorked);
		sections.push("");
		sections.push("## Areas for Improvement");
		sections.push(result.whatCouldImprove);

		if (result.patterns.length > 0) {
			sections.push("");
			sections.push("## Patterns");
			for (const pattern of result.patterns) {
				sections.push(`- ${pattern}`);
			}
		}

		if (task.domains.length > 0) {
			sections.push("");
			sections.push("## Domains");
			sections.push(task.domains.join(", "));
		}

		return sections.join("\n");
	}

	private selfCritique(skill: Partial<Skill>): {
		scores: Skill["quality"];
		improvements: string[];
	} {
		const improvements: string[] = [];

		const instructionsLength = (skill.instructions ?? "").length;
		const completeness = Math.min(
			1,
			(instructionsLength / 500) * 0.3 +
				((skill.examples ?? []).length > 0 ? 0.3 : 0) +
				((skill.triggerConditions?.keywords.length ?? 0) > 0 ? 0.2 : 0) +
				((skill.triggerConditions?.domains.length ?? 0) > 0 ? 0.2 : 0),
		);

		const accuracy = 0.5;

		const sectionCount = (skill.instructions ?? "").split("##").length - 1;
		const clarity = Math.min(
			1,
			(sectionCount >= 3 ? 0.4 : (sectionCount / 3) * 0.4) +
				((skill.examples ?? []).length > 0 ? 0.3 : 0) +
				((skill.triggerConditions?.keywords.length ?? 0) >= 3 ? 0.3 : 0),
		);

		if ((skill.examples ?? []).length === 0) {
			improvements.push("Add examples to improve skill quality");
		}
		if (instructionsLength < 200) {
			improvements.push("Instructions are too short, add more detail");
		}
		if ((skill.triggerConditions?.keywords.length ?? 0) < 3) {
			improvements.push("Add more trigger keywords for better matching");
		}
		if (sectionCount < 3) {
			improvements.push("Add more structured sections to instructions");
		}

		return {
			scores: {
				completeness: Math.round(completeness * 100) / 100,
				accuracy: Math.round(accuracy * 100) / 100,
				clarity: Math.round(clarity * 100) / 100,
			},
			improvements,
		};
	}

	private applyCritique(
		skill: Partial<Skill>,
		critique: ReturnType<SkillForge["selfCritique"]>,
	): Partial<Skill> {
		const improved = { ...skill };

		if (
			critique.improvements.some(
				(i) => i.includes("examples") && (improved.examples ?? []).length === 0,
			)
		) {
			improved.examples = [
				`Example usage for ${improved.name ?? "skill"}: Apply the instructions to complete the described task.`,
			];
		}

		if (
			critique.improvements.some(
				(i) =>
					i.includes("too short") && (improved.instructions ?? "").length < 200,
			)
		) {
			improved.instructions = `${improved.instructions ?? ""}\n\n## Guidelines\nFollow the approach described above step by step. Adapt as needed for the specific context.`;
		}

		if (
			critique.improvements.some(
				(i) =>
					i.includes("trigger keywords") &&
					(improved.triggerConditions?.keywords.length ?? 0) < 3,
			)
		) {
			const baseKeywords = improved.triggerConditions?.keywords ?? [];
			const descWords = (improved.description ?? "")
				.toLowerCase()
				.split(/\s+/)
				.map((w) => w.replace(/[^a-z0-9]/g, ""))
				.filter((w) => w.length > 3 && !baseKeywords.includes(w))
				.slice(0, 5);
			improved.triggerConditions = {
				...(improved.triggerConditions ?? {
					keywords: [],
					taskPatterns: [],
					domains: [],
				}),
				keywords: [...baseKeywords, ...descWords],
			};
		}

		return improved;
	}

	private extractTemplates(result: TaskResult): string[] {
		const templates: string[] = [];
		if (result.patterns.length > 0) {
			for (const pattern of result.patterns) {
				templates.push(`Pattern: ${pattern}`);
			}
		}
		return templates;
	}

	private extractPatterns(task: TaskDescription, result: TaskResult): string[] {
		const patterns: string[] = [];
		for (const keyword of task.keywords.slice(0, 5)) {
			patterns.push(`*${keyword}*`);
		}
		for (const pattern of result.patterns.slice(0, 3)) {
			patterns.push(pattern);
		}
		return patterns;
	}
}
