import { nanoid } from "nanoid";
import type { WorkflowManager, WorkflowRunRecord } from "./workflow-manager.js";
import type { WorkerConfig } from "./worker-pool.js";

export interface WorkflowRunResumer {
	resumeWorkflowRun(
		workflowRunId: string,
		workerConfig?: Partial<WorkerConfig>,
		ownership?: { ownerId: string },
	): AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
}

export interface WorkflowSchedulerOptions {
	limit?: number;
	onError?: (error: unknown, run: WorkflowRunRecord) => void;
	ownerId?: string;
	leaseTtlMs?: number;
	heartbeatIntervalMs?: number;
}

export class WorkflowScheduler {
	private activeRunIds = new Set<string>();
	private ticking = false;
	private readonly ownerId: string;

	constructor(
		private workflowManager: WorkflowManager,
		private resumer: WorkflowRunResumer,
		private options: WorkflowSchedulerOptions = {},
	) {
		this.ownerId = options.ownerId ?? `scheduler_${nanoid()}`;
	}

	async tick(): Promise<{ claimed: number; skipped: number }> {
		if (this.ticking) return { claimed: 0, skipped: 0 };
		this.ticking = true;
		try {
			const runs = await this.workflowManager.listAutoResumableRuns({
				limit: this.options.limit ?? 3,
			});
			let claimed = 0;
			let skipped = 0;
			for (const run of runs) {
				if (this.activeRunIds.has(run.id)) {
					skipped++;
					continue;
				}
				const ownedRun = await this.workflowManager.claimRunForExecution(run.id, {
					ownerId: this.ownerId,
					leaseTtlMs: this.options.leaseTtlMs,
				});
				if (!ownedRun) {
					skipped++;
					continue;
				}
				this.activeRunIds.add(run.id);
				claimed++;
				void this.drainRun(ownedRun).finally(() => {
					this.activeRunIds.delete(run.id);
				});
			}
			return { claimed, skipped };
		} finally {
			this.ticking = false;
		}
	}

	private async drainRun(run: WorkflowRunRecord): Promise<void> {
		const heartbeat = setInterval(() => {
			void this.workflowManager.heartbeatRunLease(
				run.id,
				this.ownerId,
				this.options.leaseTtlMs,
			);
		}, this.options.heartbeatIntervalMs ?? 30_000);
		try {
			const iterable = await this.resumer.resumeWorkflowRun(
				run.id,
				{},
				{ ownerId: this.ownerId },
			);
			for await (const _event of iterable) {
				/* durable events are persisted by the orchestrator */
			}
		} catch (error) {
			this.options.onError?.(error, run);
		} finally {
			clearInterval(heartbeat);
		}
	}
}
