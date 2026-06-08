import { nanoid } from "nanoid";
import type { DatabaseAdapter } from "../storage/database.js";
import { decideRetryAfterFailure } from "./retry-policy.js";
import type { RetryProgressState } from "./retry-policy.js";

export type WorkflowStatus =
	| "triage"
	| "ready"
	| "running"
	| "waiting_dependency"
	| "blocked"
	| "failed"
	| "timed_out"
	| "interrupted"
	| "cancelled"
	| "partial"
	| "done"
	| "archived";

const TERMINAL_WORKFLOW_STATUSES = new Set<WorkflowStatus>([
	"done",
	"failed",
	"blocked",
	"cancelled",
	"partial",
	"archived",
]);

const RESUMABLE_WORKFLOW_STATUSES: WorkflowStatus[] = [
	"ready",
	"interrupted",
	"failed",
	"partial",
	"blocked",
	"timed_out",
];

const RETRYABLE_TASK_STATUSES: WorkflowStatus[] = [
	"ready",
	"running",
	"interrupted",
	"failed",
	"partial",
	"blocked",
	"timed_out",
	"waiting_dependency",
];

const AUTO_RESUMABLE_WORKFLOW_STATUSES: WorkflowStatus[] = [
	"ready",
	"interrupted",
];

export interface WorkflowRunRecord {
	id: string;
	conversation_id: string | null;
	root_agent_id: string | null;
	goal: string;
	status: WorkflowStatus;
	current_phase: string | null;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
	metadata: string | null;
}

export interface WorkflowTaskRecord {
	id: string;
	run_id: string;
	parent_task_id: string | null;
	assigned_agent_id: string | null;
	arm_key: string | null;
	title: string;
	description: string | null;
	status: WorkflowStatus;
	step_key: string | null;
	progress_signature: string | null;
	attempt_count: number;
	stagnant_attempt_count: number;
	max_stagnant_attempts: number;
	priority: number;
	depends_on: string | null;
	acceptance_criteria: string | null;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
	metadata: string | null;
}

export class WorkflowManager {
	constructor(private db: DatabaseAdapter) {}

	async createRun(input: {
		conversationId?: string;
		rootAgentId?: string;
		goal: string;
		metadata?: Record<string, unknown>;
	}): Promise<WorkflowRunRecord> {
		const id = nanoid(16);
		const now = new Date().toISOString();
		const metadata = input.metadata ? JSON.stringify(input.metadata) : null;
		await this.db.run(
			"INSERT INTO agent_workflow_runs (id, conversation_id, root_agent_id, goal, status, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?)",
			[
				id,
				input.conversationId ?? null,
				input.rootAgentId ?? null,
				input.goal,
				now,
				now,
				metadata,
			],
		);
		return (await this.getRun(id)) as WorkflowRunRecord;
	}

	async getRun(id: string): Promise<WorkflowRunRecord | null> {
		return (
			(await this.db.get<WorkflowRunRecord>(
				"SELECT * FROM agent_workflow_runs WHERE id = ?",
				[id],
			)) ?? null
		);
	}

	async listRuns(options: {
		status?: string;
		conversationId?: string;
		limit?: number;
		offset?: number;
	} = {}): Promise<WorkflowRunRecord[]> {
		const where: string[] = [];
		const params: unknown[] = [];
		if (options.status) {
			where.push("status = ?");
			params.push(options.status);
		}
		if (options.conversationId) {
			where.push("conversation_id = ?");
			params.push(options.conversationId);
		}
		const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
		const offset = Math.max(0, options.offset ?? 0);
		params.push(limit, offset);
		return this.db.all<WorkflowRunRecord>(
			`SELECT * FROM agent_workflow_runs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
			params,
		);
	}

	async listResumableRuns(options: {
		conversationId?: string;
		limit?: number;
		offset?: number;
	} = {}): Promise<WorkflowRunRecord[]> {
		const where = [
			`status IN (${RESUMABLE_WORKFLOW_STATUSES.map(() => "?").join(", ")})`,
		];
		const params: unknown[] = [...RESUMABLE_WORKFLOW_STATUSES];
		if (options.conversationId) {
			where.push("conversation_id = ?");
			params.push(options.conversationId);
		}
		const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
		const offset = Math.max(0, options.offset ?? 0);
		params.push(limit, offset);
		return this.db.all<WorkflowRunRecord>(
			`SELECT * FROM agent_workflow_runs WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
			params,
		);
	}

	async listAutoResumableRuns(options: {
		conversationId?: string;
		limit?: number;
		offset?: number;
	} = {}): Promise<WorkflowRunRecord[]> {
		const where = [
			`status IN (${AUTO_RESUMABLE_WORKFLOW_STATUSES.map(() => "?").join(", ")})`,
		];
		const params: unknown[] = [...AUTO_RESUMABLE_WORKFLOW_STATUSES];
		if (options.conversationId) {
			where.push("conversation_id = ?");
			params.push(options.conversationId);
		}
		const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
		const offset = Math.max(0, options.offset ?? 0);
		params.push(limit, offset);
		return this.db.all<WorkflowRunRecord>(
			`SELECT * FROM agent_workflow_runs WHERE ${where.join(" AND ")} ORDER BY updated_at ASC LIMIT ? OFFSET ?`,
			params,
		);
	}

	async claimRunForExecution(id: string): Promise<WorkflowRunRecord | null> {
		const run = await this.getRun(id);
		if (!run) throw new Error(`Workflow not found: ${id}`);
		if (!AUTO_RESUMABLE_WORKFLOW_STATUSES.includes(run.status)) return null;

		const now = new Date().toISOString();
		await this.db.run(
			`UPDATE agent_workflow_runs SET status = 'running', current_phase = 'resume', updated_at = ?, completed_at = NULL WHERE id = ? AND status IN (${AUTO_RESUMABLE_WORKFLOW_STATUSES.map(() => "?").join(", ")})`,
			[now, id, ...AUTO_RESUMABLE_WORKFLOW_STATUSES],
		);
		const claimed = await this.getRun(id);
		if (!claimed || claimed.status !== "running") return null;

		await this.recordEvent({
			runId: id,
			agentId: claimed.root_agent_id ?? undefined,
			eventType: "resume_claimed",
			message: "Workflow was claimed for durable resume execution.",
			metadata: { previousStatus: run.status },
		});
		return claimed;
	}

	async updateRunStatus(
		id: string,
		status: WorkflowStatus,
		options: { currentPhase?: string | null; metadata?: Record<string, unknown> } = {},
	): Promise<void> {
		const now = new Date().toISOString();
		await this.db.run(
			"UPDATE agent_workflow_runs SET status = ?, current_phase = COALESCE(?, current_phase), updated_at = ?, completed_at = CASE WHEN ? IN ('done', 'failed', 'blocked', 'cancelled', 'partial', 'interrupted', 'timed_out') THEN ? ELSE completed_at END, metadata = COALESCE(?, metadata) WHERE id = ?",
			[
				status,
				options.currentPhase ?? null,
				now,
				status,
				now,
				options.metadata ? JSON.stringify(options.metadata) : null,
				id,
			],
		);
	}

	async markStaleRunsInterrupted(options: {
		staleAfterMs?: number;
	} = {}): Promise<{ runs: number; tasks: number }> {
		const staleAfterMs = Math.max(1, options.staleAfterMs ?? 60_000);
		const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
		const staleRuns = await this.db.all<WorkflowRunRecord>(
			"SELECT * FROM agent_workflow_runs WHERE status = 'running' AND updated_at < ? ORDER BY updated_at ASC",
			[cutoff],
		);
		if (staleRuns.length === 0) return { runs: 0, tasks: 0 };

		let taskCount = 0;
		const now = new Date().toISOString();
		for (const run of staleRuns) {
			const runningTasks = await this.db.all<{ id: string }>(
				"SELECT id FROM agent_workflow_tasks WHERE run_id = ? AND status = 'running'",
				[run.id],
			);
			taskCount += runningTasks.length;
			await this.db.run(
				"UPDATE agent_workflow_tasks SET status = 'ready', updated_at = ? WHERE run_id = ? AND status = 'running'",
				[now, run.id],
			);
			await this.db.run(
				"UPDATE agent_workflow_runs SET status = 'interrupted', current_phase = COALESCE(current_phase, 'recovery'), updated_at = ?, completed_at = NULL WHERE id = ?",
				[now, run.id],
			);
			await this.recordEvent({
				runId: run.id,
				eventType: "interrupted",
				message:
					"Workflow was marked interrupted during recovery because it was left running by a previous process.",
				metadata: { staleAfterMs, cutoff, recoveredTasks: runningTasks.length },
			});
		}
		return { runs: staleRuns.length, tasks: taskCount };
	}

	async retryRun(id: string): Promise<void> {
		const run = await this.getRun(id);
		if (!run) throw new Error(`Workflow not found: ${id}`);
		if (!RESUMABLE_WORKFLOW_STATUSES.includes(run.status)) {
			throw new Error(`Workflow '${id}' is not retryable from status '${run.status}'`);
		}
		const now = new Date().toISOString();
		await this.db.run(
			`UPDATE agent_workflow_tasks SET status = 'ready', updated_at = ?, completed_at = NULL WHERE run_id = ? AND status IN (${RETRYABLE_TASK_STATUSES.map(() => "?").join(", ")})`,
			[now, id, ...RETRYABLE_TASK_STATUSES],
		);
		await this.db.run(
			"UPDATE agent_workflow_runs SET status = 'ready', current_phase = 'retry', updated_at = ?, completed_at = NULL WHERE id = ?",
			[now, id],
		);
		await this.recordEvent({
			runId: id,
			eventType: "retry_requested",
			message: "Workflow retry was requested manually.",
			metadata: { previousStatus: run.status },
		});
	}

	async cancelRun(id: string, reason = "Cancelado por el usuario"): Promise<void> {
		const run = await this.getRun(id);
		if (!run) throw new Error(`Workflow not found: ${id}`);
		const now = new Date().toISOString();
		await this.db.run(
			`UPDATE agent_workflow_tasks SET status = 'cancelled', updated_at = ?, completed_at = ? WHERE run_id = ? AND status NOT IN (${[...TERMINAL_WORKFLOW_STATUSES].map(() => "?").join(", ")})`,
			[now, now, id, ...TERMINAL_WORKFLOW_STATUSES],
		);
		await this.db.run(
			"UPDATE agent_workflow_runs SET status = 'cancelled', current_phase = 'cancelled', updated_at = ?, completed_at = ? WHERE id = ?",
			[now, now, id],
		);
		await this.recordEvent({
			runId: id,
			eventType: "cancelled",
			message: reason,
			metadata: { previousStatus: run.status },
		});
	}

	async getRunSnapshot(id: string): Promise<{
		run: WorkflowRunRecord | null;
		tasks: WorkflowTaskRecord[];
		events: unknown[];
		artifacts: unknown[];
	}> {
		const run = await this.getRun(id);
		const tasks = await this.listRunTasks(id);
		const events = await this.db.all(
			"SELECT * FROM agent_workflow_events WHERE run_id = ? ORDER BY created_at ASC",
			[id],
		);
		const artifacts = await this.db.all(
			"SELECT * FROM agent_workflow_artifacts WHERE run_id = ? ORDER BY created_at ASC",
			[id],
		);
		return { run, tasks, events, artifacts };
	}

	async createTask(input: {
		runId: string;
		parentTaskId?: string;
		assignedAgentId?: string;
		armKey?: string;
		title: string;
		description?: string;
		priority?: number;
		dependsOn?: string[];
		acceptanceCriteria?: string[];
		maxStagnantAttempts?: number;
		metadata?: Record<string, unknown>;
	}): Promise<WorkflowTaskRecord> {
		const id = nanoid(16);
		const now = new Date().toISOString();
		await this.db.run(
			[
				"INSERT INTO agent_workflow_tasks",
				"(id, run_id, parent_task_id, assigned_agent_id, arm_key, title, description, status, priority, depends_on, acceptance_criteria, max_stagnant_attempts, created_at, updated_at, metadata)",
				"VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?)",
			].join(" "),
			[
				id,
				input.runId,
				input.parentTaskId ?? null,
				input.assignedAgentId ?? null,
				input.armKey ?? null,
				input.title,
				input.description ?? null,
				input.priority ?? 5,
				input.dependsOn ? JSON.stringify(input.dependsOn) : null,
				input.acceptanceCriteria
					? JSON.stringify(input.acceptanceCriteria)
					: null,
				input.maxStagnantAttempts ?? 5,
				now,
				now,
				input.metadata ? JSON.stringify(input.metadata) : null,
			],
		);
		return (await this.getTask(id)) as WorkflowTaskRecord;
	}

	async getTask(id: string): Promise<WorkflowTaskRecord | null> {
		return (
			(await this.db.get<WorkflowTaskRecord>(
				"SELECT * FROM agent_workflow_tasks WHERE id = ?",
				[id],
			)) ?? null
		);
	}

	async listRunTasks(runId: string): Promise<WorkflowTaskRecord[]> {
		return this.db.all<WorkflowTaskRecord>(
			"SELECT * FROM agent_workflow_tasks WHERE run_id = ? ORDER BY priority ASC, created_at ASC",
			[runId],
		);
	}

	async updateTaskStatus(
		id: string,
		status: WorkflowStatus,
		options: {
			stepKey?: string | null;
			progressSignature?: string | null;
			metadata?: Record<string, unknown>;
		} = {},
	): Promise<void> {
		const now = new Date().toISOString();
		await this.db.run(
			"UPDATE agent_workflow_tasks SET status = ?, step_key = COALESCE(?, step_key), progress_signature = COALESCE(?, progress_signature), updated_at = ?, completed_at = CASE WHEN ? IN ('done', 'failed', 'blocked', 'cancelled', 'partial', 'interrupted', 'timed_out') THEN ? ELSE completed_at END, metadata = COALESCE(?, metadata) WHERE id = ?",
			[
				status,
				options.stepKey ?? null,
				options.progressSignature ?? null,
				now,
				status,
				now,
				options.metadata ? JSON.stringify(options.metadata) : null,
				id,
			],
		);
	}

	async recordEvent(input: {
		runId: string;
		taskId?: string;
		agentId?: string;
		eventType: string;
		message?: string;
		toolName?: string;
		metadata?: Record<string, unknown>;
	}): Promise<void> {
		await this.db.run(
			"INSERT INTO agent_workflow_events (id, run_id, task_id, agent_id, event_type, message, tool_name, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			[
				nanoid(16),
				input.runId,
				input.taskId ?? null,
				input.agentId ?? null,
				input.eventType,
				input.message ?? null,
				input.toolName ?? null,
				input.metadata ? JSON.stringify(input.metadata) : null,
			],
		);
	}

	async recordArtifact(input: {
		runId: string;
		taskId?: string;
		agentId?: string;
		artifactType: string;
		url?: string;
		path?: string;
		description?: string;
		existsVerified?: boolean;
		metadata?: Record<string, unknown>;
	}): Promise<void> {
		await this.db.run(
			"INSERT INTO agent_workflow_artifacts (id, run_id, task_id, agent_id, artifact_type, url, path, description, exists_verified, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				nanoid(16),
				input.runId,
				input.taskId ?? null,
				input.agentId ?? null,
				input.artifactType,
				input.url ?? null,
				input.path ?? null,
				input.description ?? null,
				input.existsVerified ? 1 : 0,
				input.metadata ? JSON.stringify(input.metadata) : null,
			],
		);
	}

	async recordFailureAndDecideRetry(input: {
		taskId: string;
		stepKey?: string | null;
		progressSignature?: string | null;
		error: string;
		metadata?: Record<string, unknown>;
	}): Promise<{ shouldRetry: boolean; shouldBlock: boolean; reason: string }> {
		const task = await this.getTask(input.taskId);
		if (!task) throw new Error(`Workflow task not found: ${input.taskId}`);

		const state: RetryProgressState = {
			stepKey: task.step_key,
			progressSignature: task.progress_signature,
			attemptCount: task.attempt_count,
			stagnantAttemptCount: task.stagnant_attempt_count,
			maxStagnantAttempts: task.max_stagnant_attempts,
		};
		const decision = decideRetryAfterFailure(state, {
			stepKey: input.stepKey,
			progressSignature: input.progressSignature,
		});
		const nextStatus: WorkflowStatus = decision.shouldBlock ? "blocked" : "ready";
		const now = new Date().toISOString();

		await this.db.run(
			"INSERT INTO agent_workflow_attempts (id, task_id, attempt_number, step_key, status, started_at, ended_at, error, progress_signature_before, progress_signature_after, metadata) VALUES (?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?, ?)",
			[
				nanoid(16),
				input.taskId,
				decision.attemptCount,
				input.stepKey ?? task.step_key,
				now,
				now,
				input.error,
				task.progress_signature,
				input.progressSignature ?? task.progress_signature,
				input.metadata ? JSON.stringify(input.metadata) : null,
			],
		);

		await this.db.run(
			"UPDATE agent_workflow_tasks SET status = ?, step_key = ?, progress_signature = ?, attempt_count = ?, stagnant_attempt_count = ?, updated_at = ? WHERE id = ?",
			[
				nextStatus,
				input.stepKey ?? task.step_key,
				input.progressSignature ?? task.progress_signature,
				decision.attemptCount,
				decision.stagnantAttemptCount,
				now,
				input.taskId,
			],
		);

		await this.recordEvent({
			runId: task.run_id,
			taskId: task.id,
			agentId: task.assigned_agent_id ?? undefined,
			eventType: decision.shouldBlock ? "blocked" : "retry_scheduled",
			message: `${decision.reason} Error: ${input.error}`,
			metadata: { decision },
		});

		return decision;
	}
}
