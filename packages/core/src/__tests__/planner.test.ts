import { describe, expect, it, vi } from "vitest";
import { TaskPlanner } from "../agent/planner.js";
import type { PlanStep } from "../agent/planner.js";

function createMockLLMRouter(responseContent: string) {
	return {
		chat: vi.fn().mockResolvedValue({
			content: responseContent,
			model: "test",
			usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			finishReason: "stop",
		}),
		getAvailableProviders: vi.fn().mockReturnValue(["test-provider"]),
	};
}

function createNoProvidersRouter() {
	return {
		chat: vi.fn(),
		getAvailableProviders: vi.fn().mockReturnValue([]),
	};
}

describe("TaskPlanner", () => {
	describe("constructor", () => {
		it("should instantiate with an LLM router", () => {
			const router = createMockLLMRouter('["Step 1"]');
			const planner = new TaskPlanner(
				router as unknown as Parameters<typeof TaskPlanner>[0],
			);
			expect(planner).toBeInstanceOf(TaskPlanner);
		});
	});

	describe("plan", () => {
		it("should return a plan with steps, complexity, and needsApproval", async () => {
			const router = createMockLLMRouter(
				'["Read the file", "Analyze the content", "Generate a summary"]',
			);
			const planner = new TaskPlanner(
				router as unknown as Parameters<typeof TaskPlanner>[0],
			);
			const result = await planner.plan("Summarize a document");

			expect(result).toHaveProperty("steps");
			expect(result).toHaveProperty("complexity");
			expect(result).toHaveProperty("needsApproval");
			expect(Array.isArray(result.steps)).toBe(true);
			expect(typeof result.complexity).toBe("number");
			expect(typeof result.needsApproval).toBe("boolean");
		});

		it("should parse JSON array response from LLM into steps", async () => {
			const router = createMockLLMRouter('["Step A", "Step B", "Step C"]');
			const planner = new TaskPlanner(
				router as unknown as Parameters<typeof TaskPlanner>[0],
			);
			const result = await planner.plan("Do a multi-step task");

			expect(result.steps).toHaveLength(3);
			expect(result.steps[0]?.description).toBe("Step A");
			expect(result.steps[1]?.description).toBe("Step B");
			expect(result.steps[2]?.description).toBe("Step C");
		});

		it("should assign pending status to all steps", async () => {
			const router = createMockLLMRouter('["First", "Second"]');
			const planner = new TaskPlanner(
				router as unknown as Parameters<typeof TaskPlanner>[0],
			);
			const result = await planner.plan("A task");

			for (const step of result.steps) {
				expect(step.status).toBe("pending");
			}
		});

		it("should set up sequential dependencies between steps", async () => {
			const router = createMockLLMRouter('["Step 1", "Step 2", "Step 3"]');
			const planner = new TaskPlanner(
				router as unknown as Parameters<typeof TaskPlanner>[0],
			);
			const result = await planner.plan("Sequential task");

			expect(result.steps[0]?.dependencies).toHaveLength(0);
			expect(result.steps[1]?.dependencies).toHaveLength(1);
			expect(result.steps[1]?.dependencies[0]).toBe(result.steps[0]?.id);
			expect(result.steps[2]?.dependencies[0]).toBe(result.steps[1]?.id);
		});

		it("should assign unique IDs to each step", async () => {
			const router = createMockLLMRouter('["Step A", "Step B"]');
			const planner = new TaskPlanner(
				router as unknown as Parameters<typeof TaskPlanner>[0],
			);
			const result = await planner.plan("A task");

			const ids = result.steps.map((s) => s.id);
			const uniqueIds = new Set(ids);
			expect(uniqueIds.size).toBe(ids.length);
		});

		it("should fall back to regex parsing when no LLM providers available", async () => {
			const router = createNoProvidersRouter();
			const planner = new TaskPlanner(
				router as unknown as Parameters<typeof TaskPlanner>[0],
			);

			const result = await planner.plan(
				"Read the file then analyze the data then generate a report",
			);
			expect(result.steps.length).toBeGreaterThanOrEqual(2);
			expect(result.steps[0]?.status).toBe("pending");
		});

		it("should fall back when LLM chat throws an error", async () => {
			const router = {
				chat: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
				getAvailableProviders: vi.fn().mockReturnValue(["test"]),
			};
			const planner = new TaskPlanner(
				router as unknown as Parameters<typeof TaskPlanner>[0],
			);

			const result = await planner.plan("First do X then do Y");
			expect(result.steps.length).toBeGreaterThanOrEqual(2);
		});

		it("should compute complexity based on step count and description length", async () => {
			const router = createMockLLMRouter(
				'["Step 1", "Step 2", "Step 3", "Step 4", "Step 5"]',
			);
			const planner = new TaskPlanner(
				router as unknown as Parameters<typeof TaskPlanner>[0],
			);

			const longDesc = "A".repeat(300);
			const result = await planner.plan(longDesc);
			expect(result.complexity).toBeGreaterThan(0);
			expect(result.complexity).toBeLessThanOrEqual(1);
		});

		it("should require approval for high complexity plans", async () => {
			const router = createMockLLMRouter(
				'["Step 1", "Step 2", "Step 3", "Step 4", "Step 5"]',
			);
			const planner = new TaskPlanner(
				router as unknown as Parameters<typeof TaskPlanner>[0],
			);

			const longDesc = "A".repeat(500);
			const result = await planner.plan(longDesc);
			expect(result.needsApproval).toBe(true);
		});

		it("should not require approval for low complexity plans", async () => {
			const router = createMockLLMRouter('["Single step"]');
			const planner = new TaskPlanner(
				router as unknown as Parameters<typeof TaskPlanner>[0],
			);

			const result = await planner.plan("Simple task");
			expect(result.needsApproval).toBe(false);
		});

		it("should handle LLM response with extra text around JSON", async () => {
			const router = createMockLLMRouter(
				'Here are the steps:\n["First", "Second", "Third"]\nDone!',
			);
			const planner = new TaskPlanner(
				router as unknown as Parameters<typeof TaskPlanner>[0],
			);

			const result = await planner.plan("Multi-step task");
			expect(result.steps).toHaveLength(3);
		});
	});

	describe("refinePlan", () => {
		it("should refine steps using LLM when available", async () => {
			const router = createMockLLMRouter(
				'["Refined Step A", "Refined Step B"]',
			);
			const planner = new TaskPlanner(
				router as unknown as Parameters<typeof TaskPlanner>[0],
			);

			const existingSteps: PlanStep[] = [
				{
					id: "s1",
					description: "Step A",
					status: "completed",
					dependencies: [],
				},
				{
					id: "s2",
					description: "Step B",
					status: "pending",
					dependencies: ["s1"],
				},
			];

			const refined = await planner.refinePlan(
				existingSteps,
				"Make step B more detailed",
			);
			expect(refined).toHaveLength(2);
			expect(refined[0]?.description).toBe("Refined Step A");
			expect(refined[1]?.description).toBe("Refined Step B");
			for (const step of refined) {
				expect(step.status).toBe("pending");
			}
		});

		it("should fall back to keyword-based refinement when no providers", async () => {
			const router = createNoProvidersRouter();
			const planner = new TaskPlanner(
				router as unknown as Parameters<typeof TaskPlanner>[0],
			);

			const existingSteps: PlanStep[] = [
				{
					id: "s1",
					description: "Deploy the application",
					status: "completed",
					dependencies: [],
				},
				{
					id: "s2",
					description: "Run tests for coverage",
					status: "pending",
					dependencies: ["s1"],
				},
			];

			const refined = await planner.refinePlan(
				existingSteps,
				"increase coverage threshold",
			);
			expect(refined).toHaveLength(2);
			const coverageStep = refined.find((s) =>
				s.description.includes("coverage"),
			);
			expect(coverageStep).toBeDefined();
			expect(coverageStep?.description).toContain("modified:");
		});

		it("should fall back when LLM throws during refinement", async () => {
			const router = {
				chat: vi.fn().mockRejectedValue(new Error("fail")),
				getAvailableProviders: vi.fn().mockReturnValue(["test"]),
			};
			const planner = new TaskPlanner(
				router as unknown as Parameters<typeof TaskPlanner>[0],
			);

			const existingSteps: PlanStep[] = [
				{
					id: "s1",
					description: "Build the project",
					status: "pending",
					dependencies: [],
				},
			];

			const refined = await planner.refinePlan(existingSteps, "build faster");
			expect(refined).toHaveLength(1);
			expect(refined[0]?.description).toContain("modified:");
		});

		it("should not modify completed steps in fallback refinement", async () => {
			const router = createNoProvidersRouter();
			const planner = new TaskPlanner(
				router as unknown as Parameters<typeof TaskPlanner>[0],
			);

			const existingSteps: PlanStep[] = [
				{
					id: "s1",
					description: "Setup environment",
					status: "completed",
					dependencies: [],
				},
				{
					id: "s2",
					description: "Install dependencies",
					status: "pending",
					dependencies: ["s1"],
				},
			];

			const refined = await planner.refinePlan(
				existingSteps,
				"environment setup",
			);
			const completedStep = refined.find(
				(s) => s.description === "Setup environment",
			);
			expect(completedStep).toBeDefined();
			expect(completedStep?.description).not.toContain("modified:");
		});
	});

	describe("fallback plan edge cases", () => {
		it("should split on 'then' delimiter", async () => {
			const router = createNoProvidersRouter();
			const planner = new TaskPlanner(
				router as unknown as Parameters<typeof TaskPlanner>[0],
			);

			const result = await planner.plan("Read the file then parse the data");
			expect(result.steps).toHaveLength(2);
		});

		it("should split on 'and then' delimiter", async () => {
			const router = createNoProvidersRouter();
			const planner = new TaskPlanner(
				router as unknown as Parameters<typeof TaskPlanner>[0],
			);

			const result = await planner.plan(
				"Install deps and then build the project",
			);
			expect(result.steps).toHaveLength(2);
		});

		it("should split on semicolons", async () => {
			const router = createNoProvidersRouter();
			const planner = new TaskPlanner(
				router as unknown as Parameters<typeof TaskPlanner>[0],
			);

			const result = await planner.plan("Step one; Step two; Step three");
			expect(result.steps).toHaveLength(3);
		});

		it("should split on newlines", async () => {
			const router = createNoProvidersRouter();
			const planner = new TaskPlanner(
				router as unknown as Parameters<typeof TaskPlanner>[0],
			);

			const result = await planner.plan("First task\nSecond task\nThird task");
			expect(result.steps).toHaveLength(3);
		});
	});
});
