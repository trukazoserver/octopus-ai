import type { AgentManager } from "../agent/manager.js";
import type { AgentStoredMessageType } from "../agent/types.js";
import type { ToolDefinition } from "./registry.js";

function currentAgentId(context: { agent?: { agentId?: string } }): string {
	const agentId = context.agent?.agentId;
	if (!agentId) throw new Error("No current agent id is available in tool context");
	return agentId;
}

function parseMessageIds(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string");
	}
	if (typeof value !== "string") return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		if (Array.isArray(parsed)) {
			return parsed.filter((item): item is string => typeof item === "string");
		}
	} catch {
		// fall back to CSV below
	}
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function parseMessageType(value: unknown): AgentStoredMessageType | undefined {
	if (typeof value !== "string") return undefined;
	if (
		value === "message" ||
		value === "broadcast" ||
		value === "progress" ||
		value === "question" ||
		value === "result" ||
		value === "spawn_request"
	) {
		return value;
	}
	return undefined;
}

export function createAgentCommsTools(manager: AgentManager): ToolDefinition[] {
	return [
		{
			name: "agent_send_message",
			description:
				"Persist a message to another Octopus agent, or broadcast if no target agent is provided. Use this for durable agent-to-agent coordination tied to workflow runs.",
			parameters: {
				toAgentId: {
					type: "string",
					description: "Target agent id. Leave empty to broadcast to all agents.",
				},
				message: {
					type: "string",
					description: "Message content to persist.",
					required: true,
				},
				messageType: {
					type: "string",
					description:
						"Optional type: message, broadcast, progress, question, result, spawn_request.",
				},
				runId: {
					type: "string",
					description: "Optional workflow run id.",
				},
				taskId: {
					type: "string",
					description: "Optional workflow task id.",
				},
			},
			handler: async (params, context) => {
				try {
					const fromAgentId = currentAgentId(context);
					const message = await manager.sendMessage({
						fromAgentId,
						toAgentId:
							typeof params.toAgentId === "string" && params.toAgentId.trim()
								? params.toAgentId.trim()
								: null,
						content: String(params.message ?? ""),
						messageType: parseMessageType(params.messageType),
						runId: typeof params.runId === "string" ? params.runId : undefined,
						taskId: typeof params.taskId === "string" ? params.taskId : undefined,
					});
					return {
						success: true,
						output: `Message persisted with id ${message.id}`,
						metadata: { message },
					};
				} catch (err) {
					return { success: false, output: "", error: String(err) };
				}
			},
		},
		{
			name: "agent_list_messages",
			description:
				"List durable messages addressed to the current agent. Use includeBroadcasts to include team-wide messages.",
			parameters: {
				includeBroadcasts: {
					type: "boolean",
					description: "Include broadcast messages with no direct target.",
				},
				unreadOnly: {
					type: "boolean",
					description: "Only return unread messages.",
				},
				runId: {
					type: "string",
					description: "Optional workflow run id filter.",
				},
				limit: {
					type: "number",
					description: "Maximum messages to return, capped at 200.",
				},
			},
			handler: async (params, context) => {
				try {
					const messages = await manager.listInbox({
						agentId: currentAgentId(context),
						includeBroadcasts: params.includeBroadcasts === true,
						unreadOnly: params.unreadOnly === true,
						runId: typeof params.runId === "string" ? params.runId : undefined,
						limit: typeof params.limit === "number" ? params.limit : undefined,
					});
					return {
						success: true,
						output: JSON.stringify(messages, null, 2),
						metadata: { count: messages.length },
					};
				} catch (err) {
					return { success: false, output: "", error: String(err) };
				}
			},
		},
		{
			name: "agent_mark_messages_read",
			description:
				"Mark direct durable messages addressed to the current agent as read.",
			parameters: {
				messageIds: {
					type: "string",
					description: "Comma-separated or JSON array of message ids.",
					required: true,
				},
			},
			handler: async (params, context) => {
				try {
					const updated = await manager.markMessagesRead(
						currentAgentId(context),
						parseMessageIds(params.messageIds),
					);
					return {
						success: true,
						output: `${updated} messages marked as read.`,
						metadata: { updated },
					};
				} catch (err) {
					return { success: false, output: "", error: String(err) };
				}
			},
		},
	];
}
