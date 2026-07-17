import { describe, expect, it } from "vitest";
import {
	evaluateMemoryConditions,
	type MemoryEvaluationCase,
} from "../memory/evaluation.js";

describe("causal memory evaluation harness", () => {
	it("compares no-memory, naive RAG, and Octopus conditions", async () => {
		const cases: MemoryEvaluationCase[] = [
			{
				id: "current-preference",
				query: "What is the current response preference?",
				expectedIds: ["preference-current"],
				forbiddenIds: ["preference-stale"],
			},
			{
				id: "graph-support",
				query: "What evidence supports deployment policy?",
				expectedIds: ["deployment-policy", "deployment-evidence"],
			},
		];
		const results = await evaluateMemoryConditions(cases, [
			{ name: "no-memory", retrieve: async () => [] },
			{
				name: "naive-rag",
				retrieve: async (testCase) =>
					testCase.id === "current-preference"
						? ["preference-stale"]
						: ["deployment-policy", "unrelated-result"],
			},
			{
				name: "octopus",
				retrieve: async (testCase) => [...testCase.expectedIds],
			},
		]);
		const noMemory = results.find((result) => result.name === "no-memory");
		const naive = results.find((result) => result.name === "naive-rag");
		const octopus = results.find((result) => result.name === "octopus");
		expect(octopus?.recall).toBe(1);
		expect(octopus?.precision).toBe(1);
		expect(octopus?.staleRetrievalRate).toBe(0);
		expect(octopus?.hitRate).toBe(1);
		expect(octopus?.mrr).toBe(1);
		expect(octopus?.forbiddenRetrievalRate).toBe(0);
		expect(octopus?.recall).toBeGreaterThan(noMemory?.recall ?? 0);
		expect(octopus?.precision).toBeGreaterThan(naive?.precision ?? 0);
		expect(naive?.staleRetrievalRate).toBeGreaterThan(0);
	});
});
