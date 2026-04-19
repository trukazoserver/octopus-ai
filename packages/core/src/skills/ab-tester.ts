import type { SkillRegistry } from "./registry.js";
import type { ABTest } from "./types.js";

export class SkillABTester {
	private tests: Map<string, ABTest> = new Map();

	constructor(private registry: SkillRegistry) {}

	async createTest(
		skillId: string,
		versionA: string,
		versionB: string,
		sampleSize: number,
	): Promise<ABTest> {
		const testId = `ab_${skillId}_${Date.now()}`;
		const test: ABTest = {
			id: testId,
			skillId,
			versionA,
			versionB,
			startDate: new Date(),
			sampleSize,
			results: {
				a: { successes: 0, total: 0 },
				b: { successes: 0, total: 0 },
			},
			status: "running",
		};
		this.tests.set(testId, test);
		return test;
	}

	async recordResult(
		testId: string,
		version: string,
		success: boolean,
	): Promise<void> {
		const test = this.tests.get(testId);
		if (!test) throw new Error(`AB Test ${testId} not found`);

		if (version === test.versionA) {
			test.results.a.total++;
			if (success) test.results.a.successes++;
		} else if (version === test.versionB) {
			test.results.b.total++;
			if (success) test.results.b.successes++;
		}
	}

	async evaluateTest(
		testId: string,
	): Promise<{ winner?: string; confidence: number }> {
		const test = this.tests.get(testId);
		if (!test) throw new Error(`AB Test ${testId} not found`);

		const aTotal = test.results.a.total;
		const bTotal = test.results.b.total;

		if (aTotal + bTotal < 10) {
			return { confidence: 0 };
		}

		const aRate = aTotal > 0 ? test.results.a.successes / aTotal : 0;
		const bRate = bTotal > 0 ? test.results.b.successes / bTotal : 0;

		const difference = Math.abs(aRate - bRate);
		const confidence = Math.min(difference * 10, 1.0);

		let winner: string | undefined;
		if (
			difference > 0.1 &&
			aTotal >= Math.min(5, test.sampleSize / 2) &&
			bTotal >= Math.min(5, test.sampleSize / 2)
		) {
			winner = aRate > bRate ? test.versionA : test.versionB;
			test.status = "completed";
		}

		return { winner, confidence };
	}

	async getActiveTests(): Promise<ABTest[]> {
		return Array.from(this.tests.values()).filter(
			(t) => t.status === "running",
		);
	}
}
