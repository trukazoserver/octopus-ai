import type { AgentManager } from "../agent/manager.js";
import type { ToolDefinition } from "./registry.js";

function currentAgentId(context: { agent?: { agentId?: string } }): string {
	const agentId = context.agent?.agentId;
	if (!agentId) throw new Error("No current agent id is available in tool context");
	return agentId;
}

export function createAgentSpawnTools(manager: AgentManager): ToolDefinition[] {
	return [
		{
			name: "agent_spawn_subagent",
			description:
				"Create a controlled child agent record for a narrow follow-up task. The child inherits the parent's safety limits and cannot exceed max spawn depth.",
			parameters: {
				name: {
					type: "string",
					description: "Short name for the subagent.",
					required: true,
				},
				role: {
					type: "string",
					description: "Focused role for the subagent.",
					required: true,
				},
				description: {
					type: "string",
					description: "Task or scope assigned to the subagent.",
				},
				systemPrompt: {
					type: "string",
					description: "Optional constrained system prompt for the child agent.",
				},
				model: {
					type: "string",
					description: "Optional model override.",
				},
			},
			handler: async (params, context) => {
				try {
					const agent = await manager.spawnSubagent({
						parentAgentId: currentAgentId(context),
						name: String(params.name ?? "").trim(),
						role: String(params.role ?? "assistant").trim() || "assistant",
						description:
							typeof params.description === "string"
								? params.description
								: undefined,
						systemPrompt:
							typeof params.systemPrompt === "string"
								? params.systemPrompt
								: undefined,
						model: typeof params.model === "string" ? params.model : undefined,
					});
					return {
						success: true,
						output: `Subagent '${agent.name}' created with id ${agent.id}.`,
						metadata: { agent },
					};
				} catch (err) {
					return { success: false, output: "", error: String(err) };
				}
			},
		},
	];
}
