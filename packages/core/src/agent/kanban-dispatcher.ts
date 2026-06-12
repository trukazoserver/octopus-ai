import type { RequirementResolver } from "./requirement-resolver.js";
import type {
	WorkflowManager,
	WorkflowTaskRecord,
} from "./workflow-manager.js";

export interface KanbanTaskExecutionContext {
	task: WorkflowTaskRecord;
	leaseToken: string;
	agentId: string;
	armKey?: string | null;
}

export type KanbanTaskExecutor = (
	context: KanbanTaskExecutionContext,
) => Promise<void>;

export interface KanbanDispatcherOptions {
	enabled?: boolean;
	limit?: number;
	leaseTtlMs?: number;
	maxConcurrentTasks?: number;
	maxConcurrentPerArm?: number;
	defaultAgentId?: string;
	onError?: (error: unknown, task: WorkflowTaskRecord) => void;
	taskExecutor?: KanbanTaskExecutor;
}

export interface KanbanDispatcherTickResult {
	expiredLeases: number;
	requirementsEvaluated: number;
	requirementsSatisfied: number;
	unlockedTasks: number;
	claimed: number;
	skipped: number;
}

export interface KanbanDispatcherStatus {
	enabled: boolean;
	ticking: boolean;
	activeTaskIds: string[];
	activeCount: number;
	availableSlots: number;
	config: {
		limit: number;
		leaseTtlMs: number;
		maxConcurrentTasks: number;
		maxConcurrentPerArm: number;
		defaultAgentId: string;
	};
	lastTickAt: string | null;
	lastTickResult: KanbanDispatcherTickResult | null;
}

export class KanbanDispatcher {
	private activeTaskIds = new Set<string>();
	private ticking = false;
	private lastTickAt: string | null = null;
	private lastTickResult: KanbanDispatcherTickResult | null = null;
	private options: Required<
		Pick<
			KanbanDispatcherOptions,
			| "enabled"
			| "limit"
			| "leaseTtlMs"
			| "maxConcurrentTasks"
			| "maxConcurrentPerArm"
			| "defaultAgentId"
		>
	> &
		Omit<
			KanbanDispatcherOptions,
			| "enabled"
			| "limit"
			| "leaseTtlMs"
			| "maxConcurrentTasks"
			| "maxConcurrentPerArm"
			| "defaultAgentId"
		>;

	constructor(
		private workflowManager: WorkflowManager,
		private requirementResolver: RequirementResolver,
		options: KanbanDispatcherOptions = {},
	) {
		this.options = {
			enabled: options.enabled ?? true,
			limit: options.limit ?? 10,
			leaseTtlMs: options.leaseTtlMs ?? 60_000,
			maxConcurrentTasks: options.maxConcurrentTasks ?? 5,
			maxConcurrentPerArm: options.maxConcurrentPerArm ?? 2,
			defaultAgentId: options.defaultAgentId ?? "octavio-dispatcher",
			onError: options.onError,
			taskExecutor: options.taskExecutor,
		};
	}

	getStatus(): KanbanDispatcherStatus {
		const activeCount = this.activeTaskIds.size;
		return {
			enabled: this.options.enabled,
			ticking: this.ticking,
			activeTaskIds: [...this.activeTaskIds],
			activeCount,
			availableSlots: Math.max(
				0,
				this.options.maxConcurrentTasks - activeCount,
			),
			config: {
				limit: this.options.limit,
				leaseTtlMs: this.options.leaseTtlMs,
				maxConcurrentTasks: this.options.maxConcurrentTasks,
				maxConcurrentPerArm: this.options.maxConcurrentPerArm,
				defaultAgentId: this.options.defaultAgentId,
			},
			lastTickAt: this.lastTickAt,
			lastTickResult: this.lastTickResult,
		};
	}

	async loadPersistedState(): Promise<KanbanDispatcherStatus> {
		const state = await this.workflowManager.getKanbanDispatcherState();
		if (state) this.options.enabled = state.enabled;
		return this.getStatus();
	}

	async setEnabled(enabled: boolean): Promise<KanbanDispatcherStatus> {
		this.options.enabled = enabled;
		await this.workflowManager.setKanbanDispatcherEnabled(enabled, {
			source: "kanban_dispatcher",
		});
		return this.getStatus();
	}

	async tick(): Promise<KanbanDispatcherTickResult> {
		if (!this.options.enabled || this.ticking) {
			return {
				expiredLeases: 0,
				requirementsEvaluated: 0,
				requirementsSatisfied: 0,
				unlockedTasks: 0,
				claimed: 0,
				skipped: 0,
			};
		}
		this.ticking = true;
		try {
			const expiredLeases = await this.workflowManager.expireStaleLeases();
			const requirements =
				await this.requirementResolver.evaluatePendingRequirements();
			const availableSlots = Math.max(
				0,
				this.options.maxConcurrentTasks - this.activeTaskIds.size,
			);
			let claimed = 0;
			let skipped = 0;
			if (availableSlots > 0) {
				const tasks = await this.workflowManager.listReadyTasks({
					limit: Math.min(this.options.limit, availableSlots),
					excludeTaskIds: [...this.activeTaskIds],
				});
				const perArm = new Map<string, number>();
				for (const task of tasks) {
					const armKey = task.arm_key ?? "unassigned";
					const armCount = perArm.get(armKey) ?? 0;
					if (armCount >= this.options.maxConcurrentPerArm) {
						skipped++;
						continue;
					}
					const claim = await this.workflowManager.claimTask({
						taskId: task.id,
						agentId: task.assigned_agent_id ?? this.options.defaultAgentId,
						armKey: task.arm_key,
						leaseTtlMs: this.options.leaseTtlMs,
						metadata: { source: "kanban_dispatcher" },
					});
					if (!claim) {
						skipped++;
						continue;
					}
					claimed++;
					perArm.set(armKey, armCount + 1);
					this.startExecution(claim.task, claim.lease.lease_token);
				}
			}
			const result = {
				expiredLeases,
				requirementsEvaluated: requirements.evaluated,
				requirementsSatisfied: requirements.satisfied,
				unlockedTasks: requirements.unlockedTasks,
				claimed,
				skipped,
			};
			this.lastTickAt = new Date().toISOString();
			this.lastTickResult = result;
			return result;
		} finally {
			this.ticking = false;
		}
	}

	private startExecution(task: WorkflowTaskRecord, leaseToken: string): void {
		this.activeTaskIds.add(task.id);
		const executor = this.options.taskExecutor;
		if (!executor) {
			void this.workflowManager
				.updateTaskStatus(task.id, "ready", {
					metadata: { dispatcher: "no_executor_configured" },
				})
				.finally(() => this.activeTaskIds.delete(task.id));
			return;
		}
		void executor({
			task,
			leaseToken,
			agentId: task.assigned_agent_id ?? this.options.defaultAgentId,
			armKey: task.arm_key,
		})
			.catch(async (error) => {
				this.options.onError?.(error, task);
				await this.workflowManager.recordFailureAndDecideRetry({
					taskId: task.id,
					error: error instanceof Error ? error.message : String(error),
					metadata: { source: "kanban_dispatcher" },
				});
			})
			.finally(() => {
				this.activeTaskIds.delete(task.id);
			});
	}
}
