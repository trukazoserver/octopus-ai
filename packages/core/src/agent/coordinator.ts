import type { AgentRuntime } from "./runtime.js";
import type { AgentConfig, TaskDescription, TaskResult } from "./types.js";

export class AgentCoordinator {
	private agents: Map<string, AgentRuntime> = new Map();
	private configs: Map<string, AgentConfig> = new Map();

	registerAgent(agent: AgentRuntime): void {
		const state = agent.getState();
		void state;
		const agentAny = agent as unknown as { config: AgentConfig };
		const config = agentAny.config;
		this.agents.set(config.id, agent);
		this.configs.set(config.id, config);
	}

	unregisterAgent(agentId: string): void {
		this.agents.delete(agentId);
		this.configs.delete(agentId);
	}

	async delegate(task: TaskDescription, agentId: string): Promise<TaskResult> {
		const agent = this.agents.get(agentId);
		if (!agent) {
			throw new Error(`Agent "${agentId}" not found`);
		}

		const response = await agent.processMessage(task.description);

		return {
			summary: response,
			whatWorked: `Task delegated to agent ${agentId}`,
			whatCouldImprove: "",
			patterns: task.keywords,
		};
	}

	broadcast(message: string): void {
		for (const agent of this.agents.values()) {
			agent.processMessage(message).catch(() => {});
		}
	}

	getAgent(id: string): AgentRuntime | undefined {
		return this.agents.get(id);
	}

	listAgents(): AgentConfig[] {
		return Array.from(this.configs.values());
	}

	findBestAgent(_task: TaskDescription): AgentRuntime | undefined {
		// Con un solo agente registrado, retornamos el primero disponible
		// TODO: Implementar routing real cuando haya múltiples agentes especializados
		const agents = Array.from(this.agents.values());
		return agents.length > 0 ? agents[0] : undefined;
	}
}
