import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowManager } from "../agent/workflow-manager.js";
import {
	type DatabaseAdapter,
	createDatabaseAdapter,
} from "../storage/database.js";

describe("WorkflowManager recovery", () => {
	let db: DatabaseAdapter;
	let manager: WorkflowManager;

	beforeEach(async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		manager = new WorkflowManager(db);
	});

	afterEach(async () => {
		await db.close();
	});

	it("marks stale running runs interrupted and returns running tasks to ready", async () => {
		const run = await manager.createRun({ goal: "stale workflow" });
		const task = await manager.createTask({ runId: run.id, title: "step" });
		await manager.updateRunStatus(run.id, "running");
		await manager.updateTaskStatus(task.id, "running");
		await db.run(
			"UPDATE agent_workflow_runs SET updated_at = ? WHERE id = ?",
			["2020-01-01T00:00:00.000Z", run.id],
		);

		const result = await manager.markStaleRunsInterrupted({ staleAfterMs: 1 });

		expect(result).toEqual({ runs: 1, tasks: 1 });
		expect((await manager.getRun(run.id))?.status).toBe("interrupted");
		expect((await manager.getTask(task.id))?.status).toBe("ready");
	});

	it("lists resumable runs and excludes terminal successful runs", async () => {
		const ready = await manager.createRun({ goal: "ready" });
		const done = await manager.createRun({ goal: "done" });
		await manager.updateRunStatus(done.id, "done");

		const resumable = await manager.listResumableRuns();

		expect(resumable.map((run) => run.id)).toContain(ready.id);
		expect(resumable.map((run) => run.id)).not.toContain(done.id);
	});

	it("claims only ready or interrupted runs for automatic execution", async () => {
		const ready = await manager.createRun({ goal: "ready" });
		const failed = await manager.createRun({ goal: "failed" });
		await manager.updateRunStatus(failed.id, "failed");

		const automatic = await manager.listAutoResumableRuns();
		const claimed = await manager.claimRunForExecution(ready.id);
		const failedClaim = await manager.claimRunForExecution(failed.id);

		expect(automatic.map((run) => run.id)).toContain(ready.id);
		expect(automatic.map((run) => run.id)).not.toContain(failed.id);
		expect(claimed?.status).toBe("running");
		expect(failedClaim).toBeNull();
	});

	it("atomically grants one leased owner for a resumable run", async () => {
		const run = await manager.createRun({ goal: "single owner" });
		const [first, second] = await Promise.all([
			manager.claimRunForExecution(run.id, { ownerId: "owner-a" }),
			manager.claimRunForExecution(run.id, { ownerId: "owner-b" }),
		]);

		const winner = first ?? second;
		expect([first, second].filter(Boolean)).toHaveLength(1);
		expect(winner?.owner_id).toMatch(/^owner-[ab]$/);
		expect(await manager.heartbeatRunLease(run.id, "not-owner")).toBe(false);
		expect(await manager.heartbeatRunLease(run.id, winner?.owner_id ?? "")).toBe(true);
	});

	it("retryRun preserves done tasks and resets failed tasks", async () => {
		const run = await manager.createRun({ goal: "retry workflow" });
		const done = await manager.createTask({ runId: run.id, title: "done" });
		const failed = await manager.createTask({ runId: run.id, title: "failed" });
		await manager.updateRunStatus(run.id, "failed");
		await manager.updateTaskStatus(done.id, "done");
		await manager.updateTaskStatus(failed.id, "failed");

		await manager.retryRun(run.id);

		expect((await manager.getRun(run.id))?.status).toBe("ready");
		expect((await manager.getTask(done.id))?.status).toBe("done");
		expect((await manager.getTask(failed.id))?.status).toBe("ready");
	});

	it("cancelRun marks non-terminal tasks cancelled", async () => {
		const run = await manager.createRun({ goal: "cancel workflow" });
		const task = await manager.createTask({ runId: run.id, title: "step" });
		await manager.updateRunStatus(run.id, "running");
		await manager.updateTaskStatus(task.id, "running");

		await manager.cancelRun(run.id, "stop");

		expect((await manager.getRun(run.id))?.status).toBe("cancelled");
		expect((await manager.getTask(task.id))?.status).toBe("cancelled");
	});
});
