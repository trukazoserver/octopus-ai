import type { ConversationTurn } from "../agent/types.js";
import { TokenCounter } from "../ai/tokenizer.js";
import type { LongTermMemory } from "./ltm.js";
import type { ShortTermMemory } from "./stm.js";
import type {
	EmbeddingFunction,
	MemoryContext,
	MemoryItem,
	ScoredMemory,
} from "./types.js";

export class MemoryRetrieval {
	private tokenCounter = new TokenCounter();

	constructor(
		private ltm: LongTermMemory,
		private stm: ShortTermMemory,
		private embedFn: EmbeddingFunction,
		private config: {
			maxResults: number;
			maxTokens: number;
			minRelevance: number;
			weights: { relevance: number; recency: number; frequency: number };
		},
	) {}

	async retrieveForContext(userMessage: string): Promise<MemoryContext> {
		const embedding = await this.embedFn(userMessage, "query");

		const rawResults = await this.ltm.retrieveByEmbedding(embedding, {
			maxResults: this.config.maxResults * 3,
			maxTokens: this.config.maxTokens,
			minRelevance: this.config.minRelevance,
			recencyWeight: this.config.weights.recency,
			frequencyWeight: this.config.weights.frequency,
			relevanceWeight: this.config.weights.relevance,
		});

		const scored = rawResults.sort((a, b) => b.score - a.score);
		const topItems = scored.slice(0, this.config.maxResults);

		const cascaded = await this.cascadeAssociations(topItems, 2);
		const deduped = this.deduplicate(cascaded);

		let totalTokens = 0;
		const truncated: ScoredMemory[] = [];
		for (const sm of deduped) {
			const tokens = this.tokenCounter.countTokens(sm.item.content);
			if (totalTokens + tokens > this.config.maxTokens) break;
			totalTokens += tokens;
			truncated.push(sm);
		}

		const remainingTokens = Math.max(0, this.config.maxTokens - totalTokens);
		const fromSTM = this.stm.getRelevant(userMessage, remainingTokens);
		const stmTokens = this.tokenCounter.countMessagesTokens(fromSTM);

		const combined: (ConversationTurn | ScoredMemory)[] = [
			...fromSTM,
			...truncated,
		];

		return {
			memories: truncated,
			totalTokens: totalTokens + stmTokens,
			fromSTM,
			combined,
		};
	}

	private async cascadeAssociations(
		items: ScoredMemory[],
		depth: number,
	): Promise<ScoredMemory[]> {
		if (depth <= 0 || items.length === 0) return items;

		const result = [...items];
		const seen = new Set(items.map((i) => i.item.id));

		const topItems = items.slice(0, 5);
		for (const sm of topItems) {
			if (sm.score <= 0.8) continue;
			const associations = await this.ltm.getAssociations(sm.item.id);
			for (const assocId of associations) {
				if (seen.has(assocId)) continue;
				const assocItem = await this.ltm.getById(assocId);
				if (!assocItem) continue;
				const decayedScore = sm.score * 0.7;
				seen.add(assocId);
				result.push({ item: assocItem, score: decayedScore });
			}
		}

		if (depth > 1) {
			return this.cascadeAssociations(result, depth - 1);
		}

		return result;
	}

	private deduplicate(items: ScoredMemory[]): ScoredMemory[] {
		const seen = new Map<string, ScoredMemory>();
		for (const sm of items) {
			const existing = seen.get(sm.item.id);
			if (!existing || sm.score > existing.score) {
				seen.set(sm.item.id, sm);
			}
		}
		const result = Array.from(seen.values());
		result.sort((a, b) => b.score - a.score);
		return result;
	}
}
