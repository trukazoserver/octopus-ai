import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MemoryBenchmarkStore,
	normalizeMemoryBenchmarkSource,
	scoreMemoryBenchmarkCase,
} from "../memory/benchmark.js";
import { createDatabaseAdapter, type DatabaseAdapter } from "../storage/database.js";
import { SqliteVectorStore } from "../memory/sqlite-vss.js";
import { LongTermMemory } from "../memory/ltm.js";
import { MemoryOrchestrator } from "../memory/orchestrator.js";

describe("memory benchmark datasets", () => {
	let db: DatabaseAdapter | undefined;
	afterEach(async () => db?.close());

	it("scores ranked evidence, forbidden retrieval and abstention", () => {
		const metrics = scoreMemoryBenchmarkCase(
			["a", "b"],
			["stale"],
			["a", "a", "stale", "b"],
			3,
		);
		expect(metrics).toMatchObject({
			recallAtK: 1,
			precisionAtK: 2 / 3,
			hitAtK: 1,
			recallAllAtK: 1,
			reciprocalRank: 1,
			forbiddenCaseHit: 1,
		});
		expect(metrics.ndcgAtK).toBeGreaterThan(0.8);
		expect(scoreMemoryBenchmarkCase([], [], [], 5).abstentionSuccess).toBe(1);
	});

	it("normalizes LongMemEval, MemOps and BEAM provenance", () => {
		const longmem = normalizeMemoryBenchmarkSource("longmemeval", [
			{
				question_id: "q1",
				question_type: "single-session-user",
				question: "What color?",
				answer: "blue",
				haystack_session_ids: ["s1"],
				haystack_sessions: [[{ role: "user", content: "My color is blue" }]],
				answer_session_ids: ["s1"],
			},
		]);
		expect(longmem).toMatchObject({
			documents: [{ corpusId: "q1", externalId: "s1" }],
			cases: [{ expectedDocumentIds: ["s1"] }],
		});

		const memops = normalizeMemoryBenchmarkSource("memops", {
			target_fact: "fact-1",
			conversations: [
				{ segment_index: 2, dialogue: [{ role: "user", content: "updated value" }] },
			],
			answer: [
				{
					question_pair_id: "m1",
					question: "Current value?",
					gold_provenance: [{ segment_index: 2, turn_index: 0 }],
				},
			],
		});
		expect(memops.cases[0]?.expectedDocumentIds).toEqual(["2:0"]);

		const beam = normalizeMemoryBenchmarkSource("beam", {
			chat: [{ batch_number: 1, turns: [[{ id: "chat-1", role: "user", content: "remember" }]] }],
			probingQuestions: {
				information_extraction: [
					{ id: "b1", question: "What?", answer: "remember", source_chat_ids: ["chat-1"] },
				],
			},
		});
		expect(beam.documents[0]?.externalId).toBe("chat-1");
		expect(beam.cases[0]?.expectedDocumentIds).toEqual(["chat-1"]);
	});

	it("persists normalized datasets and queued reproducible runs", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const store = new MemoryBenchmarkStore(db);
		const imported = await store.importDataset({
			name: "LongMemEval fixture",
			format: "longmemeval",
			sourceName: "fixture.json",
			sourceSha256: "abc123",
			source: [
				{
					question_id: "q1",
					question: "Lima?",
					haystack_session_ids: ["s1"],
					haystack_sessions: [[{ role: "user", content: "In Lima" }]],
					answer_session_ids: ["s1"],
				},
			],
		});
		expect(imported).toMatchObject({ documentCount: 1, caseCount: 1 });
		const datasets = await store.listDatasets();
		expect(datasets[0]).toMatchObject({
			id: imported.id,
			format: "longmemeval",
			source_name: "fixture.json",
		});
		expect(datasets[0]).not.toHaveProperty("source_path");
		const runId = await store.createRun(imported.id, { k: 10 });
		await expect(store.executeRun(runId)).resolves.toMatchObject({
			recallAtK: 1,
			hitAtK: 1,
		});
		expect(await store.listRuns()).toEqual([
			expect.objectContaining({ id: runId, status: "completed" }),
		]);

		const close = vi.fn(async () => undefined);
		const factory = vi.fn(async ({ documents }: { documents: Array<{ id: string }> }) => ({
			retrieve: async () => [{ id: documents[0]?.id ?? "", score: 0.9 }],
			close,
		}));
		const isolatedRunId = await store.createRun(imported.id, {
			k: 10,
			condition: "octopus-isolated",
		});
		await expect(
			store.executeRun(isolatedRunId, { createIsolatedRuntime: factory }),
		).resolves.toMatchObject({ recallAtK: 1, condition: "octopus-isolated" });
		expect(factory).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);

		const failedClose = vi.fn(async () => undefined);
		const failedRunId = await store.createRun(imported.id, {
			condition: "octopus-isolated",
		});
		await expect(
			store.executeRun(failedRunId, {
				createIsolatedRuntime: async () => ({
					retrieve: async () => {
						throw new Error("retrieval failed");
					},
					close: failedClose,
				}),
			}),
		).resolves.toMatchObject({ failedCases: 1 });
		expect(failedClose).toHaveBeenCalledTimes(1);
	});

	it("runs Octopus in an isolated corpus without touching production LTM", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const vectorStore = new SqliteVectorStore(db);
		await vectorStore.initialize();
		const ltm = new LongTermMemory(vectorStore, db);
		const descriptor = {
			provider: "test",
			model: "benchmark-v1",
			dimensions: 2,
			version: "test:benchmark-v1:2",
			quality: "provider" as const,
		};
		const embeddingFn = Object.assign(
			async (text: string) => [text.toLowerCase().includes("lima") ? 1 : 0, 0],
			{
				embedVersioned: async (text: string) => ({
					values: [text.toLowerCase().includes("lima") ? 1 : 0, 0],
					descriptor,
				}),
				getDescriptor: () => descriptor,
			},
		);
		const orchestrator = new MemoryOrchestrator({ db, ltm, embeddingFn });
		const imported = await orchestrator.importMemoryBenchmark({
			name: "isolated",
			format: "longmemeval",
			sourceName: "isolated.json",
			sourceSha256: "isolated",
			source: [{
				question_id: "q1",
				question: "Lima?",
				haystack_session_ids: ["s1"],
				haystack_sessions: [[{ role: "user", content: "Lives in Lima" }]],
				answer_session_ids: ["s1"],
			}],
		});
		expect(await ltm.count()).toBe(0);
		const result = await orchestrator.createMemoryBenchmarkRun(imported.id, {
			condition: "octopus-isolated",
			k: 5,
		});
		expect(result.metrics).toMatchObject({ recallAtK: 1, hitAtK: 1 });
		expect(await ltm.count()).toBe(0);
	});
});
