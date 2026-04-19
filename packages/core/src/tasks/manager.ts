import { nanoid } from "nanoid";
import type { DatabaseAdapter } from "../storage/database.js";

export interface Task {
	id: string;
	title: string;
	description: string | null;
	status: string;
	priority: number;
	assigned_agent_id: string | null;
	created_by: string | null;
	parent_task_id: string | null;
	result: string | null;
	error: string | null;
	created_at: string;
	started_at: string | null;
	completed_at: string | null;
	metadata: string | null;
}

export interface CreateTaskInput {
	title: string;
	description?: string;
	priority?: number;
	assignedAgentId?: string;
	createdBy?: string;
	parentTaskId?: string;
	metadata?: Record<string, unknown>;
}

export class TaskManager {
	constructor(private db: DatabaseAdapter) {}

	async createTask(input: CreateTaskInput): Promise<Task> {
		const id = nanoid(16);
		const now = new Date().toISOString();
		const metadata = input.metadata ? JSON.stringify(input.metadata) : null;
		await this.db.run(
			"INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by, parent_task_id, result, error, created_at, started_at, completed_at, metadata) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?)",
			[
				id,
				input.title,
				input.description ?? null,
				input.priority ?? 5,
				input.assignedAgentId ?? null,
				input.createdBy ?? null,
				input.parentTaskId ?? null,
				now,
				metadata,
			],
		);
		return {
			id,
			title: input.title,
			description: input.description ?? null,
			status: "pending",
			priority: input.priority ?? 5,
			assigned_agent_id: input.assignedAgentId ?? null,
			created_by: input.createdBy ?? null,
			parent_task_id: input.parentTaskId ?? null,
			result: null,
			error: null,
			created_at: now,
			started_at: null,
			completed_at: null,
			metadata,
		};
	}

	async getTask(id: string): Promise<Task | null> {
		return (
			(await this.db.get<Task>("SELECT * FROM tasks WHERE id = ?", [id])) ??
			null
		);
	}

	async listTasks(opts?: {
		status?: string;
		agentId?: string;
		limit?: number;
		offset?: number;
	}): Promise<Task[]> {
		const limit = opts?.limit ?? 50;
		const offset = opts?.offset ?? 0;
		const conditions: string[] = [];
		const params: unknown[] = [];

		if (opts?.status) {
			conditions.push("status = ?");
			params.push(opts.status);
		}
		if (opts?.agentId) {
			conditions.push("assigned_agent_id = ?");
			params.push(opts.agentId);
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		params.push(limit, offset);
		return this.db.all<Task>(
			`SELECT * FROM tasks ${where} ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?`,
			params,
		);
	}

	async updateTask(
		id: string,
		updates: {
			status?: string;
			result?: string;
			error?: string;
			assignedAgentId?: string;
		},
	): Promise<boolean> {
		const existing = await this.getTask(id);
		if (!existing) return false;

		const fields: string[] = [];
		const values: unknown[] = [];
		const now = new Date().toISOString();

		if (updates.status !== undefined) {
			fields.push("status = ?");
			values.push(updates.status);
			if (updates.status === "running" && !existing.started_at) {
				fields.push("started_at = ?");
				values.push(now);
			}
			if (updates.status === "completed" || updates.status === "failed") {
				fields.push("completed_at = ?");
				values.push(now);
			}
		}
		if (updates.result !== undefined) {
			fields.push("result = ?");
			values.push(updates.result);
		}
		if (updates.error !== undefined) {
			fields.push("error = ?");
			values.push(updates.error);
		}
		if (updates.assignedAgentId !== undefined) {
			fields.push("assigned_agent_id = ?");
			values.push(updates.assignedAgentId);
		}

		if (fields.length === 0) return true;
		values.push(id);
		await this.db.run(
			`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`,
			values,
		);
		return true;
	}

	async deleteTask(id: string): Promise<boolean> {
		const existing = await this.getTask(id);
		if (!existing) return false;
		await this.db.run("DELETE FROM tasks WHERE parent_task_id = ?", [id]);
		await this.db.run("DELETE FROM tasks WHERE id = ?", [id]);
		return true;
	}

	async getSubTasks(parentId: string): Promise<Task[]> {
		return this.db.all<Task>(
			"SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC",
			[parentId],
		);
	}

	async getTasksByAgent(agentId: string): Promise<Task[]> {
		return this.db.all<Task>(
			"SELECT * FROM tasks WHERE assigned_agent_id = ? ORDER BY created_at DESC",
			[agentId],
		);
	}

	async getTaskStats(): Promise<Record<string, number>> {
		const rows = await this.db.all<{ status: string; cnt: number }>(
			"SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status",
		);
		const stats: Record<string, number> = {
			pending: 0,
			running: 0,
			completed: 0,
			failed: 0,
			total: 0,
		};
		let total = 0;
		for (const row of rows) {
			stats[row.status] = row.cnt;
			total += row.cnt;
		}
		stats.total = total;
		return stats;
	}
}
