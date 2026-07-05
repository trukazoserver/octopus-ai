import { describe, expect, it, vi } from "vitest";
import type { KanbanPlanner } from "../agent/kanban-planner.js";
import {
	OctopusOrchestrator,
	type OrchestratorConfig,
} from "../agent/orchestrator.js";
import type { LLMRequest } from "../ai/types.js";
import { ToolExecutor } from "../tools/executor.js";
import { ToolRegistry } from "../tools/registry.js";

function createOrchestrator(
	chat = vi.fn(),
	config: Partial<OrchestratorConfig> = {},
) {
	const registry = new ToolRegistry();
	const executor = new ToolExecutor(registry, {
		sandboxCommands: false,
		allowedPaths: [],
	});
	return new OctopusOrchestrator(
		{ chat } as never,
		registry,
		executor,
		{
			id: "test-agent",
			name: "Test Agent",
			description: "test",
			systemPrompt: "test",
			model: "test-model",
		},
		{ maxWorkers: 3, ...config },
	);
}

// A goal that is genuinely parallelizable but has NO explicit multi-agent keyword,
// so it only reaches the LLM assessment tier.
const UNCERTAIN_PARALLELIZABLE =
	"Investiga por separado tres alternativas de coches electricos y comparalas en una tabla detallada con sus ventajas e inconvenientes.";

describe("OctopusOrchestrator dynamic assessment (Pillar 1)", () => {
	describe("Tier 1 — OBVIOUS-NO (regex, no LLM)", () => {
		it("short-circuits greetings without calling the LLM", async () => {
			const chat = vi.fn();
			const orchestrator = createOrchestrator(chat);
			const result = await orchestrator.assessParallelism("hola");
			expect(result.decompose).toBe(false);
			expect(result.source).toBe("regex-no");
			expect(chat).not.toHaveBeenCalled();
		});

		it("short-circuits single factual questions without calling the LLM", async () => {
			const chat = vi.fn();
			const orchestrator = createOrchestrator(chat);
			const result = await orchestrator.assessParallelism(
				"¿qué es la fotosíntesis?",
			);
			expect(result.decompose).toBe(false);
			expect(result.source).toBe("regex-no");
			expect(chat).not.toHaveBeenCalled();
		});

		it("short-circuits short translations without calling the LLM", async () => {
			const chat = vi.fn();
			const orchestrator = createOrchestrator(chat);
			const result = await orchestrator.assessParallelism(
				"traduce al ingles: hola mundo",
			);
			expect(result.decompose).toBe(false);
			expect(result.source).toBe("regex-no");
			expect(chat).not.toHaveBeenCalled();
		});
	});

	describe("Tier 2 — OBVIOUS-YES (explicit regex, no LLM)", () => {
		it("decomposes explicit worker requests without calling the LLM", async () => {
			const chat = vi.fn();
			const orchestrator = createOrchestrator(chat);
			const result = await orchestrator.assessParallelism(
				"usa exactamente 2 workers internos para analizar riesgos y QA",
			);
			expect(result.decompose).toBe(true);
			expect(result.source).toBe("regex-yes");
			expect(chat).not.toHaveBeenCalled();
		});
	});

	describe("Tier 3 — LLM assessment (OPT-IN, uncertain middle)", () => {
		it("returns llm-yes when the model says parallelize", async () => {
			const chat = vi.fn(async () => ({
				content:
					'{"parallelize": true, "reason": "3 investigaciones independientes"}',
			}));
			const orchestrator = createOrchestrator(chat, {
				enableDynamicAssessment: true,
			});
			const result = await orchestrator.assessParallelism(
				UNCERTAIN_PARALLELIZABLE,
			);
			expect(result.decompose).toBe(true);
			expect(result.source).toBe("llm-yes");
			const request = chat.mock.calls[0]?.[0] as LLMRequest;
			expect(request.maxTokens).toBe(120);
			expect(request.temperature).toBe(0);
		});

		it("returns llm-no when the model says single-agent", async () => {
			const chat = vi.fn(async () => ({
				content: '{"parallelize": false, "reason": "tarea coherente"}',
			}));
			const orchestrator = createOrchestrator(chat, {
				enableDynamicAssessment: true,
			});
			const result = await orchestrator.assessParallelism(
				UNCERTAIN_PARALLELIZABLE,
			);
			expect(result.decompose).toBe(false);
			expect(result.source).toBe("llm-no");
		});

		it("falls back to llm-no on malformed model output", async () => {
			const chat = vi.fn(async () => ({ content: "no soy json" }));
			const orchestrator = createOrchestrator(chat, {
				enableDynamicAssessment: true,
			});
			const result = await orchestrator.assessParallelism(
				UNCERTAIN_PARALLELIZABLE,
			);
			expect(result.decompose).toBe(false);
			expect(result.source).toBe("llm-no");
		});

		it("falls back to assessment-timeout (safe NO) when the LLM never resolves", async () => {
			const chat = vi.fn(() => new Promise<never>(() => undefined));
			const orchestrator = createOrchestrator(chat, {
				enableDynamicAssessment: true,
				assessmentTimeoutMs: 5,
			});
			const start = Date.now();
			const result = await orchestrator.assessParallelism(
				UNCERTAIN_PARALLELIZABLE,
			);
			expect(Date.now() - start).toBeLessThan(500);
			expect(result.decompose).toBe(false);
			expect(result.source).toBe("assessment-timeout");
		});

		it("uses the configured assessmentModel", async () => {
			const chat = vi.fn(async () => ({
				content: '{"parallelize": true, "reason": "x"}',
			}));
			const orchestrator = createOrchestrator(chat, {
				enableDynamicAssessment: true,
				assessmentModel: "glm-5-turbo",
			});
			await orchestrator.assessParallelism(UNCERTAIN_PARALLELIZABLE);
			const request = chat.mock.calls[0]?.[0] as LLMRequest;
			expect(request.model).toBe("glm-5-turbo");
		});
	});

	it("DEFAULT (peer pattern, no LLM) defers uncertain prompts to the main agent", async () => {
		// No enableDynamicAssessment set -> default OFF -> no gating LLM call.
		// The uncertain prompt is left for the main agent to handle (it decides
		// to delegate via delegate_task during its own turn). Model-independent.
		const chat = vi.fn();
		const orchestrator = createOrchestrator(chat);
		const result = await orchestrator.assessParallelism(
			UNCERTAIN_PARALLELIZABLE,
		);
		expect(result.decompose).toBe(false);
		expect(result.source).toBe("regex-no");
		expect(chat).not.toHaveBeenCalled();
	});
});

describe("OctopusOrchestrator robust decomposition (Pillar 2)", () => {
	function twoTaskPlanJson() {
		return JSON.stringify({
			complexity: 8,
			reasoning: "dos tareas independientes",
			executionPlan: "parallel",
			subtasks: [
				{
					id: "task_1",
					description: "Investigar opcion A",
					role: "researcher",
					toolScope: ["web_search"],
					priority: 1,
				},
				{
					id: "task_2",
					description: "Investigar opcion B",
					role: "researcher",
					toolScope: ["web_search"],
					priority: 2,
				},
			],
		});
	}

	it("falls back to legacy decompose when the Kanban planner times out", async () => {
		const chat = vi.fn(async () => ({ content: twoTaskPlanJson() }));
		const orchestrator = createOrchestrator(chat, {
			decompositionTimeoutMs: 20,
		});
		const hangingPlanner = {
			planFromGoal: () => new Promise(() => undefined),
		} as unknown as KanbanPlanner;
		orchestrator.setKanbanPlanner(hangingPlanner, undefined);

		const start = Date.now();
		const decomposition =
			await orchestrator.decomposeViaKanban("compara A y B");
		expect(Date.now() - start).toBeLessThan(1000);
		expect(decomposition.subtasks).toHaveLength(2);
		expect(decomposition.executionPlan).toBe("parallel");
	});

	it("falls back to legacy decompose when the Kanban planner rejects", async () => {
		const chat = vi.fn(async () => ({ content: twoTaskPlanJson() }));
		const orchestrator = createOrchestrator(chat, {
			decompositionTimeoutMs: 20,
		});
		const throwingPlanner = {
			planFromGoal: async () => {
				throw new Error("planner boom");
			},
		} as unknown as KanbanPlanner;
		orchestrator.setKanbanPlanner(throwingPlanner, undefined);

		const decomposition =
			await orchestrator.decomposeViaKanban("compara A y B");
		expect(decomposition.subtasks).toHaveLength(2);
	});

	it("returns a single-task fallback when BOTH planner and legacy decompose fail", async () => {
		// Legacy decompose never resolves -> its own withTimeout fires -> singleTaskFallback.
		const chat = vi.fn(() => new Promise<never>(() => undefined));
		const orchestrator = createOrchestrator(chat, {
			decompositionTimeoutMs: 20,
		});
		const throwingPlanner = {
			planFromGoal: async () => {
				throw new Error("planner boom");
			},
		} as unknown as KanbanPlanner;
		orchestrator.setKanbanPlanner(throwingPlanner, undefined);

		const start = Date.now();
		const decomposition =
			await orchestrator.decomposeViaKanban("compara A y B");
		expect(Date.now() - start).toBeLessThan(1000);
		expect(decomposition.subtasks).toHaveLength(0);
		expect(decomposition.executionPlan).toBe("sequential");
	});
});
