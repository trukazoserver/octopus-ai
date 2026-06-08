import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMRouter } from "../ai/router.js";
import type { LLMRequest } from "../ai/types.js";
import { OctopusOrchestrator } from "../agent/orchestrator.js";
import { WorkflowManager } from "../agent/workflow-manager.js";
import {
	type DatabaseAdapter,
	createDatabaseAdapter,
} from "../storage/database.js";
import { ToolExecutor } from "../tools/executor.js";
import { ToolRegistry } from "../tools/registry.js";

describe("workflow resume execution", () => {
	let db: DatabaseAdapter;
	let workflowManager: WorkflowManager;

	beforeEach(async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		workflowManager = new WorkflowManager(db);
	});

	afterEach(async () => {
		await db.close();
	});

	it("rehydrates persisted tasks and executes only unfinished work", async () => {
		const run = await workflowManager.createRun({
			goal: "finish durable workflow",
			metadata: { executionPlan: "mixed", reasoning: "test resume" },
		});
		const completed = await workflowManager.createTask({
			runId: run.id,
			title: "Research: completed",
			description: "already done",
			metadata: { sourceTaskId: "task_1", role: "researcher", toolScope: [] },
		});
		const pending = await workflowManager.createTask({
			runId: run.id,
			title: "Writer: pending",
			description: "write the final answer",
			dependsOn: ["task_1"],
			metadata: { sourceTaskId: "task_2", role: "writer", toolScope: [] },
		});
		await workflowManager.updateTaskStatus(completed.id, "done", {
			stepKey: "result",
			progressSignature: "done-signature",
		});
		await workflowManager.recordEvent({
			runId: run.id,
			taskId: completed.id,
			eventType: "result",
			message: "Stored result from completed dependency.",
		});
		await workflowManager.updateRunStatus(run.id, "interrupted");

		const chat = vi.fn(async (request: LLMRequest) => {
			const systemText = request.messages
				.map((message) => String(message.content))
				.join("\n");
			return {
				content: systemText.includes("sintetiza")
					? "Synthesized resumed result."
					: "Pending task completed after resume.",
			};
		});
		const llmRouter = { chat } as unknown as LLMRouter;
		const registry = new ToolRegistry();
		const executor = new ToolExecutor(registry, {
			sandboxCommands: false,
			allowedPaths: [],
		});
		const orchestrator = new OctopusOrchestrator(
			llmRouter,
			registry,
			executor,
			{
				id: "octopus-main",
				name: "Octopus",
				description: "test",
				systemPrompt: "test",
				model: "test-model",
			},
			{ maxWorkers: 2, workerConfig: { maxToolIterations: 2, timeoutMs: 5000 } },
			workflowManager,
		);

		const events = [];
		for await (const event of orchestrator.resumeWorkflowRun(run.id)) {
			events.push(event.type);
		}

		expect(events).toContain("worker_done");
		expect(events).toContain("synthesis");
		expect((await workflowManager.getRun(run.id))?.status).toBe("done");
		expect((await workflowManager.getTask(completed.id))?.status).toBe("done");
		expect((await workflowManager.getTask(pending.id))?.status).toBe("done");
		expect(chat).toHaveBeenCalledTimes(2);
	});
});
