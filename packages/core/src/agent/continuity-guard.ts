import type { SubtaskTracker, ReconciliationReport } from "./subtask-tracker.js";

export interface ContinuityGuardConfig {
	enabled: boolean;
	maxAutoContinuations: number;
	truncationDetection: boolean;
}

export const DEFAULT_CONTINUITY_GUARD_CONFIG: ContinuityGuardConfig = {
	enabled: true,
	maxAutoContinuations: 25,
	truncationDetection: true,
};

export interface ContinuityState {
	originalGoal: string;
	continuationCount: number;
	lastFinishReason: string | null;
	totalToolIterations: number;
}

export class ContinuityGuard {
	private config: ContinuityGuardConfig;
	private state: ContinuityState;

	constructor(config?: Partial<ContinuityGuardConfig>) {
		this.config = { ...DEFAULT_CONTINUITY_GUARD_CONFIG, ...config };
		this.state = {
			originalGoal: "",
			continuationCount: 0,
			lastFinishReason: null,
			totalToolIterations: 0,
		};
	}

	reset(goal: string): void {
		this.state = {
			originalGoal: goal,
			continuationCount: 0,
			lastFinishReason: null,
			totalToolIterations: 0,
		};
	}

	recordFinishReason(reason: string | undefined): void {
		this.state.lastFinishReason = reason ?? "stop";
	}

	recordToolIteration(): void {
		this.state.totalToolIterations++;
	}

	shouldAutoContinue(options: {
		finishReason: string | undefined;
		hasToolCalls: boolean;
		hasContent: boolean;
		iterationCount: number;
		maxIterations: number;
		inlineRunId?: string;
	}): boolean {
		if (!this.config.enabled) return false;
		if (this.state.continuationCount >= this.config.maxAutoContinuations) return false;

		const reason = options.finishReason ?? "stop";

		// Case 1: Response truncated by maxTokens
		if (this.config.truncationDetection && reason === "length") {
			return true;
		}

		// Case 2: Hit iteration limit but had tool calls (work was in progress)
		if (options.iterationCount >= options.maxIterations && options.hasToolCalls) {
			return true;
		}

		// Case 3: Had content but no tool calls AND finish reason is "length"
		// (LLM was generating a long text response that got cut)
		if (options.hasContent && !options.hasToolCalls && reason === "length") {
			return true;
		}

		return false;
	}

	incrementContinuation(): void {
		this.state.continuationCount++;
	}

	buildContinuePrompt(report?: ReconciliationReport | null): string {
		const parts: string[] = [
			"# AUTO-CONTINUATION",
			`Your previous response was truncated (finish reason: ${this.state.lastFinishReason}). Continuation ${this.state.continuationCount}/${this.config.maxAutoContinuations}.`,
			"",
		];

		if (report) {
			parts.push(report.verifiedContext);
			parts.push("");
		}

		parts.push("Continue from where you left off. Do NOT repeat work that was already completed. Be concise - focus on remaining tasks only.");

		return parts.join("\n");
	}

	get continuationCount(): number {
		return this.state.continuationCount;
	}

	get lastFinishReason(): string | null {
		return this.state.lastFinishReason;
	}

	getConfig(): ContinuityGuardConfig {
		return { ...this.config };
	}
}
