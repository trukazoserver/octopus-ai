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
	started_at: string;
	updated_at: string;
	completed_at: string | null;
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
		await this.db.run("DELETE FROM messages WHERE conversation_id = ?", [id]);
		await this.db.run("DELETE FROM conversations WHERE id = ?", [id]);
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
		const likeQuery = `%${query}%`;
		const convIds = await this.db.all<{ conversation_id: string }>(
			"SELECT DISTINCT conversation_id FROM messages WHERE content LIKE ? LIMIT 20",
			[likeQuery],
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
		const likeQuery = `%${query}%`;
		const limit = opts?.limit ?? 20;
		const offset = opts?.offset ?? 0;
		if (opts?.conversationId) {
			return this.db.all<ChatMessage>(
				`SELECT * FROM messages
				WHERE conversation_id = ? AND content LIKE ?
				ORDER BY timestamp ASC
				LIMIT ? OFFSET ?`,
				[opts.conversationId, likeQuery, limit, offset],
			);
		}

		return this.db.all<ChatMessage>(
			`SELECT * FROM messages
			WHERE content LIKE ?
			ORDER BY timestamp DESC
			LIMIT ? OFFSET ?`,
			[likeQuery, limit, offset],
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
				(id, request_id, conversation_id, agent_id, status, current_status, activities, assistant_message_id, error, started_at, updated_at, completed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			started_at: now,
			updated_at: now,
			completed_at: null,
		};
	}

	async updateExecution(
		id: string,
		updates: {
			status?: ChatExecutionStatus;
			currentStatus?: string | null;
			activities?: ChatExecutionActivity[];
			assistantMessageId?: string | null;
			error?: string | null;
			completedAt?: string | null;
		},
	): Promise<void> {
		const current = await this.getExecution(id);
		if (!current) return;
		const now = new Date().toISOString();
		await this.db.run(
			`UPDATE chat_executions SET
				status = ?,
				current_status = ?,
				activities = ?,
				assistant_message_id = ?,
				error = ?,
				updated_at = ?,
				completed_at = ?
				WHERE id = ?`,
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
				now,
				updates.completedAt !== undefined
					? updates.completedAt
					: current.completed_at,
				id,
			],
		);
		await this.db.flush?.();
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

	async listActiveExecutions(): Promise<ChatExecution[]> {
		return this.db.all<ChatExecution>(
			"SELECT * FROM chat_executions WHERE status IN ('queued', 'running') ORDER BY updated_at DESC",
		);
	}

	async markStaleExecutionsInterrupted(): Promise<void> {
		const now = new Date().toISOString();
		await this.db.run(
			`UPDATE chat_executions
				SET status = 'interrupted', error = COALESCE(error, 'Server restarted while execution was active'), updated_at = ?, completed_at = ?
				WHERE status IN ('queued', 'running')`,
			[now, now],
		);
		await this.db.flush?.();
	}
}
