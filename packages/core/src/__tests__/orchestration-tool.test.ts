import { describe, expect, it, vi } from "vitest";
import type { KanbanPlanner } from "../agent/kanban-planner.js";
import type {
	OctopusOrchestrator,
	OrchestratorEvent,
	TaskDecomposition,
} from "../agent/orchestrator.js";
import type { SubTask, WorkerConfig } from "../agent/worker-pool.js";
import { createOrchestrationTools } from "../tools/orchestration.js";
import type { ToolContext } from "../tools/registry.js";

function subtask(id: string): SubTask {
	return {
		id,
		description: `task ${id}`,
		role: "researcher",
		toolScope: [],
		priority: 1,
		status: "pending",
	};
}

function makeOrchestrator(options: {
	subtasks: SubTask[];
	events: OrchestratorEvent[];
	onExecute?: (dec: TaskDecomposition) => void;
}) {
	const buildDecomposition = (goal: string): TaskDecomposition => ({
		originalGoal: goal,
		subtasks: options.subtasks,
		executionPlan: "parallel",
		reasoning: "test decomposition",
	});
	return {
		decompose: vi.fn(async (goal: string) => buildDecomposition(goal)),
		decomposeViaKanban: vi.fn(async (goal: string) => buildDecomposition(goal)),
		executeParallel: async function* (
			dec: TaskDecomposition,
			_cfg: Partial<WorkerConfig>,
		): AsyncIterable<OrchestratorEvent> {
			options.onExecute?.(dec);
			for (const ev of options.events) yield ev;
		},
	} as unknown as OctopusOrchestrator;
}

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		media: { save: vi.fn() },
		agent: { channelId: "conv-1" },
		...overrides,
	} as ToolContext;
}

function getTool(orchestrator: OctopusOrchestrator) {
	const tools = createOrchestrationTools({
		orchestrator,
		kanbanPlanner: {} as KanbanPlanner,
		rootAgentId: "root",
	});
	const tool = tools[0];
	if (!tool) throw new Error("orchestrate_parallel tool not registered");
	return tool;
}

const THREE_EVENTS: OrchestratorEvent[] = [
	{
		type: "worker_started",
		workerId: "w1",
		taskId: "s1",
		description: "d",
	},
	{ type: "worker_done", workerId: "w1", taskId: "s1", result: "result" },
	{
		type: "telemetry",
		data: {
			runId: "r",
			totalMs: 1,
			executionMs: 1,
			synthesisMs: 1,
			workerCount: 1,
			succeeded: 1,
			failed: 0,
			cancelled: 0,
		},
	},
	{ type: "synthesis", result: "SINTESIS FINAL" },
];

describe("orchestrate_parallel tool", () => {
	it("returns the synthesis for a compound goal and forwards progress STATUS", async () => {
		const orchestrator = makeOrchestrator({
			subtasks: [subtask("s1"), subtask("s2"), subtask("s3")],
			events: THREE_EVENTS,
		});
		const tool = getTool(orchestrator);
		const onProgress = vi.fn();
		const result = await tool.handler(
			{ goal: "investiga X, define Y, redacta Z" },
			makeContext({ onProgress }),
		);
		expect(result.success).toBe(true);
		expect(result.output).toBe("SINTESIS FINAL");
		// 3 progress events emitted (worker_start, worker_done, telemetry);
		// synthesis produces no STATUS (captured as the result).
		expect(onProgress).toHaveBeenCalledTimes(3);
		expect(onProgress.mock.calls[0]?.[0]).toContain("STATUS:worker_start:");
		expect(onProgress.mock.calls[1]?.[0]).toContain("STATUS:worker_done:");
		expect(onProgress.mock.calls[2]?.[0]).toContain(
			"STATUS:orchestrating:telemetry:",
		);
	});

	it("rejects a non-compound goal (<=1 subtask) with 'omitida'", async () => {
		const orchestrator = makeOrchestrator({
			subtasks: [subtask("s1")],
			events: [],
		});
		const tool = getTool(orchestrator);
		const onProgress = vi.fn();
		const result = await tool.handler(
			{ goal: "una sola tarea simple" },
			makeContext({ onProgress }),
		);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/omitida/i);
		// Non-compound rejection happens before executeParallel runs, so no
		// progress events are forwarded.
		expect(onProgress).not.toHaveBeenCalled();
	});

	it("caps workers when max_workers is set", async () => {
		let received: TaskDecomposition | undefined;
		const orchestrator = makeOrchestrator({
			subtasks: [
				subtask("s1"),
				subtask("s2"),
				subtask("s3"),
				subtask("s4"),
				subtask("s5"),
			],
			events: THREE_EVENTS,
			onExecute: (dec) => {
				received = dec;
			},
		});
		const tool = getTool(orchestrator);
		await tool.handler(
			{ goal: "g", max_workers: 2 },
			makeContext({ onProgress: vi.fn() }),
		);
		expect(received?.subtasks).toHaveLength(2);
	});

	it("returns failure when no synthesis is produced", async () => {
		const orchestrator = makeOrchestrator({
			subtasks: [subtask("s1"), subtask("s2")],
			events: [
				{ type: "worker_error", workerId: "w1", taskId: "s1", error: "boom" },
			],
		});
		const tool = getTool(orchestrator);
		const result = await tool.handler({ goal: "g" }, makeContext());
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/no produjo una síntesis/i);
	});

	it("returns early when the abort signal is already aborted", async () => {
		const orchestrator = makeOrchestrator({
			subtasks: [subtask("s1"), subtask("s2")],
			events: THREE_EVENTS,
		});
		const tool = getTool(orchestrator);
		const ac = new AbortController();
		ac.abort();
		const result = await tool.handler(
			{ goal: "g" },
			makeContext({ agent: { channelId: "c", abortSignal: ac.signal } }),
		);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/cancelada/i);
	});
});
