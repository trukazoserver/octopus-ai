import { describe, expect, it, vi } from "vitest";
import { WorkflowScheduler } from "../agent/workflow-scheduler.js";
import type { WorkflowManager } from "../agent/workflow-manager.js";

const run = {
	id: "wf-1",
	conversation_id: null,
	root_agent_id: null,
	goal: "resume me",
	status: "ready" as const,
	current_phase: null,
	created_at: "2026-01-01T00:00:00.000Z",
	updated_at: "2026-01-01T00:00:00.000Z",
	completed_at: null,
	metadata: null,
	owner_id: "scheduler-test",
	lease_expires_at: "2026-01-01T00:02:00.000Z",
	last_heartbeat_at: "2026-01-01T00:00:00.000Z",
};

describe("WorkflowScheduler", () => {
	it("starts durable resume runs returned by the manager", async () => {
		const workflowManager = {
			listAutoResumableRuns: vi.fn(async () => [run]),
			claimRunForExecution: vi.fn(async () => run),
			heartbeatRunLease: vi.fn(async () => true),
		} as unknown as WorkflowManager;
		const resumeWorkflowRun = vi.fn(async function* () {
			yield { type: "telemetry" };
		});
		const scheduler = new WorkflowScheduler(workflowManager, {
			resumeWorkflowRun,
		}, { ownerId: "scheduler-test" });

		const result = await scheduler.tick();

		expect(result).toEqual({ claimed: 1, skipped: 0 });
		await vi.waitFor(() => {
			expect(resumeWorkflowRun).toHaveBeenCalledWith("wf-1", {}, { ownerId: "scheduler-test" });
		});
	});

	it("does not start the same run twice while it is active", async () => {
		let release: (() => void) | undefined;
		const workflowManager = {
			listAutoResumableRuns: vi.fn(async () => [run]),
			claimRunForExecution: vi.fn(async () => run),
			heartbeatRunLease: vi.fn(async () => true),
		} as unknown as WorkflowManager;
		const resumeWorkflowRun = vi.fn(async function* () {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		const scheduler = new WorkflowScheduler(workflowManager, {
			resumeWorkflowRun,
		}, { ownerId: "scheduler-test" });

		expect(await scheduler.tick()).toEqual({ claimed: 1, skipped: 0 });
		expect(await scheduler.tick()).toEqual({ claimed: 0, skipped: 1 });
		expect(resumeWorkflowRun).toHaveBeenCalledTimes(1);

		release?.();
	});
});
