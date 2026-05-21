import type {
	ActiveForgettingOptions,
	ActiveForgettingReport,
} from "./types.js";

export interface MemoryRetentionScheduleConfig {
	enabled: boolean;
	cron: string;
	unusedDays?: number;
	lowImportanceThreshold?: number;
	contradictionGraceDays?: number;
	taskName?: string;
}

export interface MemoryRetentionSchedulerLike {
	schedule(name: string, expression: string, task: () => Promise<void>): void;
	cancel(name: string): void;
}

export interface MemoryRetentionRunner {
	runActiveForgetting(
		options?: ActiveForgettingOptions,
	): Promise<ActiveForgettingReport>;
}

export interface MemoryRetentionSchedulerLogger {
	info(message: string): void;
	error(message: string): void;
}

export class MemoryRetentionScheduler {
	private readonly taskName: string;
	private scheduled = false;
	private running = false;

	constructor(
		private runner: MemoryRetentionRunner,
		private scheduler: MemoryRetentionSchedulerLike,
		private config: MemoryRetentionScheduleConfig,
		private logger?: MemoryRetentionSchedulerLogger,
	) {
		this.taskName = config.taskName ?? "memory-retention";
	}

	start(): boolean {
		if (!this.config.enabled) return false;
		if (this.scheduled) return true;
		this.scheduler.schedule(this.taskName, this.config.cron, async () => {
			await this.runOnce();
		});
		this.scheduled = true;
		this.logger?.info(
			`Scheduled memory retention '${this.taskName}' with expression ${this.config.cron}`,
		);
		return true;
	}

	stop(): void {
		if (!this.scheduled) return;
		this.scheduler.cancel(this.taskName);
		this.scheduled = false;
	}

	async runOnce(): Promise<ActiveForgettingReport | undefined> {
		if (this.running) return undefined;
		this.running = true;
		try {
			const report = await this.runner.runActiveForgetting(
				this.activeForgettingOptions(),
			);
			this.logger?.info(
				`Memory retention completed: evaluated=${report.evaluated}, expired=${report.expired}, degraded=${report.degraded}`,
			);
			return report;
		} catch (err) {
			this.logger?.error(
				`Memory retention failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			throw err;
		} finally {
			this.running = false;
		}
	}

	private activeForgettingOptions(): ActiveForgettingOptions {
		return {
			unusedDays: this.config.unusedDays,
			lowImportanceThreshold: this.config.lowImportanceThreshold,
			contradictionGraceDays: this.config.contradictionGraceDays,
		};
	}
}
