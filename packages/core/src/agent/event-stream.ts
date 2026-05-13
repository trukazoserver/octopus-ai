/**
 * EventStream — Append-only event log for multi-agent coordination.
 *
 * Inspired by OpenHands' event stream architecture:
 * - Single source of truth for all agent activity
 * - Workers don't communicate directly; they read/write to the stream
 * - The orchestrator reads the stream to detect completion, conflicts, or re-planning needs
 */

export type AgentEventType =
	| "task_assigned"
	| "task_claimed"
	| "progress"
	| "tool_used"
	| "tool_result"
	| "thinking"
	| "result"
	| "error"
	| "blocked"
	| "cancelled";

export interface AgentEvent {
	id: string;
	timestamp: number;
	workerId: string;
	taskId: string;
	type: AgentEventType;
	data: {
		message?: string;
		toolName?: string;
		toolArgs?: Record<string, unknown>;
		toolResult?: string;
		progress?: number; // 0-100
		error?: string;
		artifacts?: string[]; // URLs, file paths, or other outputs
	};
}

export interface EventFilter {
	workerId?: string;
	taskId?: string;
	types?: AgentEventType[];
	since?: number; // timestamp
	limit?: number;
}

type EventSubscriber = (event: AgentEvent) => void;

export class EventStream {
	private events: AgentEvent[] = [];
	private subscribers: Map<string, EventSubscriber> = new Map();
	private idCounter = 0;

	/**
	 * Append a new event to the stream.
	 */
	append(event: Omit<AgentEvent, "id" | "timestamp">): AgentEvent {
		const fullEvent: AgentEvent = {
			...event,
			id: `evt_${++this.idCounter}_${Date.now()}`,
			timestamp: Date.now(),
		};
		this.events.push(fullEvent);

		// Notify all subscribers
		for (const callback of this.subscribers.values()) {
			try {
				callback(fullEvent);
			} catch {
				/* subscriber errors must not break the stream */
			}
		}

		return fullEvent;
	}

	/**
	 * Query events with filters.
	 */
	query(filter: EventFilter): AgentEvent[] {
		let results = this.events;

		if (filter.workerId) {
			results = results.filter((e) => e.workerId === filter.workerId);
		}
		if (filter.taskId) {
			results = results.filter((e) => e.taskId === filter.taskId);
		}
		if (filter.types && filter.types.length > 0) {
			const typeSet = new Set(filter.types);
			results = results.filter((e) => typeSet.has(e.type));
		}
		if (filter.since) {
			results = results.filter((e) => e.timestamp >= filter.since!);
		}
		if (filter.limit) {
			results = results.slice(-filter.limit);
		}

		return results;
	}

	/**
	 * Subscribe to new events. Returns an unsubscribe function.
	 */
	subscribe(callback: EventSubscriber): () => void {
		const id = `sub_${++this.idCounter}`;
		this.subscribers.set(id, callback);
		return () => {
			this.subscribers.delete(id);
		};
	}

	/**
	 * Get the latest event for a specific worker.
	 */
	getLatestForWorker(workerId: string): AgentEvent | undefined {
		for (let i = this.events.length - 1; i >= 0; i--) {
			if (this.events[i].workerId === workerId) return this.events[i];
		}
		return undefined;
	}

	/**
	 * Get all results (completed task outputs).
	 */
	getResults(): AgentEvent[] {
		return this.events.filter((e) => e.type === "result");
	}

	/**
	 * Get errors that haven't been resolved.
	 */
	getActiveErrors(): AgentEvent[] {
		const errorTasks = new Set<string>();
		const resolvedTasks = new Set<string>();

		for (const event of this.events) {
			if (event.type === "error") errorTasks.add(event.taskId);
			if (event.type === "result") resolvedTasks.add(event.taskId);
		}

		return this.events.filter(
			(e) => e.type === "error" && !resolvedTasks.has(e.taskId),
		);
	}

	/**
	 * Check if all tasks in a set are completed.
	 */
	areAllTasksComplete(taskIds: string[]): boolean {
		const completed = new Set(
			this.events
				.filter((e) => e.type === "result" || e.type === "cancelled")
				.map((e) => e.taskId),
		);
		return taskIds.every((id) => completed.has(id));
	}

	/**
	 * Get a compact summary of all activity for the orchestrator.
	 */
	getSummary(): string {
		const taskStatus = new Map<string, { workerId: string; status: string; lastMessage: string }>();

		for (const event of this.events) {
			const existing = taskStatus.get(event.taskId);
			const status =
				event.type === "result" ? "done" :
				event.type === "error" ? "error" :
				event.type === "blocked" ? "blocked" :
				event.type === "cancelled" ? "cancelled" :
				"running";

			taskStatus.set(event.taskId, {
				workerId: event.workerId,
				status,
				lastMessage: event.data.message || event.data.error || "",
			});
		}

		const lines: string[] = ["# Event Stream Summary"];
		for (const [taskId, info] of taskStatus) {
			lines.push(`- [${info.status.toUpperCase()}] Task ${taskId} (worker: ${info.workerId}): ${info.lastMessage.slice(0, 200)}`);
		}
		return lines.join("\n");
	}

	/**
	 * Total event count.
	 */
	get size(): number {
		return this.events.length;
	}

	/**
	 * Clear all events (for testing or reset).
	 */
	clear(): void {
		this.events = [];
	}
}
