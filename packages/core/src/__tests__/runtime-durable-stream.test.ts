import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../agent/runtime.js";
import { EventStream } from "../agent/event-stream.js";
import type { KanbanDispatcher } from "../agent/kanban-dispatcher.js";
import type { AgentConfig } from "../agent/types.js";

const baseConfig: AgentConfig = {
	id: "test-agent",
	name: "Test Agent",
	description: "A test agent",
	systemPrompt: "You are a helpful test assistant.",
};

/* Stubs mínimos para el constructor; streamDurableWorkflow no los usa. */
const stubRouter = {
	chat: vi.fn(),
	chatStream: vi.fn(async function* () {}),
	getAvailableProviders: vi.fn(() => []),
};
const stubSTM = {
	add: vi.fn(),
	getContext: vi.fn(() => []),
	getRelevant: vi.fn(() => []),
	getLoad: vi.fn(() => 0),
	getActiveTask: vi.fn(() => null),
	setActiveTask: vi.fn(),
	setScratchPad: vi.fn(),
	getScratchPad: vi.fn(),
	clear: vi.fn(),
	getTokenCount: vi.fn(() => 0),
};
const stubMemory = {
	retrieveForContext: vi
		.fn()
		.mockResolvedValue({ memories: [], totalTokens: 0, fromSTM: [], combined: [] }),
};
const stubConsolidator = {
	consolidate: vi
		.fn()
		.mockResolvedValue({ stored: 0, updated: 0, compressed: 0, forgotten: 0, associations: 0 }),
};
const stubSkillLoader = { resolveSkillsForTask: vi.fn().mockResolvedValue([]) };

function makeRuntime(): AgentRuntime {
	return new AgentRuntime(
		baseConfig,
		stubRouter as never,
		stubSTM as never,
		stubMemory as never,
		stubConsolidator as never,
		stubSkillLoader as never,
	);
}

async function drain(gen: AsyncGenerator<string>): Promise<string> {
	const out: string[] = [];
	for await (const chunk of gen) out.push(String(chunk));
	return out.join("");
}

describe("AgentRuntime durable workflow streaming", () => {
	it("streams workflow events live and stops when all tasks complete", async () => {
		const stream = new EventStream();
		const runId = "run-1";
		let tickCount = 0;
		const mockDispatcher = {
			tick: vi.fn(async () => {
				tickCount += 1;
				if (tickCount === 1) {
					stream.append({
						runId,
						taskId: "task-1",
						workerId: "w1",
						type: "task_claimed",
						data: { message: "Iniciando: Tarea A" },
					});
					stream.append({
						runId,
						taskId: "task-1",
						workerId: "w1",
						type: "result",
						data: { message: "Completada: Tarea A" },
					});
				}
				return {
					expiredLeases: 0,
					requirementsEvaluated: 0,
					requirementsSatisfied: 0,
					unlockedTasks: 0,
					claimed: tickCount === 1 ? 1 : 0,
					skipped: 0,
				};
			}),
			getStatus: vi.fn(() => ({
				enabled: true,
				ticking: false,
				activeTaskIds: [],
				activeCount: 0,
				availableSlots: 5,
				config: {
					limit: 10,
					leaseTtlMs: 60000,
					maxConcurrentTasks: 5,
					maxConcurrentPerArm: 2,
					defaultAgentId: "x",
				},
				lastTickAt: null,
				lastTickResult: null,
			})),
		} as unknown as KanbanDispatcher;

		const runtime = makeRuntime();
		runtime.setKanbanDispatcher(mockDispatcher);
		runtime.setDurableEventStream(stream);

		const output = await drain(
			(runtime as unknown as {
				streamDurableWorkflow: (
					runId: string,
					taskIds: string[],
					signal: AbortSignal | undefined,
				) => AsyncGenerator<string>;
			}).streamDurableWorkflow(runId, ["task-1"], undefined),
		);

		expect(output).toContain("🟢 Workflow run-1 en ejecución");
		expect(output).toContain("▶ Iniciando: Tarea A");
		expect(output).toContain("✅ Completada: Tarea A");
		expect(output).toContain("✅ Workflow run-1 completado");
	});

	it("is a no-op (no yields) when no dispatcher/event stream are wired", async () => {
		const runtime = makeRuntime(); // sin setKanbanDispatcher / setDurableEventStream
		const output = await drain(
			(runtime as unknown as {
				streamDurableWorkflow: (
					runId: string,
					taskIds: string[],
					signal: AbortSignal | undefined,
				) => AsyncGenerator<string>;
			}).streamDurableWorkflow("run-1", ["task-1"], undefined),
		);
		expect(output).toBe("");
	});
});
