import type { ConversationTurn, TaskState } from "../agent/types.js";

export class ShortTermMemory {
	private workingContext: ConversationTurn[] = [];
	private scratchPad: Map<string, string> = new Map();
	private activeTask: TaskState | null = null;
	private maxTokens: number;
	private autoEviction: boolean;
	private tokenCounter: {
		countTokens: (text: string) => number;
		countMessagesTokens: (msgs: ConversationTurn[]) => number;
	};

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
		this.autoEviction = config.autoEviction;
		this.tokenCounter = config.tokenCounter;
	}

	add(turn: ConversationTurn): void {
		this.workingContext.push(turn);
		if (this.autoEviction) {
			this.evictOldest();
		}
	}

	getRelevant(_query: string, maxTokens: number): ConversationTurn[] {
		let tokenBudget = maxTokens;
		const result: ConversationTurn[] = [];
		for (let i = this.workingContext.length - 1; i >= 0; i--) {
			const turn = this.workingContext[i];
			const tokens = this.tokenCounter.countTokens(turn.content);
			if (tokens <= tokenBudget) {
				result.unshift(turn);
				tokenBudget -= tokens;
			}
		}
		return result;
	}

	setScratchPad(key: string, value: string): void {
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
	}

	getLoad(): number {
		const current = this.getTokenCount();
		return this.maxTokens > 0 ? (current / this.maxTokens) * 100 : 0;
	}

	getContext(): ConversationTurn[] {
		return [...this.workingContext];
	}

	getTokenCount(): number {
		return this.tokenCounter.countMessagesTokens(this.workingContext);
	}

	private evictOldest(): void {
		while (
			this.workingContext.length > 0 &&
			this.getTokenCount() > this.maxTokens
		) {
			this.workingContext.shift();
		}
	}
}
