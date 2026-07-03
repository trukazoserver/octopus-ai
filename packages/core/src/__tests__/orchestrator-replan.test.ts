import { describe, expect, it, vi } from "vitest";
import { KanbanPlanner } from "../agent/kanban-planner.js";
import { OctopusOrchestrator } from "../agent/orchestrator.js";
import { WorkflowManager } from "../agent/workflow-manager.js";
import type { LLMMessage, LLMRequest } from "../ai/types.js";
import {
	type DatabaseAdapter,
	createDatabaseAdapter,
} from "../storage/database.js";
import { ToolExecutor } from "../tools/executor.js";
import { ToolRegistry } from "../tools/registry.js";

/**
 * C1 auto re-plan: failing-swarm test harness.
 *
 * shouldDecompose is conservative, so we drive the KanbanPlanner directly via
 * decomposeViaKanban with a goal the planner decomposes. A single mocked router
 * branches on the system prompt to serve: (a) the initial plan, (b) the re-plan
 * alternatives, (c) worker results (one forced to fail), and (d) the synthesis.
 */

const PLANNER_MARKER = "Bibi, planner Kanban Swarm";
const SYNTHESIS_MARKER = "sintetiza resultados";

const FAILING_DESCRIPTION = "Generar el informe BETA sobre el tema dos";

const INITIAL_PLAN = {
	goal: "crea 2 informes",
	reasoning: "dos informes independientes",
	tasks: [
		{
			key: "informe_1",
			title: "Informe 1",
			description: "Generar el informe ALFA sobre el tema uno",
			armKey: "estelita",
			priority: 1,
			acceptanceCriteria: ["Entrega un informe valido"],
		},
		{
			key: "informe_2",
			title: "Informe 2",
			description: FAILING_DESCRIPTION,
			armKey: "estelita",
			priority: 2,
			acceptanceCriteria: ["Entrega un informe valido"],
		},
	],
};

const REPLAN_PLAN = {
	goal: "replan informe 2",
	reasoning: "alternativa mas simple",
	tasks: [
		{
			key: "informe_2_alt",
			title: "Informe 2 alternativo",
			description:
				"Reintentar el informe BETA con un enfoque mas simple y directo",
			armKey: "ari",
			priority: 1,
			acceptanceCriteria: ["Entrega un informe valido alternativo"],
		},
	],
};

function lastUserMessage(messages: LLMMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message && message.role === "user") {
			return typeof message.content === "string" ? message.content : "";
		}
	}
	return "";
}

function createReplanRouter() {
	const calls = {
		plannerInitial: 0,
		plannerReplan: 0,
		worker: 0,
		synthesis: 0,
	};
	const chat = vi.fn(async (request: LLMRequest) => {
		const system = String(request.messages[0]?.content ?? "");
		const user = lastUserMessage(request.messages);

		if (system.includes(PLANNER_MARKER)) {
			if (user.includes("Tarea original que fallo")) {
				calls.plannerReplan++;
				return {
					content: JSON.stringify(REPLAN_PLAN),
					model: "test",
					finishReason: "stop",
				};
			}
			calls.plannerInitial++;
			return {
				content: JSON.stringify(INITIAL_PLAN),
				model: "test",
				finishReason: "stop",
			};
		}

		if (system.includes(SYNTHESIS_MARKER)) {
			calls.synthesis++;
			return {
				content: "SINTESIS FINAL OK",
				model: "test",
				finishReason: "stop",
			};
		}

		// Worker call: the original failing task (exact description match) fails;
		// every other worker (incl. the replacement) succeeds.
		calls.worker++;
		if (user === FAILING_DESCRIPTION) {
			return {
				content: "Error en tarea: fallo simulado para forzar re-plan",
				model: "test",
				finishReason: "stop",
			};
		}
		return { content: "resultado ok", model: "test", finishReason: "stop" };
	});

	return { chat, calls };
}

async function setup(options: {
	orchestratorConfig?: Record<string, unknown>;
}) {
	const db: DatabaseAdapter = createDatabaseAdapter("sqlite", {
		path: ":memory:",
	});
	await db.initialize();
	const workflowManager = new WorkflowManager(db);
	const { chat, calls } = createReplanRouter();
	const planner = new KanbanPlanner(workflowManager, { chat } as never, {
		model: "test",
	});
	const registry = new ToolRegistry();
	const orchestrator = new OctopusOrchestrator(
		{ chat } as never,
		registry,
		new ToolExecutor(registry, { sandboxCommands: false, allowedPaths: [] }),
		{
			id: "root-agent",
			name: "Root",
			description: "test",
			systemPrompt: "test",
			model: "test",
		},
		{
			maxWorkers: 2,
			workerConfig: { maxToolIterations: 1, timeoutMs: 5000 },
			...options.orchestratorConfig,
		},
		workflowManager,
	);
	orchestrator.setKanbanPlanner(planner, undefined);
	return { db, workflowManager, orchestrator, calls, chat };
}

async function runToCompletion(
	orchestrator: OctopusOrchestrator,
	goal: string,
) {
	const decomposition = await orchestrator.decomposeViaKanban(goal);
	const events: { type: string; data?: unknown; result?: string }[] = [];
	for await (const event of orchestrator.executeParallel(decomposition)) {
		events.push(
			event as unknown as { type: string; data?: unknown; result?: string },
		);
	}
	const runId = decomposition.kanbanPlanRunId as string;
	return { runId, events };
}

describe("OctopusOrchestrator C1 auto re-plan", () => {
	it("re-plans a failed task into a replacement that succeeds and recovers the run", async () => {
		const { db, workflowManager, orchestrator, calls } = await setup({});
		try {
			const { runId, events } = await runToCompletion(
				orchestrator,
				"crea 2 informes",
			);

			const snapshot = await workflowManager.getRunSnapshot(runId);

			// 1 replacement was created in the SAME run.
			expect(snapshot.tasks).toHaveLength(3);
			const replacement = snapshot.tasks.find((task) =>
				task.metadata?.includes('"replanOf"'),
			);
			expect(replacement).toBeDefined();
			expect(replacement?.parent_task_id).not.toBeNull();

			// The run recovered: the replacement succeeded -> run is "done".
			expect(snapshot.run?.status).toBe("done");
			expect(replacement?.status).toBe("done");

			// A replan event was emitted for transparency.
			const replanEvent = events.find((event) => event.type === "replan");
			expect(replanEvent).toBeDefined();

			// Synthesis reflects the recovered outcome.
			const synthesis = events.find((event) => event.type === "synthesis");
			expect(synthesis?.result).toBe("SINTESIS FINAL OK");

			// The planner was consulted once for the initial plan and once for the
			// re-plan; the failing task plus its replacement ran (3 worker calls).
			expect(calls.plannerInitial).toBe(1);
			expect(calls.plannerReplan).toBe(1);
			expect(calls.worker).toBe(3);
		} finally {
			await db.close();
		}
	});

	it("does not re-plan when enableAutoReplan is false", async () => {
		const { db, workflowManager, orchestrator, calls } = await setup({
			orchestratorConfig: { enableAutoReplan: false },
		});
		try {
			const { runId, events } = await runToCompletion(
				orchestrator,
				"crea 2 informes",
			);

			const snapshot = await workflowManager.getRunSnapshot(runId);

			// No replacement created; the failed task leaves the run partial.
			expect(snapshot.tasks).toHaveLength(2);
			expect(snapshot.run?.status).toBe("partial");
			expect(events.some((event) => event.type === "replan")).toBe(false);

			// Only the initial plan was produced; no re-plan consultation.
			expect(calls.plannerInitial).toBe(1);
			expect(calls.plannerReplan).toBe(0);
		} finally {
			await db.close();
		}
	});

	it("stops re-planning when the planner returns no alternatives", async () => {
		const db: DatabaseAdapter = createDatabaseAdapter("sqlite", {
			path: ":memory:",
		});
		await db.initialize();
		const workflowManager = new WorkflowManager(db);

		// Planner returns an empty alternative set -> no replacement -> no 2nd pass.
		const emptyReplanChat = vi.fn(async (request: LLMRequest) => {
			const system = String(request.messages[0]?.content ?? "");
			const user = lastUserMessage(request.messages);
			if (system.includes(PLANNER_MARKER)) {
				return {
					content: user.includes("Tarea original que fallo")
						? JSON.stringify({ goal: "replan", reasoning: "none", tasks: [] })
						: JSON.stringify(INITIAL_PLAN),
					model: "test",
					finishReason: "stop",
				};
			}
			if (system.includes(SYNTHESIS_MARKER)) {
				return { content: "SINTESIS", model: "test", finishReason: "stop" };
			}
			return {
				content:
					lastUserMessage(request.messages) === FAILING_DESCRIPTION
						? "Error en tarea: fallo simulado"
						: "resultado ok",
				model: "test",
				finishReason: "stop",
			};
		});
		const planner = new KanbanPlanner(
			workflowManager,
			{ chat: emptyReplanChat } as never,
			{ model: "test" },
		);
		const registry = new ToolRegistry();
		const orchestrator = new OctopusOrchestrator(
			{ chat: emptyReplanChat } as never,
			registry,
			new ToolExecutor(registry, { sandboxCommands: false, allowedPaths: [] }),
			{
				id: "root-agent",
				name: "Root",
				description: "test",
				systemPrompt: "test",
				model: "test",
			},
			{
				maxWorkers: 2,
				workerConfig: { maxToolIterations: 1, timeoutMs: 5000 },
			},
			workflowManager,
		);
		orchestrator.setKanbanPlanner(planner, undefined);

		try {
			const decomposition =
				await orchestrator.decomposeViaKanban("crea 2 informes");
			const events: { type: string }[] = [];
			for await (const event of orchestrator.executeParallel(decomposition)) {
				events.push(event as unknown as { type: string });
			}
			const snapshot = await workflowManager.getRunSnapshot(
				decomposition.kanbanPlanRunId as string,
			);

			// No replacement could be created -> run stays partial with the 2 originals.
			expect(snapshot.tasks).toHaveLength(2);
			expect(snapshot.run?.status).toBe("partial");
			expect(events.some((event) => event.type === "replan")).toBe(false);
		} finally {
			await db.close();
		}
	});
});
