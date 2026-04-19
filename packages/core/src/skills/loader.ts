import type { TaskDescription } from "../agent/types.js";
import type { EmbeddingFunction } from "../memory/types.js";
import type { SkillRegistry } from "./registry.js";
import type { LoadedSkill, Skill, TaskNeeds } from "./types.js";

export class SkillLoader {
	private registry: SkillRegistry;
	private embedFn: EmbeddingFunction;
	private config: {
		maxTokenBudget: number;
		progressiveLevels: boolean;
		autoUnload: boolean;
		searchThreshold: number;
	};
	private loaded: Map<string, LoadedSkill> = new Map();

	constructor(
		registry: SkillRegistry,
		embedFn: EmbeddingFunction,
		config: {
			maxTokenBudget: number;
			progressiveLevels: boolean;
			autoUnload: boolean;
			searchThreshold: number;
		},
	) {
		this.registry = registry;
		this.embedFn = embedFn;
		this.config = config;
	}

	async resolveSkillsForTask(task: TaskDescription): Promise<LoadedSkill[]> {
		const taskNeeds = this.analyzeTaskNeeds(task);

		if (!taskNeeds.needsSkill) {
			return [];
		}

		const embedding = await this.embedFn(taskNeeds.description);
		taskNeeds.embedding = embedding;

		const matches = await this.registry.search(embedding, {
			threshold: this.config.searchThreshold,
			limit: 5,
		});

		if (matches.length === 0) {
			return [];
		}

		const budget = this.calculateBudget(this.config.maxTokenBudget);
		const loadedSkills: LoadedSkill[] = [];
		let usedTokens = 0;

		for (const match of matches) {
			if (usedTokens >= budget) break;

			const skill = match.skill;
			const level = this.config.progressiveLevels
				? this.determineLevel(skill, budget - usedTokens)
				: 4;

			const content = this.buildContent(skill, level, taskNeeds);
			const tokenEstimate = this.estimateTokens(content);

			if (usedTokens + tokenEstimate > budget && loadedSkills.length > 0) {
				break;
			}

			const loaded: LoadedSkill = { skill, content, level };
			loadedSkills.push(loaded);
			this.loaded.set(skill.id, loaded);
			usedTokens += tokenEstimate;
		}

		return loadedSkills;
	}

	unloadSkills(): void {
		this.loaded.clear();
	}

	private analyzeTaskNeeds(task: TaskDescription): TaskNeeds {
		const description = task.description.toLowerCase();
		const words = description.split(/\s+/);
		const stopWords = new Set([
			"a",
			"an",
			"the",
			"is",
			"are",
			"was",
			"were",
			"be",
			"been",
			"being",
			"have",
			"has",
			"had",
			"do",
			"does",
			"did",
			"will",
			"would",
			"could",
			"should",
			"may",
			"might",
			"can",
			"shall",
			"to",
			"of",
			"in",
			"for",
			"on",
			"with",
			"at",
			"by",
			"from",
			"as",
			"into",
			"through",
			"during",
			"before",
			"after",
			"above",
			"below",
			"between",
			"out",
			"off",
			"over",
			"under",
			"again",
			"further",
			"then",
			"once",
			"and",
			"but",
			"or",
			"nor",
			"not",
			"so",
			"yet",
			"both",
			"either",
			"neither",
			"each",
			"every",
			"all",
			"any",
			"few",
			"more",
			"most",
			"other",
			"some",
			"such",
			"no",
			"only",
			"own",
			"same",
			"than",
			"too",
			"very",
			"just",
			"because",
			"if",
			"when",
			"where",
			"how",
			"what",
			"which",
			"who",
			"whom",
			"this",
			"that",
			"these",
			"those",
			"i",
			"me",
			"my",
			"we",
			"our",
			"you",
			"your",
			"he",
			"him",
			"his",
			"she",
			"her",
			"it",
			"its",
			"they",
			"them",
			"their",
		]);
		const keywords = [
			...new Set(
				words
					.map((w) => w.replace(/[^a-z0-9]/g, ""))
					.filter((w) => w.length > 2 && !stopWords.has(w)),
			),
		];

		const complexity = Math.min(
			10,
			Math.ceil(
				words.length / 20 +
					keywords.length / 5 +
					(description.includes("complex") ? 2 : 0) +
					(description.includes("advanced") ? 2 : 0) +
					(description.includes("simple") ? -1 : 0),
			),
		);

		const domainKeywords: Record<string, string[]> = {
			code: [
				"code",
				"programming",
				"function",
				"class",
				"api",
				"debug",
				"refactor",
				"implement",
				"build",
				"deploy",
				"test",
			],
			data: [
				"data",
				"database",
				"query",
				"sql",
				"analytics",
				"transform",
				"etl",
				"migration",
			],
			writing: [
				"write",
				"document",
				"article",
				"blog",
				"content",
				"text",
				"edit",
				"proofread",
				"summarize",
			],
			research: [
				"research",
				"analyze",
				"investigate",
				"study",
				"compare",
				"evaluate",
				"review",
			],
			design: [
				"design",
				"ui",
				"ux",
				"interface",
				"layout",
				"prototype",
				"wireframe",
			],
			security: [
				"security",
				"auth",
				"encrypt",
				"vulnerability",
				"compliance",
				"audit",
			],
		};

		const domains: string[] = [];
		for (const [domain, domainWords] of Object.entries(domainKeywords)) {
			if (domainWords.some((dw) => keywords.some((k) => k.includes(dw)))) {
				domains.push(domain);
			}
		}

		const needsSkill =
			complexity >= 3 || keywords.length >= 3 || domains.length >= 1;

		return {
			domains,
			complexity,
			needsSkill,
			keywords: keywords.slice(0, 10),
			description: task.description,
			embedding: [],
		};
	}

	private calculateBudget(remainingContext: number): number {
		return Math.min(
			Math.floor(remainingContext * 0.1),
			this.config.maxTokenBudget,
		);
	}

	private determineLevel(skill: Skill, remainingBudget: number): 1 | 2 | 3 | 4 {
		const level1 = skill.contextEstimate.instructions;
		const level2 = level1 + skill.contextEstimate.perExample;
		const level3 = level2 + skill.contextEstimate.templates;
		const level4 =
			level3 + skill.examples.length * skill.contextEstimate.perExample;

		if (remainingBudget >= level4) return 4;
		if (remainingBudget >= level3) return 3;
		if (remainingBudget >= level2) return 2;
		return 1;
	}

	private buildContent(
		skill: Skill,
		level: 1 | 2 | 3 | 4,
		taskNeeds: TaskNeeds,
	): string {
		const parts: string[] = [];
		parts.push(`# ${skill.name}\n${skill.instructions}`);

		if (level >= 2) {
			const example = this.selectBestExample(skill, taskNeeds);
			if (example) {
				parts.push(`\n## Example\n${example}`);
			}
		}

		if (level >= 3 && skill.templates.length > 0) {
			parts.push(`\n## Templates\n${skill.templates.join("\n")}`);
		}

		if (level >= 4 && skill.examples.length > 1) {
			const remaining = skill.examples.slice(1);
			if (remaining.length > 0) {
				parts.push(`\n## Additional Examples\n${remaining.join("\n")}`);
			}
		}

		return parts.join("\n");
	}

	private selectBestExample(
		skill: Skill,
		_taskNeeds: TaskNeeds,
	): string | undefined {
		if (skill.examples.length === 0) return undefined;
		return skill.examples[0];
	}

	private estimateTokens(content: string): number {
		return Math.ceil(content.length / 4);
	}
}
