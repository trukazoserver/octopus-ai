import { nanoid } from "nanoid";
import type { DatabaseAdapter } from "../storage/database.js";

export interface Conversation {
	id: string;
	title: string | null;
	channel: string | null;
	agent_id: string | null;
	created_at: string;
	updated_at: string;
}

export interface ChatMessage {
	id: string;
	conversation_id: string;
	role: string;
	content: string;
	timestamp: string;
	metadata: string | null;
	model: string | null;
	tokens: number | null;
	parent_id: string | null;
}

export type ChatExecutionStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";

export type ChatCompletionReason =
	| "finished"
	| "pending_action"
	| "failed"
	| "cancelled"
	| "server_restart";

export interface ChatPendingAction {
	kind:
		| "continue"
		| "retry_tool_call"
		| "verify_tool_action"
		| "user_input"
		| "manual_action"
		| "background_work";
	summary: string;
	resumable: boolean;
	toolActionId?: string;
	toolName?: string;
	workflowRunId?: string;
}

export interface ChatExecutionActivity {
	id: string;
	status: string;
	toolName?: string | null;
	uiIconB64?: string | null;
	activityDetail?: string | null;
	timestamp: number;
}

export interface ChatExecution {
	id: string;
	request_id: string | null;
	conversation_id: string;
	agent_id: string | null;
	status: ChatExecutionStatus;
	current_status: string | null;
	activities: string | null;
	assistant_message_id: string | null;
	error: string | null;
	completion_reason: ChatCompletionReason | null;
	pending_action: string | null;
	started_at: string;
	updated_at: string;
	completed_at: string | null;
}

export interface ConversationContextSnapshot {
	conversation_id: string;
	rolling_summary: string;
	created_at: string;
	updated_at: string;
}

export interface ChatTaskLedgerEntry {
	id: string;
	conversation_id: string;
	objective: string;
	status: "completed" | "partial" | "failed" | "pending";
	summary: string | null;
	outputs: string | null;
	tool_names: string | null;
	source_message_id: string | null;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
}

export type ChatToolActionStatus =
	| "running"
	| "completed"
	| "failed"
	| "uncertain";

export interface ChatToolAction {
	id: string;
	conversation_id: string;
	execution_id: string;
	tool_call_id: string | null;
	tool_name: string;
	arguments_json: string;
	arguments_hash: string;
	status: ChatToolActionStatus;
	result_json: string | null;
	error: string | null;
	started_at: string;
	updated_at: string;
	completed_at: string | null;
}

const SEARCH_STOPWORDS = new Set([
	"acuerdas",
	"recuerdas",
	"recordar",
	"recuerdo",
	"como",
	"dije",
	"dijiste",
	"digo",
	"dijimos",
	"deben",
	"debe",
	"hacer",
	"hacen",
	"sobre",
	"algo",
	"otra",
	"otro",
	"conversacion",
	"conversación",
	"hablamos",
	"hablar",
	"the",
	"and",
	"for",
	"with",
	"that",
	"this",
]);

function getSearchTerms(query: string): string[] {
	const terms = query
		.toLowerCase()
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.split(/[^a-z0-9_/-]+/i)
		.map((term) => term.trim())
		.filter((term) => term.length >= 3 && !SEARCH_STOPWORDS.has(term));
	return [...new Set(terms)].slice(0, 8);
}

function taskSearchTerms(query: string): string[] {
	return getSearchTerms(query)
		.filter((term) => term.length >= 4)
		.slice(0, 10);
}

export class ChatManager {
	constructor(private db: DatabaseAdapter) {}

	async createConversation(opts?: {
		title?: string;
		channel?: string;
		agentId?: string;
	}): Promise<Conversation> {
		const id = nanoid(16);
		const now = new Date().toISOString();
		const title = opts?.title ?? null;
		const channel = opts?.channel ?? null;
		const agentId = opts?.agentId ?? null;
		await this.db.run(
			"INSERT INTO conversations (id, title, channel, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			[id, title, channel, agentId, now, now],
		);
		return {
			id,
			title,
			channel,
			agent_id: agentId,
			created_at: now,
			updated_at: now,
		};
	}

	async addMessage(
		conversationId: string,
		role: string,
		content: string,
		opts?: {
			metadata?: Record<string, unknown>;
			model?: string;
			tokens?: number;
			parentId?: string;
		},
	): Promise<ChatMessage> {
		const id = nanoid(16);
		const now = new Date().toISOString();
		const metadata = opts?.metadata ? JSON.stringify(opts.metadata) : null;
		await this.db.run(
			"INSERT INTO messages (id, conversation_id, role, content, timestamp, metadata, model, tokens, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				id,
				conversationId,
				role,
				content,
				now,
				metadata,
				opts?.model ?? null,
				opts?.tokens ?? null,
				opts?.parentId ?? null,
			],
		);
		await this.db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", [
			now,
			conversationId,
		]);
		await this.db.flush?.();
		return {
			id,
			conversation_id: conversationId,
			role,
			content,
			timestamp: now,
			metadata,
			model: opts?.model ?? null,
			tokens: opts?.tokens ?? null,
			parent_id: opts?.parentId ?? null,
		};
	}

	async updateMessage(
		messageId: string,
		content: string,
		opts?: {
			metadata?: Record<string, unknown>;
			model?: string;
			tokens?: number;
		},
	): Promise<void> {
		const now = new Date().toISOString();
		const metadata = opts?.metadata ? JSON.stringify(opts.metadata) : null;
		await this.db.run(
			"UPDATE messages SET content = ?, metadata = ?, model = COALESCE(?, model), tokens = COALESCE(?, tokens) WHERE id = ?",
			[content, metadata, opts?.model ?? null, opts?.tokens ?? null, messageId],
		);
		const row = await this.db.get<{ conversation_id: string }>(
			"SELECT conversation_id FROM messages WHERE id = ?",
			[messageId],
		);
		if (row?.conversation_id) {
			await this.db.run(
				"UPDATE conversations SET updated_at = ? WHERE id = ?",
				[now, row.conversation_id],
			);
		}
		await this.db.flush?.();
	}

	async getMessage(id: string): Promise<ChatMessage | null> {
		const message = await this.db.get<ChatMessage>(
			"SELECT * FROM messages WHERE id = ?",
			[id],
		);
		return message ?? null;
	}

	async getConversation(
		id: string,
	): Promise<(Conversation & { messages: ChatMessage[] }) | null> {
		const conv = await this.db.get<Conversation>(
			"SELECT * FROM conversations WHERE id = ?",
			[id],
		);
		if (!conv) return null;
		const messages = await this.db.all<ChatMessage>(
			"SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC",
			[id],
		);
		return { ...conv, messages };
	}

	async getConversationMetadata(id: string): Promise<Conversation | null> {
		return (
			(await this.db.get<Conversation>("SELECT * FROM conversations WHERE id = ?", [id])) ??
			null
		);
	}

	async listConversations(opts?: {
		limit?: number;
		offset?: number;
		agentId?: string;
	}): Promise<Conversation[]> {
		const limit = opts?.limit ?? 50;
		const offset = opts?.offset ?? 0;
		if (opts?.agentId) {
			return this.db.all<Conversation>(
				"SELECT * FROM conversations WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
				[opts.agentId, limit, offset],
			);
		}
		return this.db.all<Conversation>(
			"SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ? OFFSET ?",
			[limit, offset],
		);
	}

	async deleteConversation(id: string): Promise<void> {
		await this.db.transaction(async () => {
			await this.db.run(
				"DELETE FROM chat_tool_actions WHERE conversation_id = ?",
				[id],
			);
			await this.db.run(
				"DELETE FROM chat_executions WHERE conversation_id = ?",
				[id],
			);
			await this.db.run("DELETE FROM messages WHERE conversation_id = ?", [id]);
			await this.db.run("DELETE FROM conversations WHERE id = ?", [id]);
		});
	}

	async updateConversation(
		id: string,
		updates: { title?: string; agentId?: string },
	): Promise<void> {
		const now = new Date().toISOString();
		if (updates.title !== undefined) {
			await this.db.run(
				"UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
				[updates.title, now, id],
			);
		}
		if (updates.agentId !== undefined) {
			await this.db.run(
				"UPDATE conversations SET agent_id = ?, updated_at = ? WHERE id = ?",
				[updates.agentId, now, id],
			);
		}
	}

	async getConversationMessages(
		conversationId: string,
		opts?: { limit?: number; offset?: number; recent?: boolean },
	): Promise<ChatMessage[]> {
		const limit = opts?.limit ?? 100;
		const offset = opts?.offset ?? 0;
		if (opts?.recent) {
			return this.db.all<ChatMessage>(
				`SELECT * FROM (
					SELECT * FROM messages
					WHERE conversation_id = ?
					ORDER BY timestamp DESC
					LIMIT ? OFFSET ?
				) recent_messages
				ORDER BY timestamp ASC`,
				[conversationId, limit, offset],
			);
		}
		return this.db.all<ChatMessage>(
			"SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC LIMIT ? OFFSET ?",
			[conversationId, limit, offset],
		);
	}

	async searchConversations(query: string): Promise<Conversation[]> {
		const likeQuery = `%${query.toLowerCase()}%`;
		const terms = getSearchTerms(query);
		const whereParts = ["LOWER(content) LIKE ?"];
		const params: unknown[] = [likeQuery];
		for (const term of terms) {
			whereParts.push("LOWER(content) LIKE ?");
			params.push(`%${term}%`);
		}
		const convIds = await this.db.all<{ conversation_id: string }>(
			`SELECT DISTINCT conversation_id FROM messages WHERE (${whereParts.join(" OR ")}) LIMIT 20`,
			params,
		);
		if (convIds.length === 0) return [];
		const ids = convIds.map((r) => r.conversation_id);
		const placeholders = ids.map(() => "?").join(",");
		return this.db.all<Conversation>(
			`SELECT * FROM conversations WHERE id IN (${placeholders}) ORDER BY updated_at DESC`,
			ids,
		);
	}

	async searchMessages(
		query: string,
		opts?: { conversationId?: string; limit?: number; offset?: number },
	): Promise<ChatMessage[]> {
		const likeQuery = `%${query.toLowerCase()}%`;
		const terms = getSearchTerms(query);
		const whereParts = ["LOWER(content) LIKE ?"];
		const whereParams: unknown[] = [likeQuery];
		for (const term of terms) {
			whereParts.push("LOWER(content) LIKE ?");
			whereParams.push(`%${term}%`);
		}
		const whereClause = `(${whereParts.join(" OR ")})`;
		const limit = opts?.limit ?? 20;
		const offset = opts?.offset ?? 0;
		if (opts?.conversationId) {
			return this.db.all<ChatMessage>(
				`SELECT * FROM messages
				WHERE conversation_id = ? AND ${whereClause}
				ORDER BY CASE WHEN LOWER(content) LIKE ? THEN 0 ELSE 1 END, timestamp ASC
				LIMIT ? OFFSET ?`,
				[opts.conversationId, ...whereParams, likeQuery, limit, offset],
			);
		}

		return this.db.all<ChatMessage>(
			`SELECT * FROM messages
			WHERE ${whereClause}
			ORDER BY CASE WHEN LOWER(content) LIKE ? THEN 0 ELSE 1 END, timestamp DESC
			LIMIT ? OFFSET ?`,
			[...whereParams, likeQuery, limit, offset],
		);
	}

	async addTaskLedgerEntry(opts: {
		conversationId: string;
		objective: string;
		status: ChatTaskLedgerEntry["status"];
		summary?: string;
		outputs?: string[];
		toolNames?: string[];
		sourceMessageId?: string;
		completedAt?: string;
	}): Promise<ChatTaskLedgerEntry> {
		const id = nanoid(16);
		const now = new Date().toISOString();
		const outputs = opts.outputs?.length ? JSON.stringify(opts.outputs) : null;
		const toolNames = opts.toolNames?.length
			? JSON.stringify(opts.toolNames)
			: null;
		await this.db.run(
			`INSERT INTO chat_task_ledger
				(id, conversation_id, objective, status, summary, outputs, tool_names, source_message_id, created_at, updated_at, completed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				opts.conversationId,
				opts.objective,
				opts.status,
				opts.summary ?? null,
				outputs,
				toolNames,
				opts.sourceMessageId ?? null,
				now,
				now,
				opts.completedAt ?? null,
			],
		);
		await this.db.flush?.();
		return {
			id,
			conversation_id: opts.conversationId,
			objective: opts.objective,
			status: opts.status,
			summary: opts.summary ?? null,
			outputs,
			tool_names: toolNames,
			source_message_id: opts.sourceMessageId ?? null,
			created_at: now,
			updated_at: now,
			completed_at: opts.completedAt ?? null,
		};
	}

	async listTaskLedgerEntries(
		conversationId: string,
		opts?: { limit?: number; status?: ChatTaskLedgerEntry["status"] },
	): Promise<ChatTaskLedgerEntry[]> {
		const limit = opts?.limit ?? 12;
		if (opts?.status) {
			return this.db.all<ChatTaskLedgerEntry>(
				`SELECT * FROM chat_task_ledger
				WHERE conversation_id = ? AND status = ?
				ORDER BY updated_at DESC LIMIT ?`,
				[conversationId, opts.status, limit],
			);
		}
		return this.db.all<ChatTaskLedgerEntry>(
			`SELECT * FROM chat_task_ledger
			WHERE conversation_id = ?
			ORDER BY updated_at DESC LIMIT ?`,
			[conversationId, limit],
		);
	}

	async searchTaskLedgerEntries(
		conversationId: string,
		query: string,
		opts?: { limit?: number; status?: ChatTaskLedgerEntry["status"] },
	): Promise<ChatTaskLedgerEntry[]> {
		const limit = opts?.limit ?? 8;
		const terms = taskSearchTerms(query);
		if (terms.length === 0) {
			return this.listTaskLedgerEntries(conversationId, {
				limit,
				status: opts?.status,
			});
		}
		const whereParts = terms.flatMap(() => [
			"LOWER(objective) LIKE ?",
			"LOWER(COALESCE(summary, '')) LIKE ?",
			"LOWER(COALESCE(outputs, '')) LIKE ?",
		]);
		const params = terms.flatMap((term) => [
			`%${term}%`,
			`%${term}%`,
			`%${term}%`,
		]);
		const statusClause = opts?.status ? "AND status = ?" : "";
		const statusParams = opts?.status ? [opts.status] : [];
		return this.db.all<ChatTaskLedgerEntry>(
			`SELECT * FROM chat_task_ledger
			WHERE conversation_id = ? ${statusClause} AND (${whereParts.join(" OR ")})
			ORDER BY updated_at DESC LIMIT ?`,
			[conversationId, ...statusParams, ...params, limit],
		);
	}

	async createExecution(opts: {
		requestId?: string;
		conversationId: string;
		agentId?: string;
		status?: ChatExecutionStatus;
	}): Promise<ChatExecution> {
		const id = nanoid(16);
		const now = new Date().toISOString();
		const status = opts.status ?? "queued";
		await this.db.run(
			`INSERT INTO chat_executions
				(id, request_id, conversation_id, agent_id, status, current_status, activities, assistant_message_id, error, completion_reason, pending_action, started_at, updated_at, completed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				opts.requestId ?? null,
				opts.conversationId,
				opts.agentId ?? null,
				status,
				null,
				JSON.stringify([]),
				null,
				null,
				null,
				null,
				now,
				now,
				null,
			],
		);
		await this.db.flush?.();
		return {
			id,
			request_id: opts.requestId ?? null,
			conversation_id: opts.conversationId,
			agent_id: opts.agentId ?? null,
			status,
			current_status: null,
			activities: JSON.stringify([]),
			assistant_message_id: null,
			error: null,
			completion_reason: null,
			pending_action: null,
			started_at: now,
			updated_at: now,
			completed_at: null,
		};
	}

	async createToolAction(opts: {
		conversationId: string;
		executionId: string;
		toolCallId?: string;
		toolName: string;
		argumentsJson: string;
		argumentsHash: string;
	}): Promise<ChatToolAction> {
		const id = nanoid(16);
		const now = new Date().toISOString();
		await this.db.run(
			`INSERT INTO chat_tool_actions
				(id, conversation_id, execution_id, tool_call_id, tool_name, arguments_json, arguments_hash, status, result_json, error, started_at, updated_at, completed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, ?, ?, NULL)`,
			[
				id,
				opts.conversationId,
				opts.executionId,
				opts.toolCallId ?? null,
				opts.toolName,
				opts.argumentsJson,
				opts.argumentsHash,
				now,
				now,
			],
		);
		await this.db.flush?.();
		return {
			id,
			conversation_id: opts.conversationId,
			execution_id: opts.executionId,
			tool_call_id: opts.toolCallId ?? null,
			tool_name: opts.toolName,
			arguments_json: opts.argumentsJson,
			arguments_hash: opts.argumentsHash,
			status: "running",
			result_json: null,
			error: null,
			started_at: now,
			updated_at: now,
			completed_at: null,
		};
	}

	async claimToolAction(opts: {
		conversationId: string;
		executionId: string;
		toolCallId?: string;
		toolName: string;
		argumentsJson: string;
		argumentsHash: string;
	}): Promise<{ action: ChatToolAction; claimed: boolean }> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const id = nanoid(16);
			const now = new Date().toISOString();
			const inserted = await this.db.get<ChatToolAction>(
				`INSERT INTO chat_tool_actions
					(id, conversation_id, execution_id, tool_call_id, tool_name, arguments_json, arguments_hash, status, result_json, error, started_at, updated_at, completed_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, ?, ?, NULL)
					ON CONFLICT (execution_id, tool_name, arguments_hash)
					WHERE status IN ('running', 'completed', 'uncertain')
					DO NOTHING RETURNING *`,
				[
					id,
					opts.conversationId,
					opts.executionId,
					opts.toolCallId ?? null,
					opts.toolName,
					opts.argumentsJson,
					opts.argumentsHash,
					now,
					now,
				],
			);
			if (inserted) {
				await this.db.flush?.();
				return { action: inserted, claimed: true };
			}
			const existing = await this.db.get<ChatToolAction>(
				`SELECT * FROM chat_tool_actions
					WHERE execution_id = ? AND tool_name = ? AND arguments_hash = ?
						AND status IN ('running', 'completed', 'uncertain')
					ORDER BY updated_at DESC, id DESC LIMIT 1`,
				[opts.executionId, opts.toolName, opts.argumentsHash],
			);
			if (existing) return { action: existing, claimed: false };
		}
		throw new Error("Unable to claim durable tool action after concurrent retries");
	}

	async completeToolAction(id: string, resultJson: string): Promise<void> {
		const now = new Date().toISOString();
		await this.db.run(
			`UPDATE chat_tool_actions
				SET status = 'completed', result_json = ?, error = NULL, updated_at = ?, completed_at = ?
				WHERE id = ? AND status = 'running'`,
			[resultJson, now, now, id],
		);
		await this.db.flush?.();
	}

	async failToolAction(id: string, error: string): Promise<void> {
		const now = new Date().toISOString();
		await this.db.run(
			`UPDATE chat_tool_actions
				SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
				WHERE id = ? AND status = 'running'`,
			[error, now, now, id],
		);
		await this.db.flush?.();
	}

	async markToolActionUncertain(id: string, error: string): Promise<void> {
		const now = new Date().toISOString();
		await this.db.run(
			`UPDATE chat_tool_actions
				SET status = 'uncertain', error = ?, updated_at = ?, completed_at = NULL
				WHERE id = ? AND status = 'running'`,
			[error, now, id],
		);
		await this.db.flush?.();
	}

	async findReusableToolAction(opts: {
		conversationId: string;
		executionId: string;
		toolName: string;
		argumentsHash: string;
		includePreviousExecutions: boolean;
	}): Promise<ChatToolAction | null> {
		const executionClause = opts.includePreviousExecutions
			? ""
			: "AND execution_id = ?";
		const params: unknown[] = [
			opts.conversationId,
			opts.toolName,
			opts.argumentsHash,
		];
		if (!opts.includePreviousExecutions) params.push(opts.executionId);
		const action = await this.db.get<ChatToolAction>(
			`SELECT * FROM chat_tool_actions
				WHERE conversation_id = ? AND tool_name = ? AND arguments_hash = ?
					AND status IN ('completed', 'running', 'uncertain') ${executionClause}
				ORDER BY updated_at DESC LIMIT 1`,
			params,
		);
		return action ?? null;
	}

	async listToolActions(
		conversationId: string,
		opts?: {
			limit?: number;
			executionId?: string;
			status?: ChatToolActionStatus;
		},
	): Promise<ChatToolAction[]> {
		const clauses = ["conversation_id = ?"];
		const params: unknown[] = [conversationId];
		if (opts?.executionId) {
			clauses.push("execution_id = ?");
			params.push(opts.executionId);
		}
		if (opts?.status) {
			clauses.push("status = ?");
			params.push(opts.status);
		}
		params.push(opts?.limit ?? 100);
		return this.db.all<ChatToolAction>(
			`SELECT * FROM chat_tool_actions WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`,
			params,
		);
	}

	async updateExecution(
		id: string,
		updates: {
			status?: ChatExecutionStatus;
			currentStatus?: string | null;
			activities?: ChatExecutionActivity[];
			assistantMessageId?: string | null;
			error?: string | null;
			completionReason?: ChatCompletionReason | null;
			pendingAction?: ChatPendingAction | null;
			completedAt?: string | null;
			onlyIfActive?: boolean;
		},
	): Promise<boolean> {
		const current = await this.getExecution(id);
		if (!current) return false;
		const now = new Date().toISOString();
		const transitioned = await this.db.get<{ id: string }>(
			`UPDATE chat_executions SET
				status = ?,
				current_status = ?,
				activities = ?,
				assistant_message_id = ?,
				error = ?,
				completion_reason = ?,
				pending_action = ?,
				updated_at = ?,
				completed_at = ?
				WHERE id = ?${updates.onlyIfActive ? " AND status IN ('queued', 'running')" : ""}
				RETURNING id`,
			[
				updates.status ?? current.status,
				updates.currentStatus !== undefined
					? updates.currentStatus
					: current.current_status,
				updates.activities !== undefined
					? JSON.stringify(updates.activities)
					: current.activities,
				updates.assistantMessageId !== undefined
					? updates.assistantMessageId
					: current.assistant_message_id,
				updates.error !== undefined ? updates.error : current.error,
				updates.completionReason !== undefined
					? updates.completionReason
					: current.completion_reason,
				updates.pendingAction !== undefined
					? updates.pendingAction
						? JSON.stringify(updates.pendingAction)
						: null
					: current.pending_action,
				now,
				updates.completedAt !== undefined
					? updates.completedAt
					: current.completed_at,
				id,
			],
		);
		await this.db.flush?.();
		return Boolean(transitioned);
	}

	async getExecution(id: string): Promise<ChatExecution | null> {
		const execution = await this.db.get<ChatExecution>(
			"SELECT * FROM chat_executions WHERE id = ?",
			[id],
		);
		return execution ?? null;
	}

	async getActiveExecutionForConversation(
		conversationId: string,
	): Promise<ChatExecution | null> {
		const execution = await this.db.get<ChatExecution>(
			`SELECT * FROM chat_executions
				WHERE conversation_id = ? AND status IN ('queued', 'running')
				ORDER BY updated_at DESC LIMIT 1`,
			[conversationId],
		);
		return execution ?? null;
	}

	async getLatestExecutionForConversation(
		conversationId: string,
	): Promise<ChatExecution | null> {
		const execution = await this.db.get<ChatExecution>(
			"SELECT * FROM chat_executions WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 1",
			[conversationId],
		);
		return execution ?? null;
	}

	async getPreviousExecutionForConversation(
		conversationId: string,
		excludeExecutionId: string,
	): Promise<ChatExecution | null> {
		const execution = await this.db.get<ChatExecution>(
			"SELECT * FROM chat_executions WHERE conversation_id = ? AND id <> ? ORDER BY updated_at DESC LIMIT 1",
			[conversationId, excludeExecutionId],
		);
		return execution ?? null;
	}

	async listActiveExecutions(): Promise<ChatExecution[]> {
		return this.db.all<ChatExecution>(
			"SELECT * FROM chat_executions WHERE status IN ('queued', 'running') ORDER BY updated_at DESC",
		);
	}

	async markStaleExecutionsInterrupted(): Promise<void> {
		const now = new Date().toISOString();
		await this.db.run(
			`UPDATE chat_executions
				SET status = 'interrupted', completion_reason = 'server_restart', pending_action = NULL, error = COALESCE(error, 'Server restarted while execution was active'), updated_at = ?, completed_at = ?
				WHERE status IN ('queued', 'running')`,
			[now, now],
		);
		await this.db.run(
			`UPDATE chat_tool_actions SET status = 'uncertain', updated_at = ?
				WHERE status = 'running'`,
			[now],
		);
		await this.db.flush?.();
	}

	async getConversationContextSnapshot(
		conversationId: string,
	): Promise<ConversationContextSnapshot | null> {
		const snapshot = await this.db.get<ConversationContextSnapshot>(
			"SELECT * FROM conversation_context_snapshots WHERE conversation_id = ?",
			[conversationId],
		);
		return snapshot ?? null;
	}

	async saveConversationContextSnapshot(
		conversationId: string,
		rollingSummary: string,
	): Promise<void> {
		const now = new Date().toISOString();
		const existing = await this.getConversationContextSnapshot(conversationId);
		if (existing) {
			await this.db.run(
				"UPDATE conversation_context_snapshots SET rolling_summary = ?, updated_at = ? WHERE conversation_id = ?",
				[rollingSummary, now, conversationId],
			);
		} else {
			await this.db.run(
				"INSERT INTO conversation_context_snapshots (conversation_id, rolling_summary, created_at, updated_at) VALUES (?, ?, ?, ?)",
				[conversationId, rollingSummary, now, now],
			);
		}
		await this.db.flush?.();
	}
}
