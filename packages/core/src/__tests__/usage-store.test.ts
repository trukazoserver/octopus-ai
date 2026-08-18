import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageStore } from "../ai/usage-store.js";
import { estimateCostWithSource } from "../ai/pricing.js";
import {
	type DatabaseAdapter,
	createDatabaseAdapter,
} from "../storage/database.js";

describe("UsageStore multimedia ledger", () => {
	let db: DatabaseAdapter | undefined;
	const tempDirs: string[] = [];

	afterEach(async () => {
		await db?.close();
		db = undefined;
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("upserts media usage durably without duplicating accepted jobs", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const store = new UsageStore(db);

		await store.recordMedia({
			id: "video:job-1",
			mediaType: "video",
			provider: "vertex",
			model: "veo-test",
			transport: "video-lro",
			status: "accepted",
			jobId: "job-1",
			requestedOutputs: 2,
			requestedDurationSeconds: 16,
		});
		await store.recordMedia({
			id: "video:job-1",
			mediaType: "video",
			provider: "vertex",
			model: "veo-test",
			transport: "video-lro",
			status: "succeeded",
			jobId: "job-1",
			requestedOutputs: 2,
			outputCount: 2,
			requestedDurationSeconds: 16,
			generatedDurationSeconds: 16,
			estimatedCost: 1.25,
			costSource: "test",
		});
		await store.recordMedia({
			id: "image:req-1",
			mediaType: "image",
			provider: "gemini",
			model: "image-test",
			status: "unknown",
			requestedOutputs: 1,
		});
		await store.recordMedia({
			id: "video:job-1",
			mediaType: "video",
			provider: "vertex",
			model: "veo-test",
			status: "unknown",
			jobId: "job-1",
			requestedOutputs: 2,
			outputCount: 0,
		});

		const count = await db.get<{ count: number }>(
			"SELECT COUNT(*) AS count FROM multimedia_usage_events",
		);
		expect(count?.count).toBe(2);
		const total = await store.mediaAggregate();
		expect(total).toMatchObject({
			requests: 2,
			outputs: 2,
			requestedOutputs: 3,
			generatedDurationSeconds: 16,
			knownCost: 1.25,
			unknownCostEvents: 1,
		});
		expect((await store.mediaAggregate({ mediaType: "video" })).requests).toBe(1);
		expect(
			await db.get<{ status: string; output_count: number }>(
				"SELECT status, output_count FROM multimedia_usage_events WHERE id = ?",
				["video:job-1"],
			),
		).toEqual({ status: "succeeded", output_count: 2 });
	});

	it("combines LLM and multimedia events into series and exports", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const store = new UsageStore(db);
		await db.run(
			`INSERT INTO ai_usage_events
				(provider, model, prompt_tokens, completion_tokens, reasoning_tokens, total_tokens, estimated_cost)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			["openai", "test-model", 10, 5, 2, 17, 0.01],
		);
		await store.recordMedia({
			id: "image:req-2",
			mediaType: "image",
			provider: "openai",
			model: "gpt-image-test",
			status: "succeeded",
			requestedOutputs: 1,
			outputCount: 1,
		});

		const series = await store.timeSeries();
		expect(series).toHaveLength(1);
		expect(series[0]).toMatchObject({
			llmRequests: 1,
			totalTokens: 17,
			mediaRequests: 1,
			mediaOutputs: 1,
			mediaUnknownCostEvents: 1,
		});
		const { rows, truncated } = await store.exportRows();
		expect(truncated).toBe(false);
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.category === "llm")).toMatchObject({
			provider: "openai",
			totalTokens: 17,
			costKnown: true,
		});
		expect(rows.find((row) => row.category === "multimedia")).toMatchObject({
			mediaType: "image",
			outputCount: 1,
			costKnown: false,
		});
	});

	it("deduplicates LLM event ids durably and exposes unknown costs", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const store = new UsageStore(db);
		const event = {
			eventId: "llm-call-1",
			provider: "unknown-provider",
			model: "unknown-model",
			promptTokens: 10,
			completionTokens: 5,
			totalTokens: 15,
			estimatedCost: 0,
			costSource: "unknown" as const,
		};
		store.record(event);
		store.record(event);
		await store.drain();

		const total = await store.aggregate();
		expect(total).toMatchObject({
			requests: 1,
			totalTokens: 15,
			totalCost: 0,
			unknownCostEvents: 1,
		});
	});

	it("replays failed LLM writes from a durable spool after restart", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const database = db;
		const failingDb: DatabaseAdapter = {
			initialize: () => database.initialize(),
			close: () => database.close(),
			run: (sql, params) =>
				sql.includes("INSERT INTO ai_usage_events")
					? Promise.reject(new Error("database unavailable"))
					: database.run(sql, params),
			get: <T>(sql: string, params?: unknown[]) => database.get<T>(sql, params),
			all: <T>(sql: string, params?: unknown[]) => database.all<T>(sql, params),
			transaction: <T>(fn: () => Promise<T>) => database.transaction(fn),
			currentTime: () => database.currentTime(),
			flush: () => database.flush?.() ?? Promise.resolve(),
		};
		const tempDir = mkdtempSync(join(tmpdir(), "octopus-usage-spool-"));
		tempDirs.push(tempDir);
		const spoolPath = join(tempDir, "usage-outbox");
		const failingStore = new UsageStore(failingDb, { spoolPath });
		failingStore.record({
			eventId: "llm-spooled-call",
			provider: "openai",
			model: "gpt-test",
			promptTokens: 4,
			completionTokens: 2,
			totalTokens: 6,
			estimatedCost: 0.01,
			costSource: "catalog-estimate",
		});
		const pendingFiles = readdirSync(spoolPath);
		expect(pendingFiles).toHaveLength(1);
		expect(readFileSync(join(spoolPath, pendingFiles[0] as string), "utf8")).toContain(
			"llm-spooled-call",
		);

		await expect(failingStore.drain()).rejects.toThrow(
			"Usage events could not be persisted",
		);
		expect(readdirSync(spoolPath)).toHaveLength(1);

		const recoveredStore = new UsageStore(database, { spoolPath });
		await recoveredStore.replaySpool();

		expect(
			await database.get<{ count: number }>(
				"SELECT COUNT(*) AS count FROM ai_usage_events WHERE event_id = ?",
				["llm-spooled-call"],
			),
		).toEqual({ count: 1 });
		expect(readdirSync(spoolPath)).toEqual([]);
	});

	it("flushes SQL.js before acknowledging the durable usage outbox", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "octopus-usage-sqljs-"));
		tempDirs.push(tempDir);
		const databasePath = join(tempDir, "usage.db");
		const spoolPath = join(tempDir, "usage-outbox");
		db = createDatabaseAdapter("sqlite", {
			path: databasePath,
			sqliteDriver: "sqljs",
		});
		await db.initialize();
		const store = new UsageStore(db, { spoolPath });
		store.record({
			eventId: "sqljs-durable-call",
			provider: "gemini",
			promptTokens: 3,
			completionTokens: 2,
			totalTokens: 5,
			estimatedCost: 0,
			costSource: "unknown",
		});
		await store.drain();
		expect(readdirSync(spoolPath)).toEqual([]);
		await db.close();

		db = createDatabaseAdapter("sqlite", {
			path: databasePath,
			sqliteDriver: "sqljs",
		});
		await db.initialize();
		expect(
			await db.get<{ count: number }>(
				"SELECT COUNT(*) AS count FROM ai_usage_events WHERE event_id = ?",
				["sqljs-durable-call"],
			),
		).toEqual({ count: 1 });
	});

	it("does not invent provider-default pricing for unknown models", () => {
		expect(
			estimateCostWithSource("openai", "future-unknown-model", 1000, 1000),
		).toEqual({ cost: 0, source: "unknown" });
		expect(
			estimateCostWithSource("openai", "gpt-5.4-mini", 1_000_000, 0),
		).toEqual({ cost: 0.75, source: "catalog-estimate" });
	});

	it("reconciles completed and failed image accounting from durable tool receipts", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const store = new UsageStore(db);
		await store.recordMedia({
			id: "image:receipt:route:1",
			mediaType: "image",
			provider: "openai",
			model: "gpt-image-test",
			status: "unknown",
		});
		const now = new Date().toISOString();
		await db.run(
			`INSERT INTO chat_tool_actions
				(id, conversation_id, execution_id, tool_name, arguments_json,
				 arguments_hash, status, result_json, started_at, updated_at, completed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"action-1",
				"conversation-1",
				"execution-1",
				"generate_image",
				"{}",
				"hash",
				"completed",
				JSON.stringify({
					success: true,
					metadata: {
						usageReceipt: {
							id: "image:receipt:route:1",
							mediaType: "image",
							provider: "openai",
							model: "gpt-image-test",
							status: "succeeded",
							requestedOutputs: 1,
							outputCount: 1,
						},
					},
				}),
				now,
				now,
				now,
			],
		);
		await db.run(
			`INSERT INTO chat_tool_actions
				(id, conversation_id, execution_id, tool_name, arguments_json,
				 arguments_hash, status, result_json, started_at, updated_at, completed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"action-2",
				"conversation-1",
				"execution-1",
				"generate_image",
				"{}",
				"failed-hash",
				"failed",
				JSON.stringify({
					success: false,
					metadata: {
						usageReceipts: [{
							id: "image:failed-receipt:route:1",
							mediaType: "image",
							provider: "gemini",
							model: "image-test",
							status: "failed",
							requestedOutputs: 1,
							outputCount: 0,
						}],
					},
				}),
				now,
				now,
				now,
			],
		);

		await store.reconcileImageToolReceipts();

		expect(
			await db.get<{ status: string; output_count: number }>(
				"SELECT status, output_count FROM multimedia_usage_events WHERE id = ?",
				["image:receipt:route:1"],
			),
		).toEqual({ status: "succeeded", output_count: 1 });
		expect(
			await db.get<{ status: string; output_count: number }>(
				"SELECT status, output_count FROM multimedia_usage_events WHERE id = ?",
				["image:failed-receipt:route:1"],
			),
		).toEqual({ status: "failed", output_count: 0 });
	});
});
