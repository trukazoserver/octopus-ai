import type { DatabaseAdapter } from "../storage/database.js";
import type {
	ArtifactVerificationResult,
	ArtifactVerifier,
} from "./artifact-verifier.js";
import type {
	WorkflowManager,
	WorkflowStatus,
	WorkflowTaskRecord,
} from "./workflow-manager.js";

export interface ExpectedArtifact {
	artifactType: string;
	artifactKey?: string;
	description: string;
	count: number;
}

export interface ProducedArtifact {
	artifactType: string;
	artifactKey?: string;
	url?: string;
	path?: string;
	description?: string;
}

export interface PersistedLedgerSnapshot {
	snapshotAt: string;
	iteration: number;
	objectiveKind: string;
	imageUrls: string[];
	mediaUrls: string[];
	capturedScreenshots: string[];
	detailScreenshots: string[];
	blockers: string[];
	usefulResults: number;
	consecutiveErrors: number;
	toolHistory: Array<{
		name: string;
		success: boolean;
		useful: boolean;
		summary: string;
	}>;
}

export interface ReconciliationReport {
	runId: string;
	totalSubtasks: number;
	verifiedCompleted: number;
	verifiedPartial: number;
	genuinelyMissing: number;
	subtaskDetails: Array<{
		id: string;
		title: string;
		status: WorkflowStatus;
		verifiedArtifactCount: number;
		expectedArtifactCount: number;
		missingTypes: string[];
	}>;
	verifiedContext: string;
}

interface TaskWithArtifacts {
	task: WorkflowTaskRecord;
	artifacts: Array<{ id: string; artifact_type: string }>;
	verificationResults: ArtifactVerificationResult[];
}

export class SubtaskTracker {
	constructor(
		private workflowManager: WorkflowManager,
		private artifactVerifier: ArtifactVerifier,
		private db: DatabaseAdapter,
	) {}

	async beginInlineRun(input: {
		conversationId: string;
		agentId: string;
		goal: string;
		executionId?: string;
	}): Promise<string> {
		const run = await this.workflowManager.createRun({
			conversationId: input.conversationId,
			rootAgentId: input.agentId,
			goal: input.goal,
			metadata: { source: "inline", executionId: input.executionId },
		});
		await this.db.run(
			"UPDATE agent_workflow_runs SET execution_id = ? WHERE id = ?",
			[input.executionId ?? null, run.id],
		);
		return run.id;
	}

	async declareSubtask(input: {
		runId: string;
		title: string;
		toolName: string;
		expectedArtifacts?: ExpectedArtifact[];
		stepKey?: string;
	}): Promise<string> {
		const task = await this.workflowManager.createTask({
			runId: input.runId,
			title: input.title,
			description: `Tool: ${input.toolName}`,
			priority: 5,
			metadata: {
				source: "inline",
				toolName: input.toolName,
				expectedArtifacts: input.expectedArtifacts ?? [],
			},
		});
		if (input.expectedArtifacts && input.expectedArtifacts.length > 0) {
			await this.db.run(
				"UPDATE agent_workflow_tasks SET expected_artifacts = ? WHERE id = ?",
				[JSON.stringify(input.expectedArtifacts), task.id],
			);
		}
		return task.id;
	}

	async startSubtask(taskId: string): Promise<void> {
		await this.workflowManager.updateTaskStatus(taskId, "running");
	}

	async completeSubtask(
		taskId: string,
		artifacts: ProducedArtifact[],
	): Promise<void> {
		const task = await this.workflowManager.getTask(taskId);
		if (!task) return;

		const verifiedIds: string[] = [];
		for (const artifact of artifacts) {
			const record = await this.workflowManager.recordArtifact({
				runId: task.run_id,
				taskId,
				agentId: task.assigned_agent_id ?? undefined,
				artifactType: artifact.artifactType,
				artifactKey: artifact.artifactKey,
				url: artifact.url,
				path: artifact.path,
				description: artifact.description,
				existsVerified: false,
			});
			verifiedIds.push(record.id);
		}

		await this.db.run(
			"UPDATE agent_workflow_tasks SET verified_artifacts = ? WHERE id = ?",
			[JSON.stringify(verifiedIds), taskId],
		);
		await this.workflowManager.updateTaskStatus(taskId, "done");
	}

	async failSubtask(taskId: string, error: string): Promise<void> {
		const task = await this.workflowManager.getTask(taskId);
		if (!task) return;

		await this.workflowManager.updateTaskStatus(taskId, "failed");
		await this.workflowManager.recordEvent({
			runId: task.run_id,
			taskId,
			eventType: "subtask_failed",
			message: error,
		});
	}

	async persistLedgerSnapshot(
		runId: string,
		snapshot: PersistedLedgerSnapshot,
	): Promise<void> {
		await this.workflowManager.recordArtifact({
			runId,
			artifactType: "evidence_ledger_snapshot",
			description: `Ledger snapshot at iteration ${snapshot.iteration}`,
			existsVerified: true,
			metadata: snapshot as unknown as Record<string, unknown>,
		});
	}

	async interruptInlineRun(runId: string, reason: string): Promise<void> {
		const now = new Date().toISOString();
		const runningTasks = await this.db.all<{ id: string }>(
			"SELECT id FROM agent_workflow_tasks WHERE run_id = ? AND status = 'running'",
			[runId],
		);
		for (const t of runningTasks) {
			await this.workflowManager.updateTaskStatus(t.id, "interrupted");
		}
		await this.workflowManager.updateRunStatus(runId, "interrupted", {
			currentPhase: "interrupted",
			metadata: { source: "inline", interruptReason: reason },
		});
		await this.workflowManager.recordEvent({
			runId,
			eventType: "inline_run_interrupted",
			message: reason,
		});
	}

	async completeInlineRun(runId: string): Promise<void> {
		await this.workflowManager.updateRunStatus(runId, "done", {
			currentPhase: "completed",
		});
	}

	async findInterruptedRun(conversationId: string): Promise<string | null> {
		const run = await this.db.get<{ id: string }>(
			`SELECT id FROM agent_workflow_runs
			 WHERE conversation_id = ? AND status IN ('interrupted', 'partial')
			 AND metadata LIKE '%source%inline%'
			 ORDER BY updated_at DESC LIMIT 1`,
			[conversationId],
		);
		return run?.id ?? null;
	}

	async reconcileInterruptedRun(runId: string): Promise<ReconciliationReport> {
		const tasks = await this.workflowManager.listRunTasks(runId);
		const allVerificationResults =
			await this.artifactVerifier.verifyRunArtifacts(runId);

		const verificationByArtifactId = new Map<
			string,
			ArtifactVerificationResult
		>();
		for (const vr of allVerificationResults) {
			verificationByArtifactId.set(vr.artifactId, vr);
		}

		const taskDetails: ReconciliationReport["subtaskDetails"] = [];
		let verifiedCompleted = 0;
		let verifiedPartial = 0;
		let genuinelyMissing = 0;

		for (const task of tasks) {
			const artifacts = await this.db.all<{
				id: string;
				artifact_type: string;
			}>(
				"SELECT id, artifact_type FROM agent_workflow_artifacts WHERE task_id = ? AND artifact_type != 'evidence_ledger_snapshot'",
				[task.id],
			);

			const verifiedCount = artifacts.filter(
				(a) => verificationByArtifactId.get(a.id)?.exists === true,
			).length;

			const expectedArtifacts = this.parseExpectedArtifacts(task);
			const expectedCount = expectedArtifacts.reduce(
				(sum, ea) => sum + ea.count,
				0,
			);
			const missingTypes = this.getMissingArtifactTypes(
				artifacts,
				verificationByArtifactId,
			);

			let effectiveStatus = task.status;
			if (
				(task.status === "running" || task.status === "ready") &&
				verifiedCount > 0 &&
				verifiedCount === (expectedCount || artifacts.length)
			) {
				effectiveStatus = "done";
				await this.workflowManager.updateTaskStatus(task.id, "done");
			} else if (task.status === "done" && verifiedCount < artifacts.length) {
				effectiveStatus = "partial";
				await this.workflowManager.updateTaskStatus(task.id, "partial");
			}

			if (
				effectiveStatus === "done" &&
				verifiedCount === (expectedCount || artifacts.length) &&
				missingTypes.length === 0
			) {
				verifiedCompleted++;
			} else if (verifiedCount > 0) {
				verifiedPartial++;
			} else {
				genuinelyMissing++;
			}

			taskDetails.push({
				id: task.id,
				title: task.title,
				status: effectiveStatus,
				verifiedArtifactCount: verifiedCount,
				expectedArtifactCount: expectedCount || artifacts.length,
				missingTypes,
			});
		}

		const verifiedContext = this.buildVerifiedContext(
			taskDetails,
			verifiedCompleted,
			verifiedPartial,
			genuinelyMissing,
		);

		return {
			runId,
			totalSubtasks: tasks.length,
			verifiedCompleted,
			verifiedPartial,
			genuinelyMissing,
			subtaskDetails: taskDetails,
			verifiedContext,
		};
	}

	private parseExpectedArtifacts(task: WorkflowTaskRecord): ExpectedArtifact[] {
		try {
			const row = task as WorkflowTaskRecord & { expected_artifacts?: string };
			if (row.expected_artifacts) {
				return JSON.parse(row.expected_artifacts);
			}
			if (task.metadata) {
				const meta = JSON.parse(task.metadata);
				if (meta.expectedArtifacts) return meta.expectedArtifacts;
			}
		} catch {
			/* ignore */
		}
		return [];
	}

	private getMissingArtifactTypes(
		artifacts: Array<{ id: string; artifact_type: string }>,
		verificationByArtifactId: Map<string, ArtifactVerificationResult>,
	): string[] {
		const missing: string[] = [];
		for (const a of artifacts) {
			const vr = verificationByArtifactId.get(a.id);
			if (!vr || !vr.exists) {
				missing.push(a.artifact_type);
			}
		}
		return missing;
	}

	private buildVerifiedContext(
		details: ReconciliationReport["subtaskDetails"],
		completed: number,
		partial: number,
		missing: number,
	): string {
		if (details.length === 0) return "";

		const lines: string[] = [
			"# VERIFIED RECOVERY STATE",
			"Previous execution was interrupted. The following state has been VERIFIED by checking actual files on disk:",
			"",
		];

		if (completed > 0) {
			const completedTasks = details.filter((d) => d.status === "done");
			for (const t of completedTasks) {
				lines.push(
					`Completed (verified): "${t.title}" — ${t.verifiedArtifactCount}/${t.expectedArtifactCount} artifacts confirmed`,
				);
			}
		}

		if (partial > 0) {
			const partialTasks = details.filter((d) => d.status === "partial");
			for (const t of partialTasks) {
				lines.push(
					`Partial (verified): "${t.title}" — ${t.verifiedArtifactCount}/${t.expectedArtifactCount} artifacts found, missing: ${t.missingTypes.join(", ")}`,
				);
			}
		}

		if (missing > 0) {
			const missingTasks = details.filter((d) => d.verifiedArtifactCount === 0);
			for (const t of missingTasks) {
				lines.push(
					`Incomplete (verified missing): "${t.title}" — 0/${t.expectedArtifactCount} artifacts found`,
				);
			}
		}

		lines.push("");
		lines.push(
			"IMPORTANT: Do NOT regenerate confirmed artifacts. Resume only from genuinely missing items.",
		);

		return lines.join("\n");
	}
}
