import { describe, expect, it, vi } from "vitest";
import { ContextAssembler } from "../memory/context-assembler.js";
import type { KnowledgeManager } from "../memory/knowledge-manager.js";
import type { MemoryOrchestrator } from "../memory/orchestrator.js";

describe("ContextAssembler memory gate", () => {
	it("keeps scoped knowledge while skipping durable memory reads", async () => {
		const read = vi.fn();
		const orchestrator = {
			read,
		} as unknown as MemoryOrchestrator;
		const searchChunks = vi.fn(async () => [
			{
				id: "chunk-1",
				item_id: "item-1",
				collection_id: "collection-1",
				item_title: "Reference",
				content: "Trusted project knowledge",
				modality: "text" as const,
				score: 0.9,
			},
		]);
		const knowledgeManager = { searchChunks } as unknown as KnowledgeManager;
		const assembler = new ContextAssembler(orchestrator, {}, knowledgeManager);

		const result = await assembler.assemble({
			objective: "Use project knowledge",
			tenantId: "local",
			userId: "owner",
			budgetTokens: 500,
			knowledgeCollectionIds: ["collection-1"],
			includeMemory: false,
		});

		expect(read).not.toHaveBeenCalled();
		expect(result.memoryPack.memories).toEqual([]);
		expect(result.memoryPack.uncertaintyLevel).toBe("NO_COVERAGE");
		expect(result.knowledgeChunks).toHaveLength(1);
		expect(searchChunks).toHaveBeenCalled();
	});
});
