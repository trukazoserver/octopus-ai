import type { SubtaskTracker, ReconciliationReport } from "./subtask-tracker.js";
import type { WorkflowManager } from "./workflow-manager.js";

export class ReconciliationService {
	constructor(
		private subtaskTracker: SubtaskTracker,
		private workflowManager: WorkflowManager,
	) {}

	async reconcileOnResume(input: {
		conversationId: string;
	}): Promise<ReconciliationReport | null> {
		const runId = await this.subtaskTracker.findInterruptedRun(input.conversationId);
		if (!runId) return null;

		const report = await this.subtaskTracker.reconcileInterruptedRun(runId);

		await this.workflowManager.updateRunStatus(runId, "running", {
			currentPhase: "recovery_reconciled",
			metadata: {
				reconciledAt: new Date().toISOString(),
				verifiedCompleted: report.verifiedCompleted,
				verifiedPartial: report.verifiedPartial,
				genuinelyMissing: report.genuinelyMissing,
			},
		});

		await this.workflowManager.recordEvent({
			runId,
			eventType: "recovery_reconciled",
			message: `Reconciliation complete: ${report.verifiedCompleted} completed, ${report.verifiedPartial} partial, ${report.genuinelyMissing} missing`,
		});

		return report;
	}

	buildResumptionPrompt(report: ReconciliationReport): string {
		return report.verifiedContext;
	}
}
