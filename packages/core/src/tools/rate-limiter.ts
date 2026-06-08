export interface ToolRateLimitRule {
	minIntervalMs: number;
	maxConcurrent: number;
	queueTimeoutMs: number;
}

export interface ToolRateLimitConfig {
	enabled?: boolean;
	mediaDefault?: Partial<ToolRateLimitRule>;
	byTool?: Record<string, Partial<ToolRateLimitRule>>;
}

interface ToolQueueState {
	running: number;
	lastFinishedAt: number;
	queue: Array<() => void>;
}

const DEFAULT_RULE: ToolRateLimitRule = {
	minIntervalMs: 3000,
	maxConcurrent: 1,
	queueTimeoutMs: 600000,
};

export class ToolRateLimiter {
	private states = new Map<string, ToolQueueState>();
	private enabled: boolean;
	private mediaDefault: ToolRateLimitRule;
	private byTool: Record<string, ToolRateLimitRule>;

	constructor(config?: ToolRateLimitConfig) {
		this.enabled = config?.enabled ?? true;
		this.mediaDefault = { ...DEFAULT_RULE, ...(config?.mediaDefault ?? {}) };
		this.byTool = Object.fromEntries(
			Object.entries(config?.byTool ?? {}).map(([toolName, rule]) => [
				toolName,
				{ ...DEFAULT_RULE, ...rule },
			]),
		);
	}

	update(config?: ToolRateLimitConfig): void {
		this.enabled = config?.enabled ?? true;
		this.mediaDefault = { ...DEFAULT_RULE, ...(config?.mediaDefault ?? {}) };
		this.byTool = Object.fromEntries(
			Object.entries(config?.byTool ?? {}).map(([toolName, rule]) => [
				toolName,
				{ ...DEFAULT_RULE, ...rule },
			]),
		);
	}

	getRule(toolName: string, isMediaTool: boolean): ToolRateLimitRule | undefined {
		if (!this.enabled) return undefined;
		return this.byTool[toolName] ?? (isMediaTool ? this.mediaDefault : undefined);
	}

	async run<T>(
		toolName: string,
		isMediaTool: boolean,
		operation: () => Promise<T>,
	): Promise<T> {
		const rule = this.getRule(toolName, isMediaTool);
		if (!rule) return operation();

		const release = await this.acquire(toolName, rule);
		try {
			return await operation();
		} finally {
			release();
		}
	}

	private async acquire(
		toolName: string,
		rule: ToolRateLimitRule,
	): Promise<() => void> {
		const state = this.getState(toolName);
		const startedWaitingAt = Date.now();

		while (true) {
			const waitForInterval = Math.max(
				0,
				state.lastFinishedAt + rule.minIntervalMs - Date.now(),
			);
			if (state.running < rule.maxConcurrent && waitForInterval === 0) {
				state.running += 1;
				return () => {
					state.running = Math.max(0, state.running - 1);
					state.lastFinishedAt = Date.now();
					state.queue.shift()?.();
				};
			}

			if (Date.now() - startedWaitingAt > rule.queueTimeoutMs) {
				throw new Error(
					`Rate limit queue timed out for ${toolName} after ${rule.queueTimeoutMs}ms`,
				);
			}

			await new Promise<void>((resolve) => {
				const timeout = setTimeout(resolve, Math.max(50, waitForInterval));
				state.queue.push(() => {
					clearTimeout(timeout);
					resolve();
				});
			});
		}
	}

	private getState(toolName: string): ToolQueueState {
		let state = this.states.get(toolName);
		if (!state) {
			state = { running: 0, lastFinishedAt: 0, queue: [] };
			this.states.set(toolName, state);
		}
		return state;
	}
}
