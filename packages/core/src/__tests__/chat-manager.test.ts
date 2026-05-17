import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatManager } from "../chat/manager.js";
import {
	type DatabaseAdapter,
	createDatabaseAdapter,
} from "../storage/database.js";

describe("ChatManager", () => {
	let db: DatabaseAdapter;
	let manager: ChatManager;

	beforeEach(async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		manager = new ChatManager(db);
	});

	afterEach(async () => {
		await db.close();
	});

	it("returns the most recent messages in chronological order when recent=true", async () => {
		const conversation = await manager.createConversation({ title: "Test" });
		const baseTime = new Date("2026-01-01T00:00:00.000Z");

		for (let i = 0; i < 5; i++) {
			await db.run(
				"INSERT INTO messages (id, conversation_id, role, content, timestamp, metadata, model, tokens, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					`m${i + 1}`,
					conversation.id,
					i % 2 === 0 ? "user" : "assistant",
					`message-${i + 1}`,
					new Date(baseTime.getTime() + i * 60_000).toISOString(),
					null,
					null,
					null,
					null,
				],
			);
		}

		const messages = await manager.getConversationMessages(conversation.id, {
			limit: 3,
			recent: true,
		});

		expect(messages.map((message) => message.content)).toEqual([
			"message-3",
			"message-4",
			"message-5",
		]);
	});

	it("keeps the default oldest-first pagination when recent is not requested", async () => {
		const conversation = await manager.createConversation({ title: "Test" });
		const baseTime = new Date("2026-01-01T00:00:00.000Z");

		for (let i = 0; i < 5; i++) {
			await db.run(
				"INSERT INTO messages (id, conversation_id, role, content, timestamp, metadata, model, tokens, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					`d${i + 1}`,
					conversation.id,
					"user",
					`message-${i + 1}`,
					new Date(baseTime.getTime() + i * 60_000).toISOString(),
					null,
					null,
					null,
					null,
				],
			);
		}

		const messages = await manager.getConversationMessages(conversation.id, {
			limit: 3,
		});

		expect(messages.map((message) => message.content)).toEqual([
			"message-1",
			"message-2",
			"message-3",
		]);
	});
});
