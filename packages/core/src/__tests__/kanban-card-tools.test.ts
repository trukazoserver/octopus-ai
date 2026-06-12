import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequirementResolver } from "../agent/requirement-resolver.js";
import { WorkflowManager } from "../agent/workflow-manager.js";
import {
	type DatabaseAdapter,
	createDatabaseAdapter,
} from "../storage/database.js";
import { createKanbanCardTools } from "../tools/kanban-cards.js";

describe("createKanbanCardTools", () => {
	let db: DatabaseAdapter;
	let workflowManager: WorkflowManager;
	let resolver: RequirementResolver;

	beforeEach(async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		workflowManager = new WorkflowManager(db);
		resolver = new RequirementResolver(workflowManager);
	});

	afterEach(async () => {
		await db.close();
	});

	function getTool(name: string) {
		const tool = createKanbanCardTools(workflowManager, resolver).find(
			(item) => item.name === name,
		);
		if (!tool) throw new Error(`Missing tool ${name}`);
		return tool;
	}

	it("creates a card with dependencies, artifacts, arm assignment, and model", async () => {
		const run = await workflowManager.createRun({ goal: "ship feature" });
		const evaluateSpy = vi.spyOn(resolver, "evaluatePendingRequirements");

		const result = await getTool("kanban_create").handler(
			{
				run_id: run.id,
				title: "Build implementation",
				description: "Implement the feature",
				arm_key: "ari",
				priority: 2,
				acceptance_criteria: ["Tests pass"],
				produces: [{ artifactKey: "implementation", artifactType: "code" }],
				requires: [
					{
						type: "artifact",
						artifactKey: "spec",
						artifactType: "document",
					},
				],
				model: "cheap-model",
			},
			{} as never,
		);

		expect(result.success).toBe(true);
		const task = await workflowManager.getTask(result.metadata?.taskId as string);
		expect(task?.status).toBe("waiting_dependency");
		expect(task?.arm_key).toBe("ari");
		expect(task?.priority).toBe(2);
		expect(task?.model).toBe("cheap-model");
		expect(JSON.parse(task?.produces ?? "[]")).toEqual([
			{ artifactKey: "implementation", artifactType: "code" },
		]);
		expect(evaluateSpy).toHaveBeenCalledWith({ runId: run.id });
	});

	it("completes a card and completes the run when all cards are terminal", async () => {
		const run = await workflowManager.createRun({ goal: "finish" });
		const task = await workflowManager.createTask({ runId: run.id, title: "Done" });

		const result = await getTool("kanban_complete").handler(
			{ task_id: task.id, summary: "Finished cleanly" },
			{} as never,
		);

		expect(result.success).toBe(true);
		expect(result.metadata?.runCompleted).toBe(true);
		expect((await workflowManager.getTask(task.id))?.status).toBe("done");
		expect((await workflowManager.getRun(run.id))?.status).toBe("done");
	});

	it("links two cards and moves the target back to waiting_dependency", async () => {
		const run = await workflowManager.createRun({ goal: "link" });
		const source = await workflowManager.createTask({ runId: run.id, title: "Source" });
		const target = await workflowManager.createTask({ runId: run.id, title: "Target" });

		const result = await getTool("kanban_link").handler(
			{
				run_id: run.id,
				from_task_id: source.id,
				to_task_id: target.id,
			},
			{} as never,
		);

		expect(result.success).toBe(true);
		expect(result.metadata?.requirementType).toBe("task_status");
		expect((await workflowManager.getTask(target.id))?.status).toBe(
			"waiting_dependency",
		);
		const snapshot = await workflowManager.getRunSnapshot(run.id);
		expect(snapshot.requirements).toHaveLength(1);
		expect(snapshot.requirements[0]?.required_task_id).toBe(source.id);
		expect(snapshot.requirements[0]?.required_status).toBe("done");
	});

	it("shows a board grouped by status", async () => {
		const run = await workflowManager.createRun({ goal: "show board" });
		await workflowManager.createTask({ runId: run.id, title: "Ready card" });
		await workflowManager.createTask({
			runId: run.id,
			title: "Waiting card",
			status: "waiting_dependency",
		});

		const result = await getTool("kanban_show").handler(
			{ run_id: run.id },
			{} as never,
		);

		expect(result.success).toBe(true);
		const board = result.metadata?.board as {
			columns: Record<string, unknown[]>;
		};
		expect(board.columns.ready).toHaveLength(1);
		expect(board.columns.waiting_dependency).toHaveLength(1);
	});
});
