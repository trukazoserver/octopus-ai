import type { WorkflowManager, WorkflowRunRecord } from "./workflow-manager.js";

export interface WorkflowRunResumer {
	resumeWorkflowRun(
		workflowRunId: string,
	): AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
}

export interface WorkflowSchedulerOptions {
	limit?: number;
	onError?: (error: unknown, run: WorkflowRunRecord) => void;
}

export class WorkflowScheduler {
	private activeRunIds = new Set<string>();
	private ticking = false;

	constructor(
		private workflowManager: WorkflowManager,
		private resumer: WorkflowRunResumer,
		private options: WorkflowSchedulerOptions = {},
	) {}

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
				this.activeRunIds.add(run.id);
				claimed++;
				void this.drainRun(run).finally(() => {
					this.activeRunIds.delete(run.id);
				});
			}
			return { claimed, skipped };
		} finally {
			this.ticking = false;
		}
	}

	private async drainRun(run: WorkflowRunRecord): Promise<void> {
		try {
			const iterable = await this.resumer.resumeWorkflowRun(run.id);
			for await (const _event of iterable) {
				/* durable events are persisted by the orchestrator */
			}
		} catch (error) {
			this.options.onError?.(error, run);
		}
	}
}
