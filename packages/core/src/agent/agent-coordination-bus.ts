/**
 * AgentCoordinationBus — Peer-to-peer messaging and shared artifact layer
 * for independent multi-agent coordination.
 *
 * Agents communicate directly through the bus instead of only through the
 * orchestrator. This enables:
 * - Cross-review: agents review each other's work
 * - Correction: agents correct errors spotted in other agents' output
 * - Verification: QA agents verify outputs before synthesis
 * - Conflict detection: agents flag overlapping or contradictory work
 * - Shared awareness: agents know what others are doing in real-time
 */

export type CoordinationMessageType =
	| "info"
	| "review_request"
	| "review_result"
	| "correction"
	| "verification_pass"
	| "verification_fail"
	| "question"
	| "answer"
	| "status_update"
	| "conflict_alert";

export interface CoordinationMessage {
	id: string;
	from: string;
	fromName: string;
	to: string; // agentId or "*" for broadcast
	type: CoordinationMessageType;
	priority: "low" | "normal" | "high" | "critical";
	content: string;
	relatedTaskId?: string;
	metadata?: Record<string, unknown>;
	timestamp: number;
}

export type ArtifactStatus =
	| "draft"
	| "completed"
	| "under_review"
	| "needs_correction"
	| "verified"
	| "rejected";

export interface ArtifactReview {
	reviewerId: string;
	reviewerName: string;
	verdict: "approved" | "needs_work" | "rejected";
	issues: string[];
	suggestions: string[];
	timestamp: number;
}

export interface ArtifactCorrection {
	correctorId: string;
	correctorName: string;
	originalContent: string;
	correctedContent: string;
	reason: string;
	timestamp: number;
}

export interface AgentArtifact {
	taskId: string;
	taskRole: string;
	agentId: string;
	agentName: string;
	armKey: string;
	content: string;
	status: ArtifactStatus;
	reviewResults: ArtifactReview[];
	corrections: ArtifactCorrection[];
	timestamp: number;
}

type MessageHandler = (message: CoordinationMessage) => void;

export class AgentCoordinationBus {
	private messages: CoordinationMessage[] = [];
	private artifacts: Map<string, AgentArtifact> = new Map();
	private subscribers: Map<string, Set<MessageHandler>> = new Map();
	private sharedState: Map<string, unknown> = new Map();
	private idCounter = 0;

	private nextId(): string {
		return `coord_${++this.idCounter}_${Date.now()}`;
	}

	/**
	 * Send a message to a specific agent or broadcast to all.
	 */
	send(
		input: Omit<CoordinationMessage, "id" | "timestamp">,
	): CoordinationMessage {
		const msg: CoordinationMessage = {
			...input,
			id: this.nextId(),
			timestamp: Date.now(),
		};
		this.messages.push(msg);

		const deliver = (handlers: Iterable<MessageHandler>) => {
			for (const handler of handlers) {
				try {
					handler(msg);
				} catch {
					/* subscriber errors must not break the bus */
				}
			}
		};

		if (msg.to === "*") {
			for (const [agentId, handlers] of this.subscribers) {
				if (agentId !== msg.from) {
					deliver(handlers);
				}
			}
		} else {
			const handlers = this.subscribers.get(msg.to);
			if (handlers) {
				deliver(handlers);
			}
		}

		return msg;
	}

	/**
	 * Subscribe an agent to receive messages addressed to it.
	 * Supports multiple subscribers per agent.
	 */
	subscribe(agentId: string, handler: MessageHandler): () => void {
		let handlers = this.subscribers.get(agentId);
		if (!handlers) {
			handlers = new Set();
			this.subscribers.set(agentId, handlers);
		}
		handlers.add(handler);
		return () => {
			handlers!.delete(handler);
			if (handlers!.size === 0) {
				this.subscribers.delete(agentId);
			}
		};
	}

	/**
	 * Publish a completed artifact for peer review.
	 */
	publishArtifact(
		artifact: Omit<
			AgentArtifact,
			"timestamp" | "reviewResults" | "corrections" | "status"
		> & { status?: ArtifactStatus },
	): AgentArtifact {
		const full: AgentArtifact = {
			...artifact,
			reviewResults: [],
			corrections: [],
			status: artifact.status ?? "completed",
			timestamp: Date.now(),
		};
		this.artifacts.set(artifact.taskId, full);

		// Broadcast that a new artifact is available
		this.send({
			from: artifact.agentId,
			fromName: artifact.agentName,
			to: "*",
			type: "status_update",
			priority: "low",
			content: `${artifact.agentName} completó la tarea "${artifact.taskRole}" (${artifact.taskId}). Resultado disponible para revisión.`,
			relatedTaskId: artifact.taskId,
			metadata: { armKey: artifact.armKey, status: full.status },
		});

		return full;
	}

	/**
	 * Get an artifact by task ID.
	 */
	getArtifact(taskId: string): AgentArtifact | undefined {
		return this.artifacts.get(taskId);
	}

	/**
	 * Get all published artifacts.
	 */
	getAllArtifacts(): AgentArtifact[] {
		return [...this.artifacts.values()];
	}

	/**
	 * Get artifacts that still need review.
	 */
	getArtifactsNeedingReview(): AgentArtifact[] {
		return [...this.artifacts.values()].filter(
			(a) =>
				a.status === "completed" ||
				a.status === "needs_correction" ||
				a.status === "under_review",
		);
	}

	/**
	 * Get verified artifacts (passed all reviews).
	 */
	getVerifiedArtifacts(): AgentArtifact[] {
		return [...this.artifacts.values()].filter(
			(a) => a.status === "verified",
		);
	}

	/**
	 * Add a review to an artifact and update its status.
	 */
	addReview(
		taskId: string,
		review: Omit<ArtifactReview, "timestamp">,
	): boolean {
		const artifact = this.artifacts.get(taskId);
		if (!artifact) return false;

		const fullReview: ArtifactReview = { ...review, timestamp: Date.now() };
		artifact.reviewResults.push(fullReview);

		if (review.verdict === "approved") {
			if (artifact.status !== "needs_correction") {
				artifact.status = "verified";
			}
		} else if (review.verdict === "rejected") {
			artifact.status = "rejected";
		} else {
			artifact.status = "needs_correction";
		}

		// Notify the original agent about the review
		this.send({
			from: review.reviewerId,
			fromName: review.reviewerName,
			to: artifact.agentId,
			type:
				review.verdict === "approved"
					? "verification_pass"
					: "correction",
			priority: review.verdict === "approved" ? "low" : "high",
			content:
				review.verdict === "approved"
					? `Tu trabajo en "${taskId}" fue verificado y aprobado.`
					: `Tu trabajo en "${taskId}" necesita correcciones: ${review.issues.join("; ")}`,
			relatedTaskId: taskId,
			metadata: { issues: review.issues, suggestions: review.suggestions },
		});

		return true;
	}

	/**
	 * Apply a correction to an artifact.
	 */
	addCorrection(
		taskId: string,
		correction: Omit<ArtifactCorrection, "timestamp">,
	): boolean {
		const artifact = this.artifacts.get(taskId);
		if (!artifact) return false;

		artifact.corrections.push({ ...correction, timestamp: Date.now() });
		artifact.content = correction.correctedContent;
		artifact.status = "under_review";

		// Notify the original agent about the correction
		this.send({
			from: correction.correctorId,
			fromName: correction.correctorName,
			to: artifact.agentId,
			type: "correction",
			priority: "normal",
			content: `Se corrigió tu trabajo en "${taskId}": ${correction.reason}`,
			relatedTaskId: taskId,
			metadata: {
				originalContent: correction.originalContent.slice(0, 500),
				correctedContent: correction.correctedContent.slice(0, 500),
			},
		});

		return true;
	}

	/**
	 * Set a shared state value visible to all agents.
	 */
	setState(key: string, value: unknown): void {
		this.sharedState.set(key, value);
	}

	/**
	 * Get a shared state value.
	 */
	getState(key: string): unknown {
		return this.sharedState.get(key);
	}

	/**
	 * Get all messages for a specific agent (excluding self-sent).
	 */
	getMessagesForAgent(agentId: string, since?: number): CoordinationMessage[] {
		return this.messages.filter(
			(m) =>
				m.from !== agentId &&
				(m.to === agentId || m.to === "*") &&
				(!since || m.timestamp >= since),
		);
	}

	/**
	 * Get conversation between two agents.
	 */
	getConversationBetween(
		agent1: string,
		agent2: string,
	): CoordinationMessage[] {
		return this.messages.filter(
			(m) =>
				(m.from === agent1 && m.to === agent2) ||
				(m.from === agent2 && m.to === agent1),
		);
	}

	/**
	 * Get all conflict alerts.
	 */
	getConflictAlerts(): CoordinationMessage[] {
		return this.messages.filter((m) => m.type === "conflict_alert");
	}

	/**
	 * Get a summary of agent activity for coordination awareness.
	 */
	getCoordinationSummary(): string {
		const lines: string[] = ["# Coordination Summary"];
		const agentActivity = new Map<
			string,
			{ name: string; tasks: number; reviews: number }
		>();

		for (const artifact of this.artifacts.values()) {
			const existing = agentActivity.get(artifact.agentId) ?? {
				name: artifact.agentName,
				tasks: 0,
				reviews: 0,
			};
			existing.tasks++;
			agentActivity.set(artifact.agentId, existing);
		}

		for (const review of this.messages.filter(
			(m) => m.type === "review_result" || m.type === "verification_pass",
		)) {
			const existing = agentActivity.get(review.from) ?? {
				name: review.fromName,
				tasks: 0,
				reviews: 0,
			};
			existing.reviews++;
			agentActivity.set(review.from, existing);
		}

		for (const [agentId, activity] of agentActivity) {
			lines.push(
				`- ${activity.name} (${agentId}): ${activity.tasks} tareas completadas, ${activity.reviews} revisiones realizadas`,
			);
		}

		const conflicts = this.getConflictAlerts();
		if (conflicts.length > 0) {
			lines.push("", `Conflictos detectados: ${conflicts.length}`);
			for (const conflict of conflicts) {
				lines.push(`- ${conflict.fromName}: ${conflict.content}`);
			}
		}

		return lines.join("\n");
	}

	/**
	 * Clear all state.
	 */
	clear(): void {
		this.messages = [];
		this.artifacts.clear();
		this.sharedState.clear();
	}

	/**
	 * Prune old messages to keep memory bounded.
	 */
	pruneMessages(maxAge = 300_000): void {
		const cutoff = Date.now() - maxAge;
		this.messages = this.messages.filter((m) => m.timestamp > cutoff);
	}

	get messageCount(): number {
		return this.messages.length;
	}

	get artifactCount(): number {
		return this.artifacts.size;
	}
}
