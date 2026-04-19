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
		opts?: { limit?: number; offset?: number },
	): Promise<ChatMessage[]> {
		const limit = opts?.limit ?? 100;
		const offset = opts?.offset ?? 0;
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
}
