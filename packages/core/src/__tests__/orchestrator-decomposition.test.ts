import { describe, expect, it, vi } from "vitest";
import type { LLMRouter } from "../ai/router.js";
import {
	OctopusOrchestrator,
	type OrchestratorConfig,
} from "../agent/orchestrator.js";
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
		{ chat } as unknown as LLMRouter,
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

describe("OctopusOrchestrator decomposition", () => {
	it("detects explicit worker requests as multiagent work", async () => {
		const orchestrator = createOrchestrator();

		await expect(
			orchestrator.shouldDecompose(
				"Prueba corta: usa exactamente 2 workers internos para analizar riesgos y QA.",
			),
		).resolves.toBe(true);
	});

	it("uses deterministic subtasks for Worker 1 / Worker 2 prompts", async () => {
		const chat = vi.fn();
		const orchestrator = createOrchestrator(chat);

		const decomposition = await orchestrator.decompose(
			"Prueba corta multiagente interna: usa exactamente 2 workers. Worker 1: enumera 3 riesgos tecnicos de la orquestacion. Worker 2: enumera 3 checks de QA. Luego sintetiza en una respuesta breve.",
		);

		expect(chat).not.toHaveBeenCalled();
		expect(decomposition.executionPlan).toBe("parallel");
		expect(decomposition.subtasks).toHaveLength(2);
		expect(decomposition.subtasks[0]?.description).toContain(
			"riesgos tecnicos",
		);
		expect(decomposition.subtasks[1]?.description).toContain("checks de QA");
		expect(decomposition.subtasks[1]?.description).not.toContain("sintetiza");
		expect(decomposition.subtasks[0]).toMatchObject({
			agentId: expect.stringMatching(/^arm-/),
			agentName: expect.any(String),
			armKey: expect.any(String),
			avatar: expect.stringContaining("/mascotas/"),
			color: expect.stringMatching(/^#/),
		});
	});

	it("falls back quickly when synthesis does not finish", async () => {
		const chat = vi.fn(() => new Promise<never>(() => undefined));
		const orchestrator = createOrchestrator(chat, { synthesisTimeoutMs: 5 });

		const result = await orchestrator.synthesize(
			{
				originalGoal: "smoke",
				executionPlan: "parallel",
				reasoning: "test",
				subtasks: [
					{
						id: "task_1",
						description: "risk analysis",
						role: "qa",
						toolScope: [],
						priority: 1,
						status: "done",
					},
					{
						id: "task_2",
						description: "qa checks",
						role: "qa",
						toolScope: [],
						priority: 2,
						status: "done",
					},
				],
			},
			new Map([
				["task_1", "risk result"],
				["task_2", "qa result"],
			]),
		);

		expect(result).toContain("La sintesis automatica no termino correctamente");
		expect(result).toContain("risk result");
		expect(result).toContain("qa result");
	});
});
