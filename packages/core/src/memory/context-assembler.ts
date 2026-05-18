import type { MemoryOrchestrator } from "./orchestrator.js";
import { ProactiveMemoryScanner } from "./proactive-scanner.js";
import type {
	ContextAssemblyInput,
	ContextAssemblyResult,
	MemoryPack,
	ScoredMemory,
} from "./types.js";

export interface ContextAssemblerConfig {
	reserveTokens: number;
	maxSimilarEpisodes: number;
	maxAgentLessons: number;
}

const DEFAULT_CONFIG: ContextAssemblerConfig = {
	reserveTokens: 96,
	maxSimilarEpisodes: 4,
	maxAgentLessons: 5,
};

export class ContextAssembler {
	private config: ContextAssemblerConfig;
	private scanner: ProactiveMemoryScanner;

	constructor(
		private orchestrator: MemoryOrchestrator,
		config: Partial<ContextAssemblerConfig> = {},
	) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.scanner = new ProactiveMemoryScanner(orchestrator, {
			defaultBudgetTokens: Math.max(128, this.config.reserveTokens * 4),
		});
	}

	async assemble(input: ContextAssemblyInput): Promise<ContextAssemblyResult> {
		const effectiveBudget = Math.max(
			64,
			input.budgetTokens - this.config.reserveTokens,
		);
		const memoryPack = await this.orchestrator.read(
			input.objective,
			{ ...input, trackUsage: false },
			effectiveBudget,
		);
		const proactive = await this.scanner.scan(
			input.objective,
			input,
			input.now ?? new Date(),
			memoryPack,
		);

		const degradedSections: string[] = [];
		const assembled = this.mergeProspective(memoryPack, proactive.memoryPack);
		const trimmed = this.degradeToBudget(
			assembled,
			effectiveBudget,
			degradedSections,
		);
		const budgetExceeded = trimmed.tokenBudgetUsed > effectiveBudget;
		const proactiveMemoryIds = proactive.reminders.map(
			(reminder) => reminder.memoryId,
		);
		await this.orchestrator.recordReadUsageByIds(
			[
				...trimmed.memories.map((memory) => memory.item.id),
				...proactiveMemoryIds,
			],
			input,
		);

		return {
			memoryPack: trimmed,
			proactiveNotices: proactive.notices,
			proactiveMemoryIds,
			degradedSections,
			mandatorySectionsPreserved: [
				"uncertainty_level",
				"known_gaps",
				"user_memory",
				"prospective_reminders",
			],
			budgetExceeded,
		};
	}

	private mergeProspective(
		primary: MemoryPack,
		proactive: MemoryPack,
	): MemoryPack {
		const prospective = this.deduplicateScoredMemories([
			...primary.prospectiveReminders,
			...proactive.prospectiveReminders,
		]);
		const memories = this.deduplicateScoredMemories([
			...primary.memories,
			...prospective,
		]);
		return {
			...primary,
			memories,
			prospectiveReminders: prospective,
			tokenBudgetUsed: estimatePackTokens(memories),
		};
	}

	private degradeToBudget(
		pack: MemoryPack,
		budgetTokens: number,
		degradedSections: string[],
	): MemoryPack {
		let next = { ...pack };
		if (next.tokenBudgetUsed <= budgetTokens) return next;

		const similarEpisodes = next.similarEpisodes.slice(
			0,
			this.config.maxSimilarEpisodes,
		);
		if (similarEpisodes.length < next.similarEpisodes.length) {
			degradedSections.push("similar_episodes");
			next = this.withSection(next, "similarEpisodes", similarEpisodes);
		}
		if (next.tokenBudgetUsed <= budgetTokens) return next;

		const agentLessons = next.agentLessons.slice(
			0,
			this.config.maxAgentLessons,
		);
		if (agentLessons.length < next.agentLessons.length) {
			degradedSections.push("agent_lessons");
			next = this.withSection(next, "agentLessons", agentLessons);
		}
		if (next.tokenBudgetUsed <= budgetTokens) return next;

		const removable = new Set(
			next.similarEpisodes
				.concat(next.agentLessons)
				.map((memory) => memory.item.id),
		);
		const mandatoryIds = new Set(
			next.userMemory
				.concat(next.prospectiveReminders)
				.map((memory) => memory.item.id),
		);
		const memories = next.memories.filter(
			(memory) =>
				mandatoryIds.has(memory.item.id) || !removable.has(memory.item.id),
		);
		if (memories.length < next.memories.length)
			degradedSections.push("memory_pack");
		next = {
			...next,
			memories,
			similarEpisodes: next.similarEpisodes.filter((memory) =>
				memories.includes(memory),
			),
			agentLessons: next.agentLessons.filter((memory) =>
				memories.includes(memory),
			),
			tokenBudgetUsed: estimatePackTokens(memories),
			tokenBudgetRemaining: Math.max(
				0,
				budgetTokens - estimatePackTokens(memories),
			),
		};

		return next;
	}

	private withSection<K extends "similarEpisodes" | "agentLessons">(
		pack: MemoryPack,
		key: K,
		section: ScoredMemory[],
	): MemoryPack {
		const sectionIds = new Set(section.map((memory) => memory.item.id));
		const removedIds = new Set(pack[key].map((memory) => memory.item.id));
		const memories = pack.memories.filter(
			(memory) =>
				!removedIds.has(memory.item.id) || sectionIds.has(memory.item.id),
		);
		return {
			...pack,
			[key]: section,
			memories,
			tokenBudgetUsed: estimatePackTokens(memories),
		};
	}

	private deduplicateScoredMemories(memories: ScoredMemory[]): ScoredMemory[] {
		const deduped = new Map<string, ScoredMemory>();
		for (const memory of memories) {
			const previous = deduped.get(memory.item.id);
			if (!previous || memory.score > previous.score) {
				deduped.set(memory.item.id, memory);
			}
		}
		return Array.from(deduped.values()).sort((a, b) => b.score - a.score);
	}
}

function estimatePackTokens(memories: ScoredMemory[]): number {
	return memories.reduce(
		(total, memory) =>
			total + Math.ceil(memory.item.content.split(/\s+/).length * 1.3),
		0,
	);
}
