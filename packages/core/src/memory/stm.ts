import type { ConversationTurn, TaskState } from "../agent/types.js";

/**
 * CondensationCallback — permite al STM solicitar un resumen
 * sin acoplarse directamente al LLMRouter.
 */
export type CondensationCallback = (
	turns: ConversationTurn[],
) => Promise<string>;

export class ShortTermMemory {
	private workingContext: ConversationTurn[] = [];
	private scratchPad: Map<string, string> = new Map();
	private activeTask: TaskState | null = null;
	private maxTokens: number;
	private scratchPadSize: number;
	private autoEviction: boolean;
	private tokenCounter: {
		countTokens: (text: string) => number;
		countMessagesTokens: (msgs: ConversationTurn[]) => number;
	};

	/**
	 * Condensed summaries of evicted segments.
	 * These get injected at the start of context to preserve continuity.
	 */
	private condensedHistory: string[] = [];
	private condensationFn: CondensationCallback | null = null;
	private condensing = false;

	constructor(config: {
		maxTokens: number;
		scratchPadSize: number;
		autoEviction: boolean;
		tokenCounter: {
			countTokens: (text: string) => number;
			countMessagesTokens: (msgs: ConversationTurn[]) => number;
		};
	}) {
		this.maxTokens = config.maxTokens;
		this.scratchPadSize = Math.max(1, config.scratchPadSize);
		this.autoEviction = config.autoEviction;
		this.tokenCounter = config.tokenCounter;
	}

	/**
	 * Set the condensation callback (typically wired to the LLM).
	 * If not set, falls back to heuristic extraction.
	 */
	setCondensationCallback(fn: CondensationCallback): void {
		this.condensationFn = fn;
	}

	createEmptySibling(): ShortTermMemory {
		const sibling = new ShortTermMemory({
			maxTokens: this.maxTokens,
			scratchPadSize: this.scratchPadSize,
			autoEviction: this.autoEviction,
			tokenCounter: this.tokenCounter,
		});
		if (this.condensationFn) sibling.setCondensationCallback(this.condensationFn);
		return sibling;
	}

	add(turn: ConversationTurn): void {
		this.workingContext.push(turn);
		if (this.autoEviction) {
			this.evictWithCondensation();
		}
	}

	getRelevant(_query: string, maxTokens: number): ConversationTurn[] {
		let tokenBudget = maxTokens;
		const result: ConversationTurn[] = [];

		// Include condensed history first
		if (this.condensedHistory.length > 0) {
			const historyTurn: ConversationTurn = {
				role: "system",
				content: `## Previous Context (condensed)\n${this.condensedHistory.join("\n\n---\n\n")}`,
				timestamp: new Date(),
			};
			const historyTokens = this.tokenCounter.countTokens(historyTurn.content);
			if (historyTokens <= tokenBudget) {
				result.push(historyTurn);
				tokenBudget -= historyTokens;
			}
		}

		// Then recent messages (most recent first)
		for (let i = this.workingContext.length - 1; i >= 0; i--) {
			const turn = this.workingContext[i];
			const tokens = this.tokenCounter.countTokens(turn.content);
			if (tokens <= tokenBudget) {
				result.splice(this.condensedHistory.length > 0 ? 1 : 0, 0, turn);
				tokenBudget -= tokens;
			}
		}
		return result;
	}

	setScratchPad(key: string, value: string): void {
		if (
			!this.scratchPad.has(key) &&
			this.scratchPad.size >= this.scratchPadSize
		) {
			const oldestKey = this.scratchPad.keys().next().value;
			if (oldestKey) this.scratchPad.delete(oldestKey);
		}
		this.scratchPad.set(key, value);
	}

	getScratchPad(key: string): string | undefined {
		return this.scratchPad.get(key);
	}

	setActiveTask(task: TaskState): void {
		this.activeTask = task;
	}

	getActiveTask(): TaskState | null {
		return this.activeTask;
	}

	clear(): void {
		this.workingContext = [];
		this.scratchPad.clear();
		this.activeTask = null;
		this.condensedHistory = [];
	}

	getLoad(): number {
		const current = this.getTokenCount();
		return this.maxTokens > 0 ? (current / this.maxTokens) * 100 : 0;
	}

	getContext(): ConversationTurn[] {
		return [...this.workingContext];
	}

	getCondensedHistory(): string[] {
		return [...this.condensedHistory];
	}

	getTokenCount(): number {
		return this.tokenCounter.countMessagesTokens(this.workingContext);
	}

	/**
	 * Intelligent eviction: condense old messages before discarding.
	 * Preserves: user goals, errors, decisions, and key data.
	 */
	private evictWithCondensation(): void {
		if (this.getTokenCount() <= this.maxTokens) return;
		if (this.condensing) {
			// If already condensing, do simple eviction to prevent overflow
			this.evictOldestSimple();
			return;
		}

		// Determine how many turns to evict (evict oldest half)
		const totalTurns = this.workingContext.length;
		if (totalTurns <= 1) {
			this.evictOldestSimple();
			return;
		}

		const evictCount = Math.max(1, Math.floor(totalTurns / 2));
		const toEvict = this.workingContext.slice(0, evictCount);
		const toKeep = this.workingContext.slice(evictCount);

		// Generate condensed summary (async, non-blocking)
		this.condensing = true;
		if (this.condensationFn) {
			this.condensationFn(toEvict)
				.then((summary) => {
					if (summary && summary.trim().length > 0) {
						this.condensedHistory.push(summary);
						// Keep max 5 condensed segments (~2500 tokens)
						if (this.condensedHistory.length > 5) {
							this.condensedHistory.shift();
						}
					}
				})
				.catch(() => {
					// Fallback: use heuristic
					const fallback = this.heuristicCondensation(toEvict);
					if (fallback) this.condensedHistory.push(fallback);
				})
				.finally(() => {
					this.condensing = false;
				});
		} else {
			const fallback = this.heuristicCondensation(toEvict);
			if (fallback) {
				this.condensedHistory.push(fallback);
				if (this.condensedHistory.length > 5) {
					this.condensedHistory.shift();
				}
			}
			this.condensing = false;
		}

		this.workingContext = toKeep;
	}

	/**
	 * Heuristic condensation without LLM.
	 * Extracts: user requests, errors, decisions, URLs/paths.
	 */
	private heuristicCondensation(turns: ConversationTurn[]): string | null {
		const parts: string[] = [];

		// Extract user requests
		const userMessages = turns
			.filter((t) => t.role === "user")
			.map((t) => t.content.slice(0, 150).replace(/\n/g, " "));
		if (userMessages.length > 0) {
			parts.push(`User asked: ${userMessages.join("; ")}`);
		}

		// Extract errors mentioned
		const errorMentions = turns
			.filter((t) => /error|fail|crash|exception|bug/i.test(t.content))
			.map((t) => {
				const match = t.content.match(
					/(?:error|fail|exception|bug)[^.!?\n]{0,120}/i,
				);
				return match ? match[0].trim() : null;
			})
			.filter(Boolean);
		if (errorMentions.length > 0) {
			parts.push(`Errors: ${errorMentions.slice(0, 3).join("; ")}`);
		}

		// Extract URLs and file paths
		const pathsAndUrls = turns
			.flatMap((t) => {
				const urls = t.content.match(/https?:\/\/[^\s)]+/g) || [];
				const paths = t.content.match(/[\/\\][\w\-\.\/\\]+\.\w{1,6}/g) || [];
				return [...urls, ...paths];
			})
			.filter((v, i, a) => a.indexOf(v) === i)
			.slice(0, 5);
		if (pathsAndUrls.length > 0) {
			parts.push(`Key paths/URLs: ${pathsAndUrls.join(", ")}`);
		}

		// Active task info
		if (this.activeTask) {
			parts.push(`Active task: ${this.activeTask.description}`);
		}

		if (parts.length === 0) return null;
		return parts.join(". ");
	}

	/** Simple FIFO eviction as last resort */
	private evictOldestSimple(): void {
		while (
			this.workingContext.length > 0 &&
			this.getTokenCount() > this.maxTokens
		) {
			this.workingContext.shift();
		}
	}
}
