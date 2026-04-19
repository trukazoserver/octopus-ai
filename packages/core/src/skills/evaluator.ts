import type { SkillRegistry } from "./registry.js";
import type { Skill } from "./types.js";

export class SkillEvaluator {
	constructor(private _registry: SkillRegistry) {}

	evaluate(skill: Skill): {
		overallScore: number;
		breakdown: Skill["quality"];
		recommendations: string[];
	} {
		const completeness = this.scoreCompleteness(skill);
		const accuracy = this.scoreAccuracy(skill);
		const clarity = this.scoreClarity(skill);

		const breakdown: Skill["quality"] = {
			completeness,
			accuracy,
			clarity,
		};

		const overallScore = completeness * 0.35 + accuracy * 0.35 + clarity * 0.3;
		const recommendations = this.generateRecommendations(skill, breakdown);

		return {
			overallScore: Math.round(overallScore * 100) / 100,
			breakdown,
			recommendations,
		};
	}

	compareSkills(
		skillA: Skill,
		skillB: Skill,
	): {
		winner: "a" | "b" | "tie";
		scores: { a: number; b: number };
	} {
		const evalA = this.evaluate(skillA);
		const evalB = this.evaluate(skillB);

		const diff = evalA.overallScore - evalB.overallScore;
		const winner: "a" | "b" | "tie" =
			Math.abs(diff) < 0.05 ? "tie" : diff > 0 ? "a" : "b";

		return {
			winner,
			scores: { a: evalA.overallScore, b: evalB.overallScore },
		};
	}

	private scoreCompleteness(skill: Skill): number {
		let score = 0;

		const instructionsLength = skill.instructions.length;
		if (instructionsLength >= 500) score += 0.25;
		else if (instructionsLength >= 200) score += 0.15;
		else if (instructionsLength >= 50) score += 0.05;

		if (skill.examples.length >= 3) score += 0.25;
		else if (skill.examples.length >= 1) score += 0.15;

		if (skill.triggerConditions.keywords.length >= 5) score += 0.2;
		else if (skill.triggerConditions.keywords.length >= 2) score += 0.1;

		if (skill.triggerConditions.domains.length >= 2) score += 0.15;
		else if (skill.triggerConditions.domains.length >= 1) score += 0.08;

		if (skill.templates.length >= 2) score += 0.15;
		else if (skill.templates.length >= 1) score += 0.07;

		return Math.min(1, Math.round(score * 100) / 100);
	}

	private scoreAccuracy(skill: Skill): number {
		if (skill.metrics.timesUsed === 0) return 0.5;
		return Math.round(skill.metrics.successRate * 100) / 100;
	}

	private scoreClarity(skill: Skill): number {
		let score = 0;

		const sections = skill.instructions.split(/^## /m).length - 1;
		if (sections >= 4) score += 0.3;
		else if (sections >= 2) score += 0.2;
		else if (sections >= 1) score += 0.1;

		if (skill.examples.length > 0) score += 0.3;

		const avgLineLength =
			skill.instructions.length /
			Math.max(1, skill.instructions.split("\n").length);
		if (avgLineLength >= 20 && avgLineLength <= 120) score += 0.2;
		else if (avgLineLength > 0) score += 0.1;

		if (/^##\s/m.test(skill.instructions)) score += 0.2;

		return Math.min(1, Math.round(score * 100) / 100);
	}

	private generateRecommendations(
		skill: Skill,
		breakdown: Skill["quality"],
	): string[] {
		const recommendations: string[] = [];

		if (breakdown.completeness < 0.5) {
			if (skill.examples.length === 0) {
				recommendations.push("Add examples to improve completeness");
			}
			if (skill.instructions.length < 200) {
				recommendations.push(
					"Expand instructions with more detail for better coverage",
				);
			}
			if (skill.triggerConditions.keywords.length < 3) {
				recommendations.push(
					"Add more trigger keywords for better skill matching",
				);
			}
		}

		if (breakdown.accuracy < 0.7 && skill.metrics.timesUsed > 5) {
			recommendations.push(
				"Success rate is low, consider improvement via SkillImprover",
			);
		}

		if (breakdown.clarity < 0.5) {
			if (!/^##\s/m.test(skill.instructions)) {
				recommendations.push(
					"Add structured sections (## headings) to instructions",
				);
			}
			if (skill.examples.length === 0) {
				recommendations.push("Add at least one example to improve clarity");
			}
		}

		if (skill.tags.length < 3) {
			recommendations.push("Add more tags for better discoverability");
		}

		if (skill.templates.length === 0) {
			recommendations.push("Consider adding templates for common use cases");
		}

		if (skill.related.length === 0) {
			recommendations.push("Link related skills to build a knowledge graph");
		}

		return recommendations;
	}
}
