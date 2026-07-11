import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatManager } from "../chat/manager.js";
import { EnvVarManager } from "../config/env-manager.js";
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

	it("records and searches persistent task ledger entries", async () => {
		const conversation = await manager.createConversation({ title: "Ledger" });
		await manager.addTaskLedgerEntry({
			conversationId: conversation.id,
			objective: "Extender video del Depredador y Firulais",
			status: "completed",
			summary: "Video final concatenado e importado a la biblioteca.",
			outputs: ["/api/media/file/video-final.mp4"],
			toolNames: ["veo-video-generator", "import_media_file"],
			completedAt: "2026-05-22T00:00:00.000Z",
		});

		const recent = await manager.listTaskLedgerEntries(conversation.id);
		expect(recent).toHaveLength(1);
		expect(recent[0]?.status).toBe("completed");
		expect(recent[0]?.outputs).toContain("video-final.mp4");

		const matches = await manager.searchTaskLedgerEntries(
			conversation.id,
			"ya extendiste el video del depredador?",
			{ status: "completed" },
		);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.objective).toContain("Depredador");
	});

	it("persists and updates conversation rolling context snapshots", async () => {
		const conversation = await manager.createConversation({ title: "Context" });

		await manager.saveConversationContextSnapshot(
			conversation.id,
			"[User Request] build 15 clips",
		);
		let snapshot = await manager.getConversationContextSnapshot(
			conversation.id,
		);
		expect(snapshot?.rolling_summary).toContain("15 clips");

		await manager.saveConversationContextSnapshot(
			conversation.id,
			"[User Request] build 15 clips\n[Results] 14 complete",
		);
		snapshot = await manager.getConversationContextSnapshot(conversation.id);
		expect(snapshot?.rolling_summary).toContain("14 complete");
	});

	it("persists completed tool-action receipts for safe continuation", async () => {
		const conversation = await manager.createConversation({ title: "Tools" });
		const execution = await manager.createExecution({
			conversationId: conversation.id,
		});
		const action = await manager.createToolAction({
			conversationId: conversation.id,
			executionId: execution.id,
			toolCallId: "call-image",
			toolName: "generate_image",
			argumentsJson: '{"prompt":"garden wedding"}',
			argumentsHash: "hash-1",
		});

		await manager.completeToolAction(
			action.id,
			JSON.stringify({
				success: true,
				output: "/api/media/file/wedding.png",
			}),
		);

		const reusable = await manager.findReusableToolAction({
			conversationId: conversation.id,
			executionId: "next-execution",
			toolName: "generate_image",
			argumentsHash: "hash-1",
			includePreviousExecutions: true,
		});
		expect(reusable).toMatchObject({
			id: action.id,
			status: "completed",
		});
		expect(JSON.parse(reusable?.result_json ?? "{}")).toMatchObject({
			success: true,
			output: "/api/media/file/wedding.png",
		});
	});

	it("marks in-flight tool actions uncertain after a restart", async () => {
		const conversation = await manager.createConversation({ title: "Restart" });
		const execution = await manager.createExecution({
			conversationId: conversation.id,
		});
		await manager.createToolAction({
			conversationId: conversation.id,
			executionId: execution.id,
			toolName: "generate_image",
			argumentsJson: '{"prompt":"uncertain"}',
			argumentsHash: "hash-uncertain",
		});

		await manager.markStaleExecutionsInterrupted();

		const actions = await manager.listToolActions(conversation.id);
		expect(actions[0]?.status).toBe("uncertain");
	});

	it("does not reuse failed tool actions", async () => {
		const conversation = await manager.createConversation({ title: "Retry" });
		const execution = await manager.createExecution({
			conversationId: conversation.id,
		});
		const action = await manager.createToolAction({
			conversationId: conversation.id,
			executionId: execution.id,
			toolName: "generate_image",
			argumentsJson: '{"prompt":"retry me"}',
			argumentsHash: "hash-failed",
		});
		await manager.failToolAction(action.id, "temporary provider error");

		const reusable = await manager.findReusableToolAction({
			conversationId: conversation.id,
			executionId: "next-execution",
			toolName: "generate_image",
			argumentsHash: "hash-failed",
			includePreviousExecutions: true,
		});
		expect(reusable).toBeNull();
	});

	it("round-trips semantic execution outcomes", async () => {
		const conversation = await manager.createConversation({ title: "Pending" });
		const execution = await manager.createExecution({
			conversationId: conversation.id,
		});
		await manager.updateExecution(execution.id, {
			status: "interrupted",
			completionReason: "pending_action",
			pendingAction: {
				kind: "retry_tool_call",
				summary: "Execute the promised search",
				resumable: true,
			},
		});

		const saved = await manager.getExecution(execution.id);
		expect(saved?.completion_reason).toBe("pending_action");
		expect(JSON.parse(saved?.pending_action ?? "{}")).toMatchObject({
			kind: "retry_tool_call",
			resumable: true,
		});
	});

	it("stores new secrets with authenticated encryption and reads legacy base64 secrets", async () => {
		const env = new EnvVarManager(db, { encryptionKey: "test-encryption-key" });
		await env.set("GEMINI_API_KEY", "secret-value", { isSecret: true });

		const row = await db.get<{ value: string; is_secret: number }>(
			"SELECT value, is_secret FROM env_vars WHERE key = ?",
			["GEMINI_API_KEY"],
		);
		expect(row?.is_secret).toBe(1);
		expect(row?.value).toMatch(/^enc:v1:/);
		expect(row?.value).not.toContain("secret-value");
		expect(await env.get("GEMINI_API_KEY")).toBe("secret-value");

		await db.run(
			"INSERT INTO env_vars (id, key, value, description, is_secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[
				"legacy-secret",
				"LEGACY_API_KEY",
				`enc:${Buffer.from("legacy-value", "utf-8").toString("base64")}`,
				null,
				1,
				new Date(0).toISOString(),
				new Date(0).toISOString(),
			],
		);
		expect(await env.get("LEGACY_API_KEY")).toBe("legacy-value");
	});
});
