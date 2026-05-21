import type { AgentRuntime } from "../agent/runtime.js";
import type {
	ChatExecution,
	ChatExecutionActivity,
	ChatManager,
} from "./manager.js";

const STATUS_RE =
	/^\0STATUS:(\w+)(?::([\w-]+))?(?::([A-Za-z0-9+/=]*))?(?::([A-Za-z0-9+/=]*))?\0$/;

export interface ChatExecutionStartInput {
	requestId?: string;
	message: string;
	conversationId?: string;
	agentId?: string;
	stream?: boolean;
}

export interface ChatExecutionEvent {
	type:
		| "execution_started"
		| "event"
		| "stream"
		| "response"
		| "stream_end"
		| "error";
	requestId?: string;
	executionId: string;
	conversationId: string;
	payload: Record<string, unknown>;
}

export interface ChatExecutionManagerOptions {
	chatManager: ChatManager;
	getAgentRuntime(agentId?: string): AgentRuntime;
	emit(event: ChatExecutionEvent): void;
	conversationHistoryLimit: number;
	streamCheckpointIntervalMs: number;
}

function decodeStatusField(value: string | undefined): string | null {
	if (!value) return null;
	try {
		return Buffer.from(value, "base64").toString("utf8");
	} catch {
		return null;
	}
}

function isCancelledError(err: unknown): boolean {
	return err instanceof Error && /cancel/i.test(err.message);
}

export class ChatExecutionManager {
	private controllers = new Map<string, AbortController>();
	private activeByConversation = new Map<string, string>();

	constructor(private opts: ChatExecutionManagerOptions) {}

	async initialize(): Promise<void> {
		await this.opts.chatManager.markStaleExecutionsInterrupted();
	}

	async start(input: ChatExecutionStartInput): Promise<ChatExecution> {
		const autoTitle =
			input.message.length > 50
				? `${input.message.substring(0, 50).trimEnd()}...`
				: input.message;
		let conversationId = input.conversationId;
		if (!conversationId) {
			const conv = await this.opts.chatManager.createConversation({
				agentId: input.agentId,
				title: autoTitle,
			});
			conversationId = conv.id;
		} else {
			const existing =
				await this.opts.chatManager.getConversation(conversationId);
			if (!existing) {
				const conv = await this.opts.chatManager.createConversation({
					agentId: input.agentId,
					title: autoTitle,
				});
				conversationId = conv.id;
			}
		}

		const active =
			await this.opts.chatManager.getActiveExecutionForConversation(
				conversationId,
			);
		if (active) return active;

		await this.opts.chatManager.addMessage(
			conversationId,
			"user",
			input.message,
		);
		const execution = await this.opts.chatManager.createExecution({
			requestId: input.requestId,
			conversationId,
			agentId: input.agentId,
			status: "queued",
		});

		const controller = new AbortController();
		this.controllers.set(execution.id, controller);
		this.activeByConversation.set(conversationId, execution.id);

		this.emit({
			type: "execution_started",
			requestId: input.requestId,
			executionId: execution.id,
			conversationId,
			payload: { execution, conversationId },
		});

		void this.runExecution(execution, input, controller).finally(() => {
			this.controllers.delete(execution.id);
			if (this.activeByConversation.get(conversationId) === execution.id) {
				this.activeByConversation.delete(conversationId);
			}
		});

		return execution;
	}

	async cancelByConversation(
		conversationId: string,
	): Promise<ChatExecution | null> {
		const execution =
			await this.opts.chatManager.getActiveExecutionForConversation(
				conversationId,
			);
		if (!execution) return null;
		await this.cancel(execution.id);
		return execution;
	}

	async cancel(executionId: string): Promise<boolean> {
		const controller = this.controllers.get(executionId);
		const execution = await this.opts.chatManager.getExecution(executionId);
		if (!execution) return false;
		controller?.abort();
		const completedAt = new Date().toISOString();
		await this.opts.chatManager.updateExecution(executionId, {
			status: "cancelled",
			currentStatus: "cancelled",
			completedAt,
			error: "Cancelado por el usuario",
		});
		this.emit({
			type: "stream_end",
			requestId: execution.request_id ?? undefined,
			executionId,
			conversationId: execution.conversation_id,
			payload: {
				done: true,
				cancelled: true,
				conversationId: execution.conversation_id,
				executionId,
			},
		});
		return true;
	}

	private emit(event: ChatExecutionEvent): void {
		this.opts.emit(event);
	}

	private async runExecution(
		execution: ChatExecution,
		input: ChatExecutionStartInput,
		controller: AbortController,
	): Promise<void> {
		const conversationId = execution.conversation_id;
		const targetAgent = this.opts.getAgentRuntime(input.agentId);
		let activities: ChatExecutionActivity[] = [];
		let fullText = "";
		let assistantMessageId: string | undefined;
		let lastCheckpointAt = 0;

		const updateExecution = async (
			updates: Parameters<ChatManager["updateExecution"]>[1],
		) => {
			await this.opts.chatManager.updateExecution(execution.id, updates);
		};

		const saveAssistantCheckpoint = async (
			status: "streaming" | "completed" | "interrupted" | "cancelled",
			force = false,
		) => {
			if (!fullText.trim()) return;
			const now = Date.now();
			if (
				!force &&
				assistantMessageId &&
				now - lastCheckpointAt < this.opts.streamCheckpointIntervalMs
			) {
				return;
			}
			const metadata = {
				status,
				partial: status !== "completed",
				checkpointedAt: new Date(now).toISOString(),
				source: "stream",
				executionId: execution.id,
			};
			if (assistantMessageId) {
				await this.opts.chatManager.updateMessage(
					assistantMessageId,
					fullText,
					{
						metadata,
					},
				);
			} else {
				const msg = await this.opts.chatManager.addMessage(
					conversationId,
					"assistant",
					fullText,
					{ metadata },
				);
				assistantMessageId = msg.id;
				await updateExecution({ assistantMessageId });
			}
			lastCheckpointAt = now;
		};

		try {
			await updateExecution({ status: "running", currentStatus: "thinking" });

			targetAgent.stm.clear();
			const history = await this.opts.chatManager.getConversationMessages(
				conversationId,
				{ limit: this.opts.conversationHistoryLimit, recent: true },
			);
			const previousMessages = history.slice(0, -1);
			const toolOutcomes = this.extractToolOutcomes(previousMessages);

			for (const message of previousMessages) {
				if (message.role !== "user" && message.role !== "assistant") continue;
				const metadata: Record<string, unknown> = { conversationId };
				const toolData = toolOutcomes.get(message.id);
				if (toolData && toolData.length > 0) {
					metadata.toolResults = toolData;
				}
				if (message.metadata) {
					try {
						const parsed = JSON.parse(message.metadata);
						if (parsed && typeof parsed === "object") {
							metadata.originalMetadata = parsed;
						}
					} catch {}
				}
				targetAgent.stm.add({
					role: message.role,
					content: message.content,
					timestamp: new Date(message.timestamp),
					metadata,
				});
			}

			if (input.stream !== false) {
				for await (const chunk of targetAgent.processMessageStream(
					input.message,
					conversationId,
					{ signal: controller.signal },
				)) {
					const statusMatch = chunk.match(STATUS_RE);
					if (statusMatch) {
						const activity: ChatExecutionActivity = {
							id: `${execution.id}-${Date.now()}-${activities.length}`,
							status: statusMatch[1] ?? "status",
							toolName: statusMatch[2] || null,
							uiIconB64: statusMatch[3] || null,
							activityDetail: decodeStatusField(statusMatch[4]),
							timestamp: Date.now(),
						};
						activities = [...activities, activity].slice(-80);
						await updateExecution({
							currentStatus: activity.status,
							activities,
						});
						this.emit({
							type: "event",
							requestId: execution.request_id ?? undefined,
							executionId: execution.id,
							conversationId,
							payload: {
								agentStatus: activity.status,
								toolName: activity.toolName,
								uiIconB64: activity.uiIconB64,
								activityDetail: activity.activityDetail,
								conversationId,
								executionId: execution.id,
							},
						});
						continue;
					}

					fullText += chunk;
					await saveAssistantCheckpoint("streaming");
					this.emit({
						type: "stream",
						requestId: execution.request_id ?? undefined,
						executionId: execution.id,
						conversationId,
						payload: {
							content: chunk,
							conversationId,
							executionId: execution.id,
						},
					});
				}

				await saveAssistantCheckpoint("completed", true);
				await updateExecution({
					status: "completed",
					currentStatus: null,
					completedAt: new Date().toISOString(),
				});
				this.emit({
					type: "stream_end",
					requestId: execution.request_id ?? undefined,
					executionId: execution.id,
					conversationId,
					payload: { done: true, conversationId, executionId: execution.id },
				});
			} else {
				const response = await targetAgent.processMessage(
					input.message,
					conversationId,
					{ signal: controller.signal },
				);
				await this.opts.chatManager.addMessage(
					conversationId,
					"assistant",
					response,
					{
						metadata: {
							status: "completed",
							source: "response",
							executionId: execution.id,
						},
					},
				);
				await updateExecution({
					status: "completed",
					currentStatus: null,
					completedAt: new Date().toISOString(),
				});
				this.emit({
					type: "response",
					requestId: execution.request_id ?? undefined,
					executionId: execution.id,
					conversationId,
					payload: {
						content: response,
						conversationId,
						executionId: execution.id,
					},
				});
			}

			targetAgent
				.runConsolidation()
				.catch((e) => console.error("LTM consolidation error (web):", e));
		} catch (err) {
			const cancelled = controller.signal.aborted || isCancelledError(err);
			const errorMessage = cancelled
				? "Cancelado por el usuario"
				: err instanceof Error
					? err.message
					: "Failed to process message";
			await saveAssistantCheckpoint(
				cancelled ? "cancelled" : "interrupted",
				true,
			);
			if (!cancelled) {
				await this.opts.chatManager.addMessage(
					conversationId,
					"assistant",
					`⚠️ Error: ${errorMessage}`,
					{ metadata: { status: "failed", executionId: execution.id } },
				);
			}
			await updateExecution({
				status: cancelled ? "cancelled" : "failed",
				currentStatus: null,
				error: errorMessage,
				completedAt: new Date().toISOString(),
			});
			this.emit({
				type: cancelled ? "stream_end" : "error",
				requestId: execution.request_id ?? undefined,
				executionId: execution.id,
				conversationId,
				payload: {
					error: errorMessage,
					cancelled,
					done: cancelled,
					conversationId,
					executionId: execution.id,
				},
			});
		}
	}

	private extractToolOutcomes(
		messages: Array<{ id: string; role: string; content: string }>,
	): Map<string, Array<{ tool: string; success: boolean; excerpt: string }>> {
		const outcomes = new Map<
			string,
			Array<{ tool: string; success: boolean; excerpt: string }>
		>();
		const checkpointRe =
			/Last tool: (\S+) \((success|error)\)(?:\s*\n[\s\S]*?)?Last result excerpt: ([^\n]{0,200})/g;
		for (const message of messages) {
			if (message.role !== "assistant") continue;
			const results: Array<{
				tool: string;
				success: boolean;
				excerpt: string;
			}> = [];
			const content = message.content;
			checkpointRe.lastIndex = 0;
			let match = checkpointRe.exec(content);
			while (match !== null) {
				results.push({
					tool: match[1],
					success: match[2] === "success",
					excerpt: match[3].trim(),
				});
				match = checkpointRe.exec(content);
			}
			if (results.length > 0) {
				outcomes.set(message.id, results);
			}
		}
		return outcomes;
	}
}
