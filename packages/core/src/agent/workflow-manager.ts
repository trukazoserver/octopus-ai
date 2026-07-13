import { nanoid } from "nanoid";
import type { DatabaseAdapter } from "../storage/database.js";
import { decideRetryAfterFailure } from "./retry-policy.js";
import type { RetryProgressState } from "./retry-policy.js";

export type WorkflowStatus =
	| "triage"
	| "ready"
	| "running"
	| "waiting_dependency"
	| "review"
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
	owner_id: string | null;
	lease_expires_at: string | null;
	last_heartbeat_at: string | null;
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
	workspace_type?: string | null;
	workspace_path?: string | null;
	claim_token?: string | null;
	claimed_by_agent_id?: string | null;
	claimed_by_arm_key?: string | null;
	lease_expires_at?: string | null;
	last_heartbeat_at?: string | null;
	ready_at?: string | null;
	blocked_reason?: string | null;
	review_reason?: string | null;
	requires_human_review?: number;
	produces?: string | null;
	requirement_summary?: string | null;
	wip_group?: string | null;
	model?: string | null;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
	metadata: string | null;
}

export interface WorkflowArtifactRecord {
	id: string;
	run_id: string;
	task_id: string | null;
	agent_id: string | null;
	artifact_type: string;
	artifact_key: string | null;
	url: string | null;
	path: string | null;
	description: string | null;
	exists_verified: number;
	verified_at?: string | null;
	verification_error?: string | null;
	created_at: string;
	metadata: string | null;
}

export type WorkflowRequirementType =
	| "task_status"
	| "artifact"
	| "manual"
	| "time";

export type WorkflowRequirementStatus = "pending" | "satisfied" | "failed";

export interface WorkflowTaskRequirementRecord {
	id: string;
	run_id: string;
	task_id: string;
	requirement_key: string;
	requirement_type: WorkflowRequirementType;
	required_task_id: string | null;
	required_status: string | null;
	artifact_key: string | null;
	artifact_type: string | null;
	min_count: number;
	optional: number;
	status: WorkflowRequirementStatus;
	satisfied_by_task_id: string | null;
	satisfied_by_artifact_id: string | null;
	satisfied_at: string | null;
	failure_reason: string | null;
	created_at: string;
	updated_at: string;
	metadata: string | null;
}

export interface WorkflowTaskLeaseRecord {
	task_id: string;
	run_id: string;
	agent_id: string;
	arm_key: string | null;
	lease_token: string;
	claimed_at: string;
	expires_at: string;
	last_heartbeat_at: string;
	heartbeat_count: number;
	status: string;
	metadata: string | null;
}

export interface WorkflowBlockerRecord {
	id: string;
	run_id: string;
	task_id: string;
	blocker_type: string;
	severity: string;
	reason: string;
	owner_agent_id: string | null;
	opened_at: string;
	resolved_at: string | null;
	resolution: string | null;
	metadata: string | null;
}

export interface WorkflowTaskCommentRecord {
	id: string;
	run_id: string;
	task_id: string;
	author_agent_id: string | null;
	comment_type: string;
	body: string;
	created_at: string;
	metadata: string | null;
}

export interface KanbanRunMetrics {
	totalTasks: number;
	byStatus: Record<string, number>;
	blockedOpen: number;
	requirementsPending: number;
	requirementsSatisfied: number;
	verifiedArtifacts: number;
	totalArtifacts: number;
	activeLeases: number;
	oldestWaitingTaskAgeMs: number | null;
	oldestRunningTaskAgeMs: number | null;
	completedTasks: number;
	completionRatio: number;
}

export interface WorkflowTaskContext {
	task: WorkflowTaskRecord;
	run: WorkflowRunRecord | null;
	requirements: WorkflowTaskRequirementRecord[];
	missingRequirements: WorkflowTaskRequirementRecord[];
	artifacts: WorkflowArtifactRecord[];
	matchingArtifacts: WorkflowArtifactRecord[];
	blockers: WorkflowBlockerRecord[];
	comments: WorkflowTaskCommentRecord[];
	leases: WorkflowTaskLeaseRecord[];
}

export interface WorkflowDependencyEdge {
	id: string;
	runId: string;
	fromTaskId: string | null;
	toTaskId: string;
	requirementId: string;
	edgeType: WorkflowRequirementType;
	status: WorkflowRequirementStatus;
	artifactKey: string | null;
	artifactType: string | null;
	requiredStatus: string | null;
	satisfiedAt: string | null;
}

export interface KanbanDispatcherPersistedState {
	enabled: boolean;
	updatedAt: string;
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

	async listRuns(
		options: {
			status?: string;
			conversationId?: string;
			limit?: number;
			offset?: number;
		} = {},
	): Promise<WorkflowRunRecord[]> {
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

	async listResumableRuns(
		options: {
			conversationId?: string;
			limit?: number;
			offset?: number;
		} = {},
	): Promise<WorkflowRunRecord[]> {
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

	async listAutoResumableRuns(
		options: {
			conversationId?: string;
			limit?: number;
			offset?: number;
		} = {},
	): Promise<WorkflowRunRecord[]> {
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

	async claimRunForExecution(
		id: string,
		options: { ownerId?: string; leaseTtlMs?: number } = {},
	): Promise<WorkflowRunRecord | null> {
		const now = new Date().toISOString();
		const ownerId = options.ownerId ?? nanoid();
		const leaseExpiresAt = new Date(
			Date.now() + Math.max(1_000, options.leaseTtlMs ?? 120_000),
		).toISOString();
		const claimed = await this.db.get<WorkflowRunRecord>(
			`UPDATE agent_workflow_runs SET status = 'running', current_phase = 'resume', owner_id = ?, lease_expires_at = ?, last_heartbeat_at = ?, updated_at = ?, completed_at = NULL WHERE id = ? AND status IN (${AUTO_RESUMABLE_WORKFLOW_STATUSES.map(() => "?").join(", ")}) RETURNING *`,
			[ownerId, leaseExpiresAt, now, now, id, ...AUTO_RESUMABLE_WORKFLOW_STATUSES],
		);
		if (!claimed) return null;

		await this.recordEvent({
			runId: id,
			agentId: claimed.root_agent_id ?? undefined,
			eventType: "resume_claimed",
			message: "Workflow was claimed for durable resume execution.",
			metadata: { ownerId, leaseExpiresAt },
		});
		return claimed;
	}

	async heartbeatRunLease(
		id: string,
		ownerId: string,
		leaseTtlMs = 120_000,
	): Promise<boolean> {
		const now = new Date().toISOString();
		const leaseExpiresAt = new Date(
			Date.now() + Math.max(1_000, leaseTtlMs),
		).toISOString();
		const row = await this.db.get<{ id: string }>(
			"UPDATE agent_workflow_runs SET lease_expires_at = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND status = 'running' AND lease_expires_at >= ? RETURNING id",
			[leaseExpiresAt, now, now, id, ownerId, now],
		);
		return Boolean(row);
	}

	async updateRunStatus(
		id: string,
		status: WorkflowStatus,
		options: {
			currentPhase?: string | null;
			metadata?: Record<string, unknown>;
			ownerId?: string;
		} = {},
	): Promise<boolean> {
		const now = new Date().toISOString();
		const terminal = TERMINAL_WORKFLOW_STATUSES.has(status) || ["interrupted", "timed_out"].includes(status);
		const row = await this.db.get<{ id: string }>(
			`UPDATE agent_workflow_runs SET status = ?, current_phase = COALESCE(?, current_phase), updated_at = ?, completed_at = CASE WHEN ? IN ('done', 'failed', 'blocked', 'cancelled', 'partial', 'interrupted', 'timed_out') THEN ? ELSE completed_at END, metadata = COALESCE(?, metadata), owner_id = CASE WHEN ? THEN NULL ELSE owner_id END, lease_expires_at = CASE WHEN ? THEN NULL ELSE lease_expires_at END, last_heartbeat_at = CASE WHEN ? THEN NULL ELSE last_heartbeat_at END WHERE id = ?${options.ownerId ? " AND owner_id = ? AND status = 'running' AND lease_expires_at >= ?" : ""} RETURNING id`,
			[
				status,
				options.currentPhase ?? null,
				now,
				status,
				now,
				options.metadata ? JSON.stringify(options.metadata) : null,
				terminal ? 1 : 0,
				terminal ? 1 : 0,
				terminal ? 1 : 0,
				id,
				...(options.ownerId ? [options.ownerId, now] : []),
			],
		);
		return Boolean(row);
	}

	async getKanbanDispatcherState(): Promise<KanbanDispatcherPersistedState | null> {
		try {
			const row = await this.db.get<{
				enabled: number;
				updated_at: string;
				metadata: string | null;
			}>(
				"SELECT enabled, updated_at, metadata FROM kanban_dispatcher_state WHERE id = 'default'",
			);
			return row
				? {
						enabled: row.enabled === 1,
						updatedAt: row.updated_at,
						metadata: row.metadata,
					}
				: null;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (/no such table/i.test(message)) return null;
			throw err;
		}
	}

	async setKanbanDispatcherEnabled(
		enabled: boolean,
		metadata?: Record<string, unknown>,
	): Promise<void> {
		const now = new Date().toISOString();
		try {
			await this.db.run(
				"INSERT INTO kanban_dispatcher_state (id, enabled, updated_at, metadata) VALUES ('default', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, metadata = excluded.metadata",
				[enabled ? 1 : 0, now, metadata ? JSON.stringify(metadata) : null],
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (/no such table/i.test(message)) return;
			throw err;
		}
	}

	async reopenRunForPendingWork(
		runId: string,
		options: { reason?: string; currentPhase?: string } = {},
	): Promise<boolean> {
		const run = await this.getRun(runId);
		if (!run) return false;
		if (["cancelled", "archived"].includes(run.status)) return false;
		const now = new Date().toISOString();
		await this.db.run(
			"UPDATE agent_workflow_runs SET status = 'running', current_phase = ?, updated_at = ?, completed_at = NULL WHERE id = ?",
			[options.currentPhase ?? "waiting_dependency", now, runId],
		);
		if (run.status !== "running" || run.completed_at) {
			await this.recordEvent({
				runId,
				eventType: "workflow_reopened",
				message:
					options.reason ?? "Workflow reopened because pending work exists.",
				metadata: { previousStatus: run.status },
			});
		}
		return true;
	}

	async markStaleRunsInterrupted(
		options: {
			staleAfterMs?: number;
		} = {},
	): Promise<{ runs: number; tasks: number }> {
		const staleAfterMs = Math.max(1, options.staleAfterMs ?? 60_000);
		const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
		const now = new Date().toISOString();
		const staleRuns = await this.db.all<WorkflowRunRecord>(
			"SELECT * FROM agent_workflow_runs WHERE status = 'running' AND (lease_expires_at < ? OR (lease_expires_at IS NULL AND updated_at < ?)) ORDER BY updated_at ASC",
			[now, cutoff],
		);
		if (staleRuns.length === 0) return { runs: 0, tasks: 0 };

		let taskCount = 0;
		let runCount = 0;
		for (const run of staleRuns) {
			const interrupted = await this.db.get<{ id: string }>(
				"UPDATE agent_workflow_runs SET status = 'interrupted', current_phase = COALESCE(current_phase, 'recovery'), owner_id = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL, updated_at = ?, completed_at = NULL WHERE id = ? AND status = 'running' AND (lease_expires_at < ? OR (lease_expires_at IS NULL AND updated_at < ?)) RETURNING id",
				[now, run.id, now, cutoff],
			);
			if (!interrupted) continue;
			runCount++;
			const runningTasks = await this.db.all<{ id: string }>(
				"SELECT id FROM agent_workflow_tasks WHERE run_id = ? AND status = 'running'",
				[run.id],
			);
			taskCount += runningTasks.length;
			await this.db.run(
				"UPDATE agent_workflow_tasks SET status = 'ready', updated_at = ? WHERE run_id = ? AND status = 'running'",
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
		return { runs: runCount, tasks: taskCount };
	}

	async retryRun(id: string): Promise<void> {
		const run = await this.getRun(id);
		if (!run) throw new Error(`Workflow not found: ${id}`);
		if (!RESUMABLE_WORKFLOW_STATUSES.includes(run.status)) {
			throw new Error(
				`Workflow '${id}' is not retryable from status '${run.status}'`,
			);
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

	async cancelRun(
		id: string,
		reason = "Cancelado por el usuario",
	): Promise<void> {
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
		requirements: WorkflowTaskRequirementRecord[];
		leases: WorkflowTaskLeaseRecord[];
		blockers: WorkflowBlockerRecord[];
		comments: WorkflowTaskCommentRecord[];
		dependencyEdges: WorkflowDependencyEdge[];
		metrics: KanbanRunMetrics;
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
		const requirements = await this.db.all<WorkflowTaskRequirementRecord>(
			"SELECT * FROM agent_workflow_task_requirements WHERE run_id = ? ORDER BY created_at ASC",
			[id],
		);
		const leases = await this.listTaskLeases(id);
		const blockers = await this.listRunBlockers(id);
		const comments = await this.listRunComments(id);
		const dependencyEdges = await this.getRunDependencyEdges(id);
		const metrics = await this.getRunMetrics(id);
		return {
			run,
			tasks,
			events,
			artifacts,
			requirements,
			leases,
			blockers,
			comments,
			dependencyEdges,
			metrics,
		};
	}

	async createTask(input: {
		runId: string;
		parentTaskId?: string;
		assignedAgentId?: string;
		armKey?: string;
		title: string;
		description?: string;
		status?: WorkflowStatus;
		priority?: number;
		dependsOn?: string[];
		acceptanceCriteria?: string[];
		workspaceType?: string;
		workspacePath?: string;
		produces?: Array<Record<string, unknown>>;
		requiresHumanReview?: boolean;
		maxStagnantAttempts?: number;
		model?: string;
		metadata?: Record<string, unknown>;
	}): Promise<WorkflowTaskRecord> {
		const id = nanoid(16);
		const now = new Date().toISOString();
		await this.db.run(
			[
				"INSERT INTO agent_workflow_tasks",
				"(id, run_id, parent_task_id, assigned_agent_id, arm_key, title, description, status, priority, depends_on, acceptance_criteria, max_stagnant_attempts, workspace_type, workspace_path, produces, requires_human_review, ready_at, model, created_at, updated_at, metadata)",
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			].join(" "),
			[
				id,
				input.runId,
				input.parentTaskId ?? null,
				input.assignedAgentId ?? null,
				input.armKey ?? null,
				input.title,
				input.description ?? null,
				input.status ?? "ready",
				input.priority ?? 5,
				input.dependsOn ? JSON.stringify(input.dependsOn) : null,
				input.acceptanceCriteria
					? JSON.stringify(input.acceptanceCriteria)
					: null,
				input.maxStagnantAttempts ?? 5,
				input.workspaceType ?? "scratch",
				input.workspacePath ?? null,
				input.produces ? JSON.stringify(input.produces) : null,
				input.requiresHumanReview ? 1 : 0,
				(input.status ?? "ready") === "ready" ? now : null,
				input.model ?? null,
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

	async listTasksByStatus(
		statuses: WorkflowStatus[],
		options: { limit?: number; runId?: string } = {},
	): Promise<WorkflowTaskRecord[]> {
		if (statuses.length === 0) return [];
		const params: unknown[] = [...statuses];
		const where = [`status IN (${statuses.map(() => "?").join(", ")})`];
		if (options.runId) {
			where.push("run_id = ?");
			params.push(options.runId);
		}
		params.push(Math.max(1, Math.min(options.limit ?? 50, 200)));
		return this.db.all<WorkflowTaskRecord>(
			`SELECT * FROM agent_workflow_tasks WHERE ${where.join(" AND ")} ORDER BY priority ASC, created_at ASC LIMIT ?`,
			params,
		);
	}

	async listReadyTasks(
		options: {
			limit?: number;
			excludeTaskIds?: string[];
		} = {},
	): Promise<WorkflowTaskRecord[]> {
		const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
		const params: unknown[] = [new Date().toISOString()];
		let exclude = "";
		if (options.excludeTaskIds && options.excludeTaskIds.length > 0) {
			exclude = ` AND id NOT IN (${options.excludeTaskIds.map(() => "?").join(", ")})`;
			params.push(...options.excludeTaskIds);
		}
		params.push(limit);
		return this.db.all<WorkflowTaskRecord>(
			`SELECT * FROM agent_workflow_tasks WHERE status = 'ready' AND (lease_expires_at IS NULL OR lease_expires_at < ?)${exclude} ORDER BY priority ASC, created_at ASC LIMIT ?`,
			params,
		);
	}

	async createRequirement(input: {
		runId: string;
		taskId: string;
		requirementKey: string;
		requirementType: WorkflowRequirementType;
		requiredTaskId?: string;
		requiredStatus?: string;
		artifactKey?: string;
		artifactType?: string;
		minCount?: number;
		optional?: boolean;
		metadata?: Record<string, unknown>;
	}): Promise<WorkflowTaskRequirementRecord> {
		const id = nanoid(16);
		const now = new Date().toISOString();
		await this.db.run(
			[
				"INSERT INTO agent_workflow_task_requirements",
				"(id, run_id, task_id, requirement_key, requirement_type, required_task_id, required_status, artifact_key, artifact_type, min_count, optional, status, created_at, updated_at, metadata)",
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
			].join(" "),
			[
				id,
				input.runId,
				input.taskId,
				input.requirementKey,
				input.requirementType,
				input.requiredTaskId ?? null,
				input.requiredStatus ?? null,
				input.artifactKey ?? null,
				input.artifactType ?? null,
				input.minCount ?? 1,
				input.optional ? 1 : 0,
				now,
				now,
				input.metadata ? JSON.stringify(input.metadata) : null,
			],
		);
		return (await this.getRequirement(id)) as WorkflowTaskRequirementRecord;
	}

	async getRequirement(
		id: string,
	): Promise<WorkflowTaskRequirementRecord | null> {
		return (
			(await this.db.get<WorkflowTaskRequirementRecord>(
				"SELECT * FROM agent_workflow_task_requirements WHERE id = ?",
				[id],
			)) ?? null
		);
	}

	async listTaskRequirements(
		taskId: string,
	): Promise<WorkflowTaskRequirementRecord[]> {
		return this.db.all<WorkflowTaskRequirementRecord>(
			"SELECT * FROM agent_workflow_task_requirements WHERE task_id = ? ORDER BY created_at ASC",
			[taskId],
		);
	}

	async listRequirements(
		options: {
			status?: WorkflowRequirementStatus;
			runId?: string;
			requiredTaskId?: string;
			limit?: number;
		} = {},
	): Promise<WorkflowTaskRequirementRecord[]> {
		const where: string[] = [];
		const params: unknown[] = [];
		if (options.status) {
			where.push("status = ?");
			params.push(options.status);
		}
		if (options.runId) {
			where.push("run_id = ?");
			params.push(options.runId);
		}
		if (options.requiredTaskId) {
			where.push("required_task_id = ?");
			params.push(options.requiredTaskId);
		}
		params.push(Math.max(1, Math.min(options.limit ?? 500, 1000)));
		return this.db.all<WorkflowTaskRequirementRecord>(
			`SELECT * FROM agent_workflow_task_requirements${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC LIMIT ?`,
			params,
		);
	}

	async markRequirementSatisfied(
		id: string,
		input: { taskId?: string; artifactId?: string },
	): Promise<void> {
		const now = new Date().toISOString();
		await this.db.run(
			"UPDATE agent_workflow_task_requirements SET status = 'satisfied', satisfied_by_task_id = COALESCE(?, satisfied_by_task_id), satisfied_by_artifact_id = COALESCE(?, satisfied_by_artifact_id), satisfied_at = COALESCE(satisfied_at, ?), updated_at = ? WHERE id = ?",
			[input.taskId ?? null, input.artifactId ?? null, now, now, id],
		);
	}

	async markRequirementPending(
		id: string,
		failureReason?: string,
	): Promise<void> {
		const now = new Date().toISOString();
		await this.db.run(
			"UPDATE agent_workflow_task_requirements SET status = 'pending', satisfied_by_task_id = NULL, satisfied_by_artifact_id = NULL, satisfied_at = NULL, failure_reason = COALESCE(?, failure_reason), updated_at = ? WHERE id = ?",
			[failureReason ?? null, now, id],
		);
	}

	async invalidateTaskForPendingRequirement(input: {
		taskId: string;
		requirementId: string;
		reason?: string;
	}): Promise<boolean> {
		const task = await this.getTask(input.taskId);
		if (!task) return false;
		if (["cancelled", "archived"].includes(task.status)) return false;
		if (task.status === "waiting_dependency") return false;
		await this.updateTaskStatus(task.id, "waiting_dependency", {
			metadata: {
				requirementId: input.requirementId,
				reason: input.reason ?? "Requirement reset",
				source: "requirement_invalidation",
				previousStatus: task.status,
			},
		});
		await this.recordEvent({
			runId: task.run_id,
			taskId: task.id,
			eventType: "task_invalidated_by_requirement",
			message: `Task returned to waiting_dependency because a requirement was reset: ${input.reason ?? input.requirementId}`,
			metadata: {
				requirementId: input.requirementId,
				previousStatus: task.status,
			},
		});
		await this.reopenRunForPendingWork(task.run_id, {
			currentPhase: "waiting_dependency",
			reason: "Workflow reopened because a task requirement was reset.",
		});
		return true;
	}

	async findVerifiedArtifact(input: {
		runId: string;
		artifactKey?: string | null;
		artifactType?: string | null;
	}): Promise<WorkflowArtifactRecord | null> {
		const where = ["run_id = ?", "exists_verified = 1"];
		const params: unknown[] = [input.runId];
		if (input.artifactKey) {
			where.push("artifact_key = ?");
			params.push(input.artifactKey);
		}
		if (input.artifactType) {
			where.push("artifact_type = ?");
			params.push(input.artifactType);
		}
		return (
			(await this.db.get<WorkflowArtifactRecord>(
				`SELECT * FROM agent_workflow_artifacts WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 1`,
				params,
			)) ?? null
		);
	}

	async claimTask(input: {
		taskId: string;
		agentId: string;
		armKey?: string | null;
		leaseTtlMs?: number;
		metadata?: Record<string, unknown>;
	}): Promise<{
		task: WorkflowTaskRecord;
		lease: WorkflowTaskLeaseRecord;
	} | null> {
		const now = new Date();
		const nowIso = now.toISOString();
		const expiresAt = new Date(
			now.getTime() + Math.max(1, input.leaseTtlMs ?? 60_000),
		).toISOString();
		const leaseToken = nanoid(24);

		return this.db.transaction(async () => {
			const claimed = await this.db.get<WorkflowTaskRecord>(
				"UPDATE agent_workflow_tasks SET status = 'running', claimed_by_agent_id = ?, claimed_by_arm_key = ?, claim_token = ?, lease_expires_at = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ? AND status = 'ready' AND (lease_expires_at IS NULL OR lease_expires_at < ?) RETURNING *",
				[
					input.agentId,
					input.armKey ?? null,
					leaseToken,
					expiresAt,
					nowIso,
					nowIso,
					input.taskId,
					nowIso,
				],
			);
			if (!claimed) return null;
			await this.db.run(
				"DELETE FROM agent_workflow_task_leases WHERE task_id = ?",
				[input.taskId],
			);
			await this.db.run(
				"INSERT INTO agent_workflow_task_leases (task_id, run_id, agent_id, arm_key, lease_token, claimed_at, expires_at, last_heartbeat_at, heartbeat_count, status, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?)",
				[
					input.taskId,
					claimed.run_id,
					input.agentId,
					input.armKey ?? null,
					leaseToken,
					nowIso,
					expiresAt,
					nowIso,
					input.metadata ? JSON.stringify(input.metadata) : null,
				],
			);
			const lease = (await this.db.get<WorkflowTaskLeaseRecord>(
				"SELECT * FROM agent_workflow_task_leases WHERE task_id = ? AND lease_token = ?",
				[input.taskId, leaseToken],
			)) as WorkflowTaskLeaseRecord;
			await this.recordEvent({
				runId: claimed.run_id,
				taskId: claimed.id,
				agentId: input.agentId,
				eventType: "task_claimed",
				message: `Task claimed by ${input.armKey ?? input.agentId}.`,
				metadata: { leaseToken, expiresAt },
			});
			return { task: claimed, lease };
		});
	}

	async heartbeatTaskLease(input: {
		taskId: string;
		leaseToken: string;
		leaseTtlMs?: number;
	}): Promise<boolean> {
		const now = new Date();
		const nowIso = now.toISOString();
		const expiresAt = new Date(
			now.getTime() + Math.max(1, input.leaseTtlMs ?? 60_000),
		).toISOString();
		return this.db.transaction(async () => {
			const lease = await this.db.get<{ task_id: string }>(
				"UPDATE agent_workflow_task_leases SET expires_at = ?, last_heartbeat_at = ?, heartbeat_count = heartbeat_count + 1 WHERE task_id = ? AND lease_token = ? AND status = 'active' AND expires_at >= ? RETURNING task_id",
				[expiresAt, nowIso, input.taskId, input.leaseToken, nowIso],
			);
			if (!lease) return false;
			const task = await this.db.get<{ id: string }>(
				"UPDATE agent_workflow_tasks SET lease_expires_at = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ? AND claim_token = ? AND status = 'running' RETURNING id",
				[expiresAt, nowIso, nowIso, input.taskId, input.leaseToken],
			);
			if (!task) throw new Error(`Task lease lost ownership: ${input.taskId}`);
			return true;
		});
	}

	async expireStaleLeases(
		options: {
			staleBefore?: string;
		} = {},
	): Promise<number> {
		const now = options.staleBefore ?? new Date().toISOString();
		const stale = await this.db.all<WorkflowTaskLeaseRecord>(
			"SELECT * FROM agent_workflow_task_leases WHERE status = 'active' AND expires_at < ?",
			[now],
		);
		for (const lease of stale) {
			await this.db.run(
				"UPDATE agent_workflow_task_leases SET status = 'expired' WHERE task_id = ? AND lease_token = ?",
				[lease.task_id, lease.lease_token],
			);
			await this.db.run(
				"UPDATE agent_workflow_tasks SET status = 'ready', claim_token = NULL, claimed_by_agent_id = NULL, claimed_by_arm_key = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND claim_token = ? AND status = 'running'",
				[now, lease.task_id, lease.lease_token],
			);
			await this.recordEvent({
				runId: lease.run_id,
				taskId: lease.task_id,
				agentId: lease.agent_id,
				eventType: "lease_expired",
				message: "Task lease expired and was returned to ready.",
				metadata: { leaseToken: lease.lease_token },
			});
		}
		return stale.length;
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
			"UPDATE agent_workflow_tasks SET status = ?, step_key = COALESCE(?, step_key), progress_signature = COALESCE(?, progress_signature), updated_at = ?, ready_at = CASE WHEN ? = 'ready' THEN ? ELSE ready_at END, completed_at = CASE WHEN ? IN ('done', 'failed', 'blocked', 'cancelled', 'partial', 'interrupted', 'timed_out') THEN ? ELSE completed_at END, claim_token = CASE WHEN ? IN ('done', 'failed', 'blocked', 'cancelled', 'partial', 'interrupted', 'timed_out', 'ready', 'waiting_dependency', 'review') THEN NULL ELSE claim_token END, lease_expires_at = CASE WHEN ? IN ('done', 'failed', 'blocked', 'cancelled', 'partial', 'interrupted', 'timed_out', 'ready', 'waiting_dependency', 'review') THEN NULL ELSE lease_expires_at END, metadata = COALESCE(?, metadata) WHERE id = ?",
			[
				status,
				options.stepKey ?? null,
				options.progressSignature ?? null,
				now,
				status,
				now,
				status,
				now,
				status,
				status,
				options.metadata ? JSON.stringify(options.metadata) : null,
				id,
			],
		);
		if (status !== "running") {
			await this.db.run(
				"UPDATE agent_workflow_task_leases SET status = CASE WHEN status = 'active' THEN 'released' ELSE status END WHERE task_id = ?",
				[id],
			);
		}
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
		artifactKey?: string;
		url?: string;
		path?: string;
		description?: string;
		existsVerified?: boolean;
		mimeType?: string;
		sizeBytes?: number;
		qualityScore?: number;
		metadata?: Record<string, unknown>;
	}): Promise<WorkflowArtifactRecord> {
		const id = nanoid(16);
		await this.db.run(
			"INSERT INTO agent_workflow_artifacts (id, run_id, task_id, agent_id, artifact_type, artifact_key, producer_task_id, url, path, description, exists_verified, mime_type, size_bytes, quality_score, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				id,
				input.runId,
				input.taskId ?? null,
				input.agentId ?? null,
				input.artifactType,
				input.artifactKey ?? null,
				input.taskId ?? null,
				input.url ?? null,
				input.path ?? null,
				input.description ?? null,
				input.existsVerified ? 1 : 0,
				input.mimeType ?? null,
				input.sizeBytes ?? null,
				input.qualityScore ?? null,
				input.metadata ? JSON.stringify(input.metadata) : null,
			],
		);
		return (await this.db.get<WorkflowArtifactRecord>(
			"SELECT * FROM agent_workflow_artifacts WHERE id = ?",
			[id],
		)) as WorkflowArtifactRecord;
	}

	async listRunArtifacts(runId: string): Promise<WorkflowArtifactRecord[]> {
		return this.db.all<WorkflowArtifactRecord>(
			"SELECT * FROM agent_workflow_artifacts WHERE run_id = ? ORDER BY created_at DESC",
			[runId],
		);
	}

	async listVerifiedArtifacts(input: {
		runId: string;
		artifactKey?: string | null;
		artifactType?: string | null;
		limit?: number;
	}): Promise<WorkflowArtifactRecord[]> {
		const where = ["run_id = ?", "exists_verified = 1"];
		const params: unknown[] = [input.runId];
		if (input.artifactKey) {
			where.push("artifact_key = ?");
			params.push(input.artifactKey);
		}
		if (input.artifactType) {
			where.push("artifact_type = ?");
			params.push(input.artifactType);
		}
		params.push(Math.max(1, Math.min(input.limit ?? 100, 500)));
		return this.db.all<WorkflowArtifactRecord>(
			`SELECT * FROM agent_workflow_artifacts WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
			params,
		);
	}

	async listTaskLeases(runId?: string): Promise<WorkflowTaskLeaseRecord[]> {
		return runId
			? this.db.all<WorkflowTaskLeaseRecord>(
					"SELECT * FROM agent_workflow_task_leases WHERE run_id = ? ORDER BY claimed_at DESC",
					[runId],
				)
			: this.db.all<WorkflowTaskLeaseRecord>(
					"SELECT * FROM agent_workflow_task_leases ORDER BY claimed_at DESC",
				);
	}

	async recordBlocker(input: {
		runId: string;
		taskId: string;
		blockerType: string;
		severity?: string;
		reason: string;
		ownerAgentId?: string;
		metadata?: Record<string, unknown>;
	}): Promise<WorkflowBlockerRecord> {
		const id = nanoid(16);
		await this.db.run(
			"INSERT INTO agent_workflow_blockers (id, run_id, task_id, blocker_type, severity, reason, owner_agent_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			[
				id,
				input.runId,
				input.taskId,
				input.blockerType,
				input.severity ?? "normal",
				input.reason,
				input.ownerAgentId ?? null,
				input.metadata ? JSON.stringify(input.metadata) : null,
			],
		);
		await this.db.run(
			"UPDATE agent_workflow_tasks SET blocked_reason = ?, updated_at = ? WHERE id = ?",
			[input.reason, new Date().toISOString(), input.taskId],
		);
		return (await this.db.get<WorkflowBlockerRecord>(
			"SELECT * FROM agent_workflow_blockers WHERE id = ?",
			[id],
		)) as WorkflowBlockerRecord;
	}

	async listRunBlockers(runId: string): Promise<WorkflowBlockerRecord[]> {
		return this.db.all<WorkflowBlockerRecord>(
			"SELECT * FROM agent_workflow_blockers WHERE run_id = ? ORDER BY opened_at DESC",
			[runId],
		);
	}

	async recordTaskComment(input: {
		runId: string;
		taskId: string;
		authorAgentId?: string;
		commentType?: string;
		body: string;
		metadata?: Record<string, unknown>;
	}): Promise<WorkflowTaskCommentRecord> {
		const id = nanoid(16);
		await this.db.run(
			"INSERT INTO agent_workflow_task_comments (id, run_id, task_id, author_agent_id, comment_type, body, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[
				id,
				input.runId,
				input.taskId,
				input.authorAgentId ?? null,
				input.commentType ?? "comment",
				input.body,
				input.metadata ? JSON.stringify(input.metadata) : null,
			],
		);
		await this.recordEvent({
			runId: input.runId,
			taskId: input.taskId,
			agentId: input.authorAgentId,
			eventType: "task_comment",
			message: input.body,
			metadata: { commentType: input.commentType ?? "comment" },
		});
		return (await this.db.get<WorkflowTaskCommentRecord>(
			"SELECT * FROM agent_workflow_task_comments WHERE id = ?",
			[id],
		)) as WorkflowTaskCommentRecord;
	}

	async listRunComments(runId: string): Promise<WorkflowTaskCommentRecord[]> {
		return this.db.all<WorkflowTaskCommentRecord>(
			"SELECT * FROM agent_workflow_task_comments WHERE run_id = ? ORDER BY created_at ASC",
			[runId],
		);
	}

	async getTaskContext(taskId: string): Promise<WorkflowTaskContext | null> {
		const task = await this.getTask(taskId);
		if (!task) return null;
		const [run, requirements, artifacts, blockers, comments, leases] =
			await Promise.all([
				this.getRun(task.run_id),
				this.listTaskRequirements(taskId),
				this.listRunArtifacts(task.run_id),
				this.listRunBlockers(task.run_id),
				this.listRunComments(task.run_id),
				this.listTaskLeases(task.run_id),
			]);
		const missingRequirements = requirements.filter(
			(requirement) =>
				requirement.status === "pending" && requirement.optional !== 1,
		);
		const artifactRequirements = requirements.filter(
			(requirement) => requirement.requirement_type === "artifact",
		);
		const matchingArtifacts = artifacts.filter((artifact) =>
			artifactRequirements.some((requirement) => {
				const keyMatches = requirement.artifact_key
					? artifact.artifact_key === requirement.artifact_key
					: true;
				const typeMatches = requirement.artifact_type
					? artifact.artifact_type === requirement.artifact_type
					: true;
				return keyMatches && typeMatches;
			}),
		);
		return {
			task,
			run,
			requirements,
			missingRequirements,
			artifacts,
			matchingArtifacts,
			blockers: blockers.filter((blocker) => blocker.task_id === taskId),
			comments: comments.filter((comment) => comment.task_id === taskId),
			leases: leases.filter((lease) => lease.task_id === taskId),
		};
	}

	async getRunDependencyEdges(
		runId: string,
	): Promise<WorkflowDependencyEdge[]> {
		const [tasks, requirements] = await Promise.all([
			this.listRunTasks(runId),
			this.listRequirements({ runId, limit: 1000 }),
		]);
		const producerByArtifactKey = new Map<string, string>();
		for (const task of tasks) {
			if (!task.produces) continue;
			try {
				const produces = JSON.parse(task.produces) as Array<{
					artifactKey?: string;
					artifact_key?: string;
				}>;
				for (const artifact of Array.isArray(produces) ? produces : []) {
					const artifactKey = artifact.artifactKey ?? artifact.artifact_key;
					if (artifactKey) producerByArtifactKey.set(artifactKey, task.id);
				}
			} catch {
				// Invalid produces metadata should not break observability.
			}
		}
		return requirements.map((requirement) => {
			const fromTaskId =
				requirement.requirement_type === "task_status"
					? requirement.required_task_id
					: requirement.requirement_type === "artifact" &&
							requirement.artifact_key
						? (producerByArtifactKey.get(requirement.artifact_key) ?? null)
						: null;
			return {
				id: `${requirement.id}:edge`,
				runId,
				fromTaskId,
				toTaskId: requirement.task_id,
				requirementId: requirement.id,
				edgeType: requirement.requirement_type,
				status: requirement.status,
				artifactKey: requirement.artifact_key,
				artifactType: requirement.artifact_type,
				requiredStatus: requirement.required_status,
				satisfiedAt: requirement.satisfied_at,
			};
		});
	}

	async getRunMetrics(runId: string): Promise<KanbanRunMetrics> {
		const tasks = await this.listRunTasks(runId);
		const byStatus: Record<string, number> = {};
		for (const task of tasks)
			byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
		const blockers = await this.listRunBlockers(runId);
		const requirements = await this.listRequirements({ runId, limit: 1000 });
		const artifacts = await this.listRunArtifacts(runId);
		const leases = await this.listTaskLeases(runId);
		const now = Date.now();
		const ageFor = (status: WorkflowStatus): number | null => {
			const ages = tasks
				.filter((task) => task.status === status)
				.map((task) => now - Date.parse(task.updated_at))
				.filter((age) => Number.isFinite(age) && age >= 0);
			return ages.length > 0 ? Math.max(...ages) : null;
		};
		const completedTasks = tasks.filter((task) =>
			["done", "archived"].includes(task.status),
		).length;
		return {
			totalTasks: tasks.length,
			byStatus,
			blockedOpen: blockers.filter((blocker) => !blocker.resolved_at).length,
			requirementsPending: requirements.filter(
				(item) => item.status === "pending",
			).length,
			requirementsSatisfied: requirements.filter(
				(item) => item.status === "satisfied",
			).length,
			verifiedArtifacts: artifacts.filter(
				(artifact) => artifact.exists_verified === 1,
			).length,
			totalArtifacts: artifacts.length,
			activeLeases: leases.filter((lease) => lease.status === "active").length,
			oldestWaitingTaskAgeMs: ageFor("waiting_dependency"),
			oldestRunningTaskAgeMs: ageFor("running"),
			completedTasks,
			completionRatio: tasks.length > 0 ? completedTasks / tasks.length : 0,
		};
	}

	async resolveTaskBlockers(taskId: string, resolution: string): Promise<void> {
		const now = new Date().toISOString();
		await this.db.run(
			"UPDATE agent_workflow_blockers SET resolved_at = ?, resolution = ? WHERE task_id = ? AND resolved_at IS NULL",
			[now, resolution, taskId],
		);
		await this.db.run(
			"UPDATE agent_workflow_tasks SET blocked_reason = NULL, updated_at = ? WHERE id = ?",
			[now, taskId],
		);
	}

	async getMissingProducedArtifacts(taskId: string): Promise<string[]> {
		const task = await this.getTask(taskId);
		if (!task?.produces) return [];
		let produces: Array<Record<string, unknown>> = [];
		try {
			const parsed = JSON.parse(task.produces);
			produces = Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
		const missing: string[] = [];
		for (const item of produces) {
			const artifactKey = item.artifactKey ?? item.artifact_key;
			const artifactType = item.artifactType ?? item.artifact_type;
			if (typeof artifactKey !== "string" || typeof artifactType !== "string") {
				continue;
			}
			const artifact = await this.findVerifiedArtifact({
				runId: task.run_id,
				artifactKey,
				artifactType,
			});
			if (!artifact) missing.push(`${artifactKey}:${artifactType}`);
		}
		return missing;
	}

	async completeRunIfAllTasksTerminal(runId: string): Promise<boolean> {
		const run = await this.getRun(runId);
		if (!run || TERMINAL_WORKFLOW_STATUSES.has(run.status)) return false;
		const tasks = await this.listRunTasks(runId);
		if (tasks.length === 0) return false;
		// A task is "settled" (won't auto-progress) when it succeeded, was
		// permanently blocked (retries exhausted), or cancelled. failed/
		// timed_out/interrupted are retried/resumed, so the run must stay open.
		const SETTLED_TASK_STATUSES = new Set<string>([
			"done",
			"archived",
			"blocked",
			"cancelled",
		]);
		const allSettled = tasks.every((task) =>
			SETTLED_TASK_STATUSES.has(task.status),
		);
		if (!allSettled) return false;
		const allSucceeded = tasks.every(
			(task) => task.status === "done" || task.status === "archived",
		);
		if (allSucceeded) {
			const openBlocker = await this.db.get<{ id: string }>(
				"SELECT id FROM agent_workflow_blockers WHERE run_id = ? AND resolved_at IS NULL LIMIT 1",
				[runId],
			);
			if (openBlocker) return false;
			await this.updateRunStatus(runId, "done", { currentPhase: "completed" });
			await this.recordEvent({
				runId,
				eventType: "workflow_completed",
				message: "All Kanban Swarm cards are done and no blockers remain.",
			});
			return true;
		}
		// Some tasks were permanently blocked or cancelled — the run can't fully
		// succeed, but it must still reach a terminal (resumable) state instead
		// of hanging in "running" forever. "partial" is resumable so the blocked
		// work can be retried later.
		await this.updateRunStatus(runId, "partial", { currentPhase: "partial" });
		await this.recordEvent({
			runId,
			eventType: "workflow_partial",
			message:
				"Some Kanban Swarm cards were blocked or cancelled. The run finished partially and can be resumed to retry the blocked work.",
		});
		return true;
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
		const nextStatus: WorkflowStatus = decision.shouldBlock
			? "blocked"
			: "ready";
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
