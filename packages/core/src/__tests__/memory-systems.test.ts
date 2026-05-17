import { afterEach, describe, expect, it } from "vitest";
import type { LLMRouter } from "../ai/router.js";
import { TokenCounter } from "../ai/tokenizer.js";
import type { LLMRequest, LLMResponse } from "../ai/types.js";
import { GlobalDailyMemory } from "../memory/daily.js";
import { MemoryDecayEngine } from "../memory/decay.js";
import { FTSSearchEngine } from "../memory/fts-search.js";
import { KnowledgeGraph } from "../memory/knowledge-graph.js";
import { LongTermMemory } from "../memory/ltm.js";
import { MemoryRetrieval } from "../memory/retrieval.js";
import { SqliteVectorStore } from "../memory/sqlite-vss.js";
import { ShortTermMemory } from "../memory/stm.js";
import type { MemoryItem } from "../memory/types.js";
import { UserProfileManager } from "../memory/user-profile.js";
import { WorkingMemory } from "../memory/working-memory.js";
import {
	type DatabaseAdapter,
	createDatabaseAdapter,
} from "../storage/database.js";

const tokenCounter = {
	countTokens: (text: string) => Math.ceil(text.length / 4),
	countMessagesTokens: (msgs: Array<{ content: string }>) =>
		msgs.reduce((sum, msg) => sum + Math.ceil(msg.content.length / 4), 0),
};

const embedFn = async (text: string): Promise<number[]> => {
	const vec = new Array(16).fill(0);
	for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
		let hash = 0;
		for (const ch of word) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
		vec[Math.abs(hash) % vec.length] += 1;
	}
	const norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0));
	return norm > 0 ? vec.map((value) => value / norm) : vec;
};

function createMemory(
	partial: Partial<MemoryItem> & { content: string },
): MemoryItem {
	return {
		id: partial.id ?? crypto.randomUUID(),
		type: partial.type ?? "semantic",
		content: partial.content,
		embedding: partial.embedding ?? new Array(16).fill(0),
		importance: partial.importance ?? 0.7,
		accessCount: partial.accessCount ?? 0,
		lastAccessed: partial.lastAccessed ?? new Date(0),
		createdAt: partial.createdAt ?? new Date(),
		associations: partial.associations ?? [],
		source: partial.source ?? {},
		metadata: partial.metadata ?? {},
	};
}

function createRouter(summary = "Resumen generado"): LLMRouter {
	return {
		chat: async (_request: LLMRequest): Promise<LLMResponse> => ({
			content: summary,
			model: "test",
			usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
			finishReason: "stop",
		}),
	} as LLMRouter;
}

describe("non-learning memory systems", () => {
	let db: DatabaseAdapter | undefined;

	afterEach(async () => {
		await db?.close();
		db = undefined;
	});

	async function createLtm() {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const store = new SqliteVectorStore(db);
		await store.initialize();
		return new LongTermMemory(store, db);
	}

	it("enforces STM scratchpad size and keeps condensed overflow context", async () => {
		const stm = new ShortTermMemory({
			maxTokens: 8,
			scratchPadSize: 2,
			autoEviction: true,
			tokenCounter,
		});
		stm.setScratchPad("a", "1");
		stm.setScratchPad("b", "2");
		stm.setScratchPad("c", "3");
		expect(stm.getScratchPad("a")).toBeUndefined();
		expect(stm.getScratchPad("b")).toBe("2");
		expect(stm.getScratchPad("c")).toBe("3");

		stm.add({
			role: "user",
			content: "first important error happened",
			timestamp: new Date(),
		});
		stm.add({
			role: "assistant",
			content: "second response with details",
			timestamp: new Date(),
		});
		stm.add({
			role: "user",
			content: "third request with more details",
			timestamp: new Date(),
		});
		expect(stm.getContext().length).toBeLessThan(3);
		expect(stm.getCondensedHistory().join("\n")).toContain(
			"first important error",
		);
	});

	it("stores, lists, retrieves, and updates LTM access metadata", async () => {
		const ltm = await createLtm();
		const embedding = await embedFn("github mcp token setup");
		await ltm.store(
			createMemory({
				id: "m1",
				content: "GitHub MCP token setup preference",
				embedding,
				createdAt: new Date("2024-01-01T00:00:00.000Z"),
			}),
		);
		await ltm.store(
			createMemory({
				id: "m2",
				content: "Recent unrelated note",
				embedding: await embedFn("unrelated note"),
				createdAt: new Date("2024-01-02T00:00:00.000Z"),
			}),
		);

		const recent = await ltm.listRecent(1);
		expect(recent).toHaveLength(1);
		expect(recent[0]?.id).toBe("m2");

		const results = await ltm.retrieveByEmbedding(embedding, {
			maxResults: 1,
			maxTokens: 100,
			minRelevance: 0.1,
			recencyWeight: 0.1,
			frequencyWeight: 0.1,
			relevanceWeight: 0.8,
		});
		expect(results[0]?.item.id).toBe("m1");
		const updated = await ltm.getById("m1");
		expect(updated?.accessCount).toBe(1);
		expect(updated?.lastAccessed.getTime()).toBeGreaterThan(
			new Date(0).getTime(),
		);
	});

	it("retrieval respects a single global token budget", async () => {
		const ltm = await createLtm();
		await ltm.store(
			createMemory({
				id: "long-memory",
				content: "github mcp token setup ".repeat(8),
				embedding: await embedFn("github mcp token setup"),
			}),
		);
		const stm = new ShortTermMemory({
			maxTokens: 100,
			scratchPadSize: 2,
			autoEviction: false,
			tokenCounter,
		});
		stm.add({
			role: "user",
			content: "recent stm context ".repeat(8),
			timestamp: new Date(),
		});
		const retrieval = new MemoryRetrieval(ltm, stm, embedFn, {
			maxResults: 5,
			maxTokens: 20,
			minRelevance: 0.1,
			weights: { relevance: 0.8, recency: 0.1, frequency: 0.1 },
		});

		const context = await retrieval.retrieveForContext("github token setup");
		expect(context.totalTokens).toBeLessThanOrEqual(20);
	});

	it("daily memory uses unique raw message ids and dumps pending raw activity", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const daily = new GlobalDailyMemory(
			db,
			createRouter(),
			new TokenCounter(),
			{
				triggerMessageCount: 100,
			},
		);
		await daily.addMessage("Primera accion", "user", "test");
		await daily.addMessage("Segunda accion", "assistant", "test");

		const structured = await daily.getStructuredData();
		expect(structured.rawMessages).toHaveLength(2);
		expect(new Set(structured.rawMessages.map((msg) => msg.id)).size).toBe(2);
		const dump = await daily.dumpAndClear(
			new Date().toISOString().split("T")[0] ?? "",
		);
		expect(dump).toContain("Primera accion");
		expect(dump).toContain("Segunda accion");
	});

	it("keeps FTS in sync with vector store writes and decay deletes", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const store = new SqliteVectorStore(db);
		await store.initialize();
		const fts = new FTSSearchEngine(db);
		await fts.initialize();

		const item = createMemory({
			id: "fts-memory",
			content: "alpha neptune recall note",
			embedding: await embedFn("alpha neptune recall note"),
		});
		await store.store(item);
		expect((await fts.search("neptune"))[0]?.item.id).toBe("fts-memory");

		await store.update({
			...item,
			content: "alpha saturn recall note",
			embedding: await embedFn("alpha saturn recall note"),
		});
		expect(await fts.search("neptune")).toHaveLength(0);
		const updatedResults = await fts.search("saturn");
		expect(updatedResults[0]?.item.id).toBe("fts-memory");
		expect(updatedResults[0]?.item.embedding).toHaveLength(16);

		await store.store(
			createMemory({
				id: "decayed-memory",
				type: "episodic",
				content: "obsolete pluto event",
				embedding: await embedFn("obsolete pluto event"),
				importance: 0.2,
				lastAccessed: new Date("2020-01-01T00:00:00.000Z"),
			}),
		);
		expect((await fts.search("pluto")).length).toBeGreaterThan(0);

		const decay = new MemoryDecayEngine(db, {
			episodicRate: 1,
			semanticRate: 1,
		});
		await decay.applyDecay();
		expect(await store.getById("decayed-memory")).toBeUndefined();
		expect(await fts.search("pluto")).toHaveLength(0);
	});

	it("working memory tolerates malformed URLs and injects pending/tool-only state", () => {
		const working = new WorkingMemory();
		expect(() =>
			working.updateFromUserMessage("check https://%zz now"),
		).not.toThrow();

		working.reset();
		working.addPendingStep("run validation");
		expect(working.hasContent()).toBe(true);
		expect(working.toContextString()).toContain("run validation");

		working.reset();
		working.trackTool("bash");
		expect(working.hasContent()).toBe(true);
		expect(working.toContextString()).toContain("bash");
	});

	it("validates and persists LLM-derived user profile fields", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const router = createRouter(`{
			"communicationStyle": "concise",
			"language": "es",
			"expertiseAreas": { "Python": 0.7, "TypeScript": "0.9", "Invalid": 2 },
			"preferences": { "editor": "vscode", "bad": 5 },
			"workflowSteps": ["inspect", 4, "test"],
			"traits": ["technical", 99]
		}`);
		const manager = new UserProfileManager(db, router, {
			minTurnsForUpdate: 1,
			useLLMExtraction: true,
		});

		await manager.updateFromConversation("owner", [
			{
				role: "user",
				content: "Necesito revisar y probar Python",
				timestamp: new Date(),
			},
		]);

		const freshManager = new UserProfileManager(db, createRouter(), {
			useLLMExtraction: false,
		});
		const stored = await freshManager.getProfile("owner");
		expect(stored.preferredLanguage).toBe("es");
		expect(stored.expertiseAreas).toEqual({ Python: 0.7 });
		expect(stored.preferences).toEqual({ editor: "vscode" });
		expect(stored.workflowPatterns[0]?.steps).toEqual(["inspect", "test"]);
		expect(stored.traits).toEqual(["technical"]);
	});

	it("stores knowledge graph nodes with matching embeddings and relation types", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const store = new SqliteVectorStore(db);
		await store.initialize();
		const graph = new KnowledgeGraph(db, 16);

		await graph.addNode("node-a", "Node A", "semantic", { kind: "test" });
		await graph.addNode("node-b", "Node B", "semantic", { kind: "test" });
		await graph.addEdge("node-a", "node-b", "depends_on", 0.9);

		const node = await store.getById("node-a");
		expect(node?.embedding).toHaveLength(16);
		const neighbors = await graph.getNeighbors("node-a");
		expect(neighbors[0]).toMatchObject({
			id: "node-b",
			relation: "depends_on",
			weight: 0.9,
		});
	});

	it("migrates legacy memory associations without losing edges", async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		const store = new SqliteVectorStore(db);
		await store.initialize();
		const graph = new KnowledgeGraph(db, 16);

		await graph.addNode("legacy-a", "Legacy A", "semantic", {});
		await graph.addNode("legacy-b", "Legacy B", "semantic", {});
		await db.run("DROP TABLE memory_associations");
		await db.run(
			`CREATE TABLE memory_associations (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        strength REAL NOT NULL,
        created_at TEXT NOT NULL
      )`,
		);
		await db.run(
			"INSERT INTO memory_associations (from_id, to_id, strength, created_at) VALUES (?, ?, ?, ?)",
			["legacy-a", "legacy-b", 0.75, "2024-01-01T00:00:00.000Z"],
		);

		const neighbors = await graph.getNeighbors("legacy-a");
		expect(neighbors[0]).toMatchObject({
			id: "legacy-b",
			relation: "associated",
			weight: 0.75,
		});
		const columns = await db.all<{ name: string }>(
			"PRAGMA table_info(memory_associations)",
		);
		expect(columns.map((column) => column.name)).toContain("source_id");
		expect(columns.map((column) => column.name)).toContain("target_id");
	});
});
