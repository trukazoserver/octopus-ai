import { describe, expect, it, vi } from "vitest";
import { EventStream } from "../agent/event-stream.js";
import { WorkerPool } from "../agent/worker-pool.js";
import { ToolExecutor } from "../tools/executor.js";
import { ToolRegistry } from "../tools/registry.js";

/**
 * C1 — run-level aggregate iteration budget. The shared `maxIterationsPerRun`
 * caps the SUM of every worker's toolIterations in one executeAll run; when
 * drained, in-flight workers stop and the run is marked budget-exhausted.
 */
describe("WorkerPool run-level budget (C1)", () => {
	it("caps aggregate iterations across concurrent workers", async () => {
		// chat always returns a tool call → each worker would loop forever without
		// the per-arm/per-run caps.
		const chat = vi.fn(async () => ({
			content: "working",
			toolCalls: [
				{
					id: "call_1",
					type: "function" as const,
					function: { name: "read_file", arguments: "{}" },
				},
			],
		}));
		const registry = new ToolRegistry();
		registry.register({
			name: "read_file",
			description: "reads",
			parameters: {},
			handler: async () => ({ success: true, output: "ok" }),
		});
		const pool = new WorkerPool(
			{ chat } as never,
			registry,
			new ToolExecutor(registry, {
				sandboxCommands: false,
				allowedPaths: [],
			}),
			new EventStream(),
			{
				id: "agent-1",
				name: "Agent",
				description: "test",
				systemPrompt: "test",
				model: "test-model",
			},
			5, // maxConcurrent — let all 3 tasks run at once
		);

		const tasks = [1, 2, 3].map((n) => ({
			id: `task_${n}`,
			description: `Do work ${n}`,
			role: "qa",
			toolScope: [],
			priority: 1,
			status: "pending" as const,
		}));

		const results = await pool.executeAll(tasks, {
			maxToolIterations: 1000, // per-arm cap high; the RUN cap must bind
			timeoutMs: 10_000,
			maxIterationsPerRun: 4,
		});

		// The run budget is the binding constraint.
		expect(pool.getLastRunIterations()).toBeLessThanOrEqual(4);
		expect(pool.isRunBudgetExhausted()).toBe(true);
		// At least one worker stopped with the budget message.
		const budgeted = Array.from(results.values()).filter((r) =>
			/\[Budget\]/.test(r),
		);
		expect(budgeted.length).toBeGreaterThan(0);
	});

	it("does not trip the budget when maxIterationsPerRun is unset", async () => {
		const chat = vi.fn(async () => ({ content: "done", toolCalls: [] }));
		const registry = new ToolRegistry();
		const pool = new WorkerPool(
			{ chat } as never,
			registry,
			new ToolExecutor(registry, {
				sandboxCommands: false,
				allowedPaths: [],
			}),
			new EventStream(),
			{
				id: "agent-1",
				name: "Agent",
				description: "test",
				systemPrompt: "test",
				model: "test-model",
			},
			2,
		);

		await pool.executeAll(
			[
				{
					id: "task_1",
					description: "Do work",
					role: "qa",
					toolScope: [],
					priority: 1,
					status: "pending" as const,
				},
			],
			{ maxToolIterations: 1, timeoutMs: 10_000 },
		);
		expect(pool.isRunBudgetExhausted()).toBe(false);
	});
});
