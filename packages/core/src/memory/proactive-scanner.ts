import type { MemoryOrchestrator } from "./orchestrator.js";
import type {
	MemoryPack,
	MemoryReadContext,
	ProactiveMemoryScanResult,
	ProspectiveReminder,
} from "./types.js";

export interface ProactiveMemoryScannerConfig {
	defaultBudgetTokens: number;
	dueSoonMs: number;
}

const DEFAULT_CONFIG: ProactiveMemoryScannerConfig = {
	defaultBudgetTokens: 600,
	dueSoonMs: 36 * 60 * 60 * 1000,
};

export class ProactiveMemoryScanner {
	private config: ProactiveMemoryScannerConfig;

	constructor(
		private orchestrator: MemoryOrchestrator,
		config: Partial<ProactiveMemoryScannerConfig> = {},
	) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	async scan(
		objective: string,
		context: MemoryReadContext,
		now = new Date(),
		providedMemoryPack?: MemoryPack,
	): Promise<ProactiveMemoryScanResult> {
		const reminders = await this.orchestrator.getProspectiveReminders(
			context,
			now,
		);
		const memoryPack =
			providedMemoryPack ??
			(await this.orchestrator.read(
				objective,
				context,
				this.config.defaultBudgetTokens,
			));
		const notices = this.buildNotices(reminders, now);
		return {
			objective,
			generatedAt: now,
			reminders,
			memoryPack,
			notices,
			relevanceDelta: this.computeRelevanceDelta(
				reminders,
				memoryPack.knownGaps.length,
			),
		};
	}

	private buildNotices(reminders: ProspectiveReminder[], now: Date): string[] {
		return reminders.slice(0, 5).map((reminder) => {
			if (!reminder.dueAt) return `Pendiente: ${reminder.commitment}`;
			const deltaMs = reminder.dueAt.getTime() - now.getTime();
			const absHours = Math.max(0, Math.round(Math.abs(deltaMs) / 3_600_000));
			if (deltaMs < 0)
				return `Vencido hace ${absHours}h: ${reminder.commitment}`;
			if (deltaMs <= this.config.dueSoonMs) {
				return `Próximo en ${absHours}h: ${reminder.commitment}`;
			}
			return `Pendiente para ${reminder.dueAt.toISOString()}: ${reminder.commitment}`;
		});
	}

	private computeRelevanceDelta(
		reminders: ProspectiveReminder[],
		knownGapCount: number,
	): number {
		const reminderSignal = reminders.reduce(
			(total, reminder) => total + reminder.importance * reminder.confidence,
			0,
		);
		return Math.max(0, reminderSignal - knownGapCount * 0.15);
	}
}
