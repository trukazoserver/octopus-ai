import { nanoid } from "nanoid";
import type { DatabaseAdapter } from "../storage/database.js";
import type { AgentCoordinator } from "../agent/coordinator.js";
import type { AgentRuntime } from "../agent/runtime.js";
import type { AgentManager } from "../agent/manager.js";
import type { AgentMessageBus } from "../agent/message-bus.js";
import type { AgentConfig, AgentMessage, TaskDescription, DelegationResult } from "../agent/types.js";
import { createLogger } from "../utils/logger.js";

/**
 * DelegationManager — Full Manager→Worker Multi-Agent System
 *
 * Completes the multi-agent delegation architecture:
 * - Manager agent receives complex tasks
 * - Analyzes and decomposes into sub-tasks
 * - Creates/selects specialist workers
 * - Delegates sub-tasks with isolated context
 * - Collects and synthesizes results
 * - Reports back to the user
 */

const logger = createLogger("delegation");

export interface DelegationConfig {
	/** Maximum concurrent workers */
	maxConcurrentWorkers: number;
	/** Timeout per worker task in ms (default: 5 min) */
	workerTimeoutMs: number;
	/** Whether to auto-create workers for new domains */
	autoCreateWorkers: boolean;
	/** Maximum delegation depth (prevent infinite recursion) */
	maxDelegationDepth: number;
}

export const DEFAULT_DELEGATION_CONFIG: DelegationConfig = {
	maxConcurrentWorkers: 3,
	workerTimeoutMs: 5 * 60 * 1000,
	autoCreateWorkers: true,
	maxDelegationDepth: 3,
};

export interface DelegationTask {
	id: string;
	parentTaskId: string | null;
	description: string;
	assignedAgentId: string | null;
	status: "pending" | "assigned" | "running" | "completed" | "failed";
	result: string | null;
	error: string | null;
	depth: number;
	createdAt: Date;
	completedAt: Date | null;
}

export interface DelegationPlan {
	id: string;
	originalTask: string;
	subtasks: DelegationTask[];
	status: "planning" | "executing" | "completed" | "failed";
	createdAt: Date;
}

export class DelegationManager {
	private config: DelegationConfig;
	private coordinator: AgentCoordinator;
	private agentManager: AgentManager;
	private messageBus: AgentMessageBus;
	private activePlans: Map<string, DelegationPlan> = new Map();
	private runningWorkers: Map<string, Promise<string>> = new Map();

	constructor(
		coordinator: AgentCoordinator,
		agentManager: AgentManager,
		messageBus: AgentMessageBus,
		config: Partial<DelegationConfig> = {},
	) {
		this.config = { ...DEFAULT_DELEGATION_CONFIG, ...config };
		this.coordinator = coordinator;
		this.agentManager = agentManager;
		this.messageBus = messageBus;
	}

	/**
	 * Decompose a complex task and delegate to workers.
	 */
	async delegateTask(
		task: TaskDescription,
		managerAgentId: string,
	): Promise<DelegationResult> {
		const planId = nanoid();
		const plan: DelegationPlan = {
			id: planId,
			originalTask: task.description,
			subtasks: [],
			status: "planning",
			createdAt: new Date(),
		};
		this.activePlans.set(planId, plan);

		logger.info(`Creating delegation plan ${planId}: "${task.description.substring(0, 80)}..."`);

		try {
			// Step 1: Decompose task into sub-tasks
			const subtaskDescriptions = this.decomposeTask(task);

			// Step 2: Create sub-task entries
			for (const desc of subtaskDescriptions) {
				const subtask: DelegationTask = {
					id: nanoid(),
					parentTaskId: planId,
					description: desc,
					assignedAgentId: null,
					status: "pending",
					result: null,
					error: null,
					depth: 0,
					createdAt: new Date(),
					completedAt: null,
				};
				plan.subtasks.push(subtask);
			}

			plan.status = "executing";

			// Step 3: Assign and execute sub-tasks
			const results = await this.executeSubtasks(plan, managerAgentId);

			// Step 4: Synthesize results
			const synthesized = this.synthesizeResults(task.description, results);

			plan.status = "completed";
			this.activePlans.set(planId, plan);

			return {
				taskId: planId,
				agentId: managerAgentId,
				agentName: "Manager",
				status: "completed",
				result: synthesized,
				progress: results.map(
					(r, i) => `Subtask ${i + 1}: ${r.status}`,
				),
			};
		} catch (err) {
			plan.status = "failed";
			this.activePlans.set(planId, plan);

			return {
				taskId: planId,
				agentId: managerAgentId,
				agentName: "Manager",
				status: "failed",
				result: `Delegation failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	/**
	 * Get the status of an active delegation plan.
	 */
	getPlanStatus(planId: string): DelegationPlan | undefined {
		return this.activePlans.get(planId);
	}

	/**
	 * List all active plans.
	 */
	getActivePlans(): DelegationPlan[] {
		return Array.from(this.activePlans.values()).filter(
			(p) => p.status === "executing" || p.status === "planning",
		);
	}

	// --- Private ---

	private decomposeTask(task: TaskDescription): string[] {
		const desc = task.description.toLowerCase();
		const subtasks: string[] = [];

		// Check for explicit multi-step indicators
		const steps = task.description.split(/(?:\d+\.\s+|\n-\s+|\n\*\s+)/).filter(
			(s) => s.trim().length > 10,
		);

		if (steps.length > 1) {
			return steps.map((s) => s.trim()).slice(0, this.config.maxConcurrentWorkers * 2);
		}

		// Check for "and" clauses indicating multiple tasks
		const andClauses = task.description.split(/\s+(?:y|and|además|también)\s+/i).filter(
			(s) => s.trim().length > 10,
		);

		if (andClauses.length > 1) {
			return andClauses.map((s) => s.trim());
		}

		// Single complex task — return as-is
		return [task.description];
	}

	private async executeSubtasks(
		plan: DelegationPlan,
		managerAgentId: string,
	): Promise<DelegationTask[]> {
		// Execute subtasks with concurrency limit
		const pending = [...plan.subtasks];
		const completed: DelegationTask[] = [];

		while (pending.length > 0) {
			// Take batch up to max concurrent
			const batch = pending.splice(0, this.config.maxConcurrentWorkers);

			const promises = batch.map(async (subtask) => {
				// Find or create the best agent for this subtask
				const taskDesc: TaskDescription = {
					description: subtask.description,
					complexity: 0.5,
					keywords: subtask.description
						.split(/\s+/)
						.filter((w) => w.length > 3),
					domains: [],
				};

				const worker = this.coordinator.findBestAgent(taskDesc);
				if (!worker) {
					subtask.status = "failed";
					subtask.error = "No suitable worker found";
					subtask.completedAt = new Date();
					return subtask;
				}

				subtask.status = "running";

				// Notify via message bus
				this.messageBus.publish({
					from: managerAgentId,
					to: "broadcast",
					type: "delegation",
					content: `Delegating: "${subtask.description.substring(0, 100)}..."`,
					timestamp: new Date(),
				});

				try {
					// Execute with timeout
					const result = await this.withTimeout(
						worker.processMessage(subtask.description),
						this.config.workerTimeoutMs,
					);

					subtask.status = "completed";
					subtask.result = result;
					subtask.completedAt = new Date();
				} catch (err) {
					subtask.status = "failed";
					subtask.error =
						err instanceof Error ? err.message : String(err);
					subtask.completedAt = new Date();
				}

				return subtask;
			});

			const results = await Promise.all(promises);
			completed.push(...results);
		}

		return completed;
	}

	private synthesizeResults(
		originalTask: string,
		subtasks: DelegationTask[],
	): string {
		const succeeded = subtasks.filter((s) => s.status === "completed");
		const failed = subtasks.filter((s) => s.status === "failed");

		const parts: string[] = [];

		if (subtasks.length === 1 && succeeded.length === 1) {
			return succeeded[0].result ?? "Task completed";
		}

		parts.push(`## Delegation Results\n`);
		parts.push(`Original task: ${originalTask}\n`);
		parts.push(
			`Completed: ${succeeded.length}/${subtasks.length} subtasks\n`,
		);

		for (let i = 0; i < subtasks.length; i++) {
			const st = subtasks[i];
			if (st.status === "completed") {
				parts.push(`### Subtask ${i + 1} ✅`);
				parts.push(`**Task**: ${st.description}`);
				parts.push(`**Result**: ${st.result?.substring(0, 500) ?? "OK"}\n`);
			} else {
				parts.push(`### Subtask ${i + 1} ❌`);
				parts.push(`**Task**: ${st.description}`);
				parts.push(`**Error**: ${st.error ?? "Unknown"}\n`);
			}
		}

		return parts.join("\n");
	}

	private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`Worker timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			promise
				.then((result) => {
					clearTimeout(timer);
					resolve(result);
				})
				.catch((err) => {
					clearTimeout(timer);
					reject(err);
				});
		});
	}
}
