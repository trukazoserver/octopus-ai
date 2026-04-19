import { nanoid } from "nanoid";
import type { EmbeddingFunction } from "../memory/types.js";
import type { SkillRegistry } from "./registry.js";
import type { ABTest, Skill, SkillUsage } from "./types.js";

export class SkillImprover {
	private registry: SkillRegistry;
	private embedFn: EmbeddingFunction;
	private config: {
		triggerOnSuccessRate: number;
		triggerOnRating: number;
		reviewEveryNUses: number;
		abTestMajorChanges: boolean;
		abTestSampleSize: number;
	};

	constructor(
		registry: SkillRegistry,
		embedFn: EmbeddingFunction,
		config: {
			triggerOnSuccessRate: number;
			triggerOnRating: number;
			reviewEveryNUses: number;
			abTestMajorChanges: boolean;
			abTestSampleSize: number;
		},
	) {
		this.registry = registry;
		this.embedFn = embedFn;
		this.config = config;
	}

	async improveSkill(skill: Skill, usageHistory: SkillUsage[]): Promise<Skill> {
		const failureAnalysis = this.analyzeFailures(usageHistory);

		const improved: Partial<Skill> = { ...skill };

		const improvedInstructions = this.generateImprovedInstructions(
			skill,
			failureAnalysis,
		);
		improved.instructions = improvedInstructions;

		if (failureAnalysis.suggestions.length > 0) {
			improved.instructions += `\n\n## Improvement Notes\n${failureAnalysis.suggestions.map((s) => `- ${s}`).join("\n")}`;
		}

		const isMajor = this.isMajorChange(skill, improved);

		if (isMajor && this.config.abTestMajorChanges) {
			const candidate: Skill = {
				...skill,
				...improved,
				id: nanoid(),
				version: this.bumpVersion(skill.version, "major"),
				instructions: improved.instructions ?? skill.instructions,
				metrics: {
					...skill.metrics,
					timesUsed: 0,
					successRate: 0,
					avgUserRating: 0,
					lastUsed: new Date().toISOString(),
					improvementsCount: skill.metrics.improvementsCount + 1,
				},
			};

			const embedding = await this.embedFn(
				`${candidate.name} ${candidate.description} ${candidate.instructions}`,
			);
			candidate.embedding = embedding;

			await this.registry.archiveVersion(skill);
			await this.registry.save(candidate);
			await this.scheduleABTest(skill, candidate);
			return candidate;
		}

		const versionType = isMajor ? "major" : "minor";
		const newVersion = this.bumpVersion(skill.version, versionType);

		await this.registry.archiveVersion(skill);

		const improvedSkill: Skill = {
			...skill,
			...improved,
			version: newVersion,
			metrics: {
				...skill.metrics,
				lastUsed: new Date().toISOString(),
				improvementsCount: skill.metrics.improvementsCount + 1,
			},
		};

		const embedding = await this.embedFn(
			`${improvedSkill.name} ${improvedSkill.description} ${improvedSkill.instructions}`,
		);
		improvedSkill.embedding = embedding;

		await this.registry.save(improvedSkill);
		return improvedSkill;
	}

	private analyzeFailures(history: SkillUsage[]): {
		patterns: string[];
		suggestions: string[];
	} {
		const failures = history.filter((h) => !h.success);
		const patterns: string[] = [];
		const suggestions: string[] = [];

		const failureReasons: Record<string, number> = {};
		for (const failure of failures) {
			const reason = failure.failureReason ?? "unknown";
			const normalized = reason.toLowerCase().trim();
			failureReasons[normalized] = (failureReasons[normalized] ?? 0) + 1;
		}

		const sortedReasons = Object.entries(failureReasons).sort(
			([, a], [, b]) => b - a,
		);

		for (const [reason, count] of sortedReasons.slice(0, 5)) {
			patterns.push(`${reason} (${count} occurrences)`);
			if (count >= 2) {
				suggestions.push(
					`Address recurring issue: "${reason}" - occurred ${count} times`,
				);
			}
		}

		const totalSuccesses = history.filter((h) => h.success).length;
		void totalSuccesses;
		const totalFailures = failures.length;
		const total = history.length;

		if (total > 0 && totalFailures / total > 0.5) {
			suggestions.push(
				"High failure rate detected - consider rewriting core instructions",
			);
		}

		const successReasons: string[] = [];
		for (const h of history) {
			if (h.success && h.successReason) {
				successReasons.push(h.successReason.toLowerCase().trim());
			}
		}

		if (successReasons.length > 0 && failures.length > 0) {
			suggestions.push(
				`Leverage successful patterns: ${successReasons.slice(0, 3).join(", ")}`,
			);
		}

		return { patterns, suggestions };
	}

	private isMajorChange(current: Skill, improved: Partial<Skill>): boolean {
		const currentInstructions = current.instructions;
		const improvedInstructions = improved.instructions ?? currentInstructions;

		const currentLines = new Set(
			currentInstructions.split("\n").filter((l) => l.trim().length > 0),
		);
		const improvedLines = improvedInstructions
			.split("\n")
			.filter((l) => l.trim().length > 0);

		let changedLines = 0;
		for (const line of improvedLines) {
			if (!currentLines.has(line)) {
				changedLines++;
			}
		}

		const totalLines = Math.max(currentLines.size, improvedLines.length);
		if (totalLines === 0) return false;

		const changeRatio = changedLines / totalLines;
		return changeRatio > 0.5;
	}

	private bumpVersion(
		version: string,
		type: "major" | "minor" | "patch",
	): string {
		const parts = version.split(".").map(Number);
		if (parts.length < 3 || parts.some(Number.isNaN)) return version;

		if (type === "major") {
			return `${parts[0] ?? 0 + 1}.0.0`;
		}
		if (type === "minor") {
			return `${parts[0] ?? 0}.${(parts[1] ?? 0) + 1}.0`;
		}
		return `${parts[0] ?? 0}.${parts[1] ?? 0}.${(parts[2] ?? 0) + 1}`;
	}

	async scheduleABTest(current: Skill, candidate: Skill): Promise<ABTest> {
		const abTest: ABTest = {
			id: nanoid(),
			skillId: current.id,
			versionA: current.version,
			versionB: candidate.version,
			startDate: new Date(),
			sampleSize: this.config.abTestSampleSize,
			results: {
				a: { successes: 0, total: 0 },
				b: { successes: 0, total: 0 },
			},
			status: "running",
		};

		await this.registry.db.run(
			`CREATE TABLE IF NOT EXISTS skill_ab_tests (
        id TEXT PRIMARY KEY,
        skillId TEXT NOT NULL,
        versionA TEXT NOT NULL,
        versionB TEXT NOT NULL,
        startDate TEXT NOT NULL,
        sampleSize INTEGER NOT NULL,
        results TEXT NOT NULL,
        status TEXT NOT NULL
      )`,
		);

		await this.registry.db.run(
			"INSERT INTO skill_ab_tests (id, skillId, versionA, versionB, startDate, sampleSize, results, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			[
				abTest.id,
				abTest.skillId,
				abTest.versionA,
				abTest.versionB,
				abTest.startDate.toISOString(),
				abTest.sampleSize,
				JSON.stringify(abTest.results),
				abTest.status,
			],
		);

		return abTest;
	}

	async checkABTests(): Promise<void> {
		const rows = await this.registry.db.all<Record<string, unknown>>(
			"SELECT * FROM skill_ab_tests WHERE status = 'running'",
		);

		for (const row of rows) {
			const results = JSON.parse(row.results as string) as ABTest["results"];
			const totalA = results.a.total;
			const totalB = results.b.total;
			const sampleSize = row.sampleSize as number;

			if (totalA + totalB < sampleSize) continue;

			const rateA = totalA > 0 ? results.a.successes / totalA : 0;
			const rateB = totalB > 0 ? results.b.successes / totalB : 0;

			const winnerVersion = rateB > rateA ? "b" : "a";
			const winnerId =
				winnerVersion === "b"
					? (row.versionB as string)
					: (row.versionA as string);
			const loserVersion = winnerVersion === "a" ? "b" : "a";

			const loserId =
				loserVersion === "a"
					? (row.versionA as string)
					: (row.versionB as string);

			await this.registry.db.run(
				"UPDATE skill_ab_tests SET status = 'completed' WHERE id = ?",
				[row.id],
			);

			const loserSkill = await this.registry.getById(loserId);
			if (loserSkill && loserVersion === "a") {
				await this.registry.delete(loserId);
			}

			const winnerSkill = await this.registry.getById(winnerId);
			if (winnerSkill && winnerVersion === "b") {
				const existing = await this.registry.getById(row.skillId as string);
				if (existing) {
					await this.registry.delete(row.skillId as string);
				}

				const promoted: Skill = {
					...winnerSkill,
					id: row.skillId as string,
				};
				await this.registry.save(promoted);
			}
		}
	}

	private generateImprovedInstructions(
		skill: Skill,
		failureAnalysis: { patterns: string[]; suggestions: string[] },
	): string {
		let instructions = skill.instructions;

		if (failureAnalysis.patterns.length > 0) {
			instructions += `\n\n## Known Failure Patterns\n${failureAnalysis.patterns.map((p) => `- ${p}`).join("\n")}`;
		}

		if (
			failureAnalysis.suggestions.some((s) => s.includes("High failure rate"))
		) {
			const lines = instructions.split("\n");
			const enhancedLines = lines.map((line) => {
				if (line.startsWith("## Approach")) {
					return `${line}\n\n**IMPORTANT**: Pay special attention to edge cases and validate inputs before proceeding.`;
				}
				return line;
			});
			instructions = enhancedLines.join("\n");
		}

		return instructions;
	}
}
