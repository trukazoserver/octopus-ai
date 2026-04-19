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

	findBestAgent(task: TaskDescription): AgentRuntime | undefined {
		const taskKeywords = new Set(task.keywords.map((k) => k.toLowerCase()));
		const taskDomains = new Set(task.domains.map((d) => d.toLowerCase()));
		const taskWords = new Set(
			task.description
				.toLowerCase()
				.split(/\s+/)
				.filter((w) => w.length > 3),
		);

		let bestAgent: AgentRuntime | undefined;
		let bestScore = -1;

		for (const [id, config] of this.configs) {
			const descLower = config.description.toLowerCase();
			const descWords = new Set(
				descLower.split(/\s+/).filter((w) => w.length > 3),
			);
			const nameLower = config.name.toLowerCase();

			let score = 0;

			for (const kw of taskKeywords) {
				if (descLower.includes(kw)) score += 2;
				if (nameLower.includes(kw)) score += 3;
			}

			for (const domain of taskDomains) {
				if (descLower.includes(domain)) score += 2;
			}

			for (const word of taskWords) {
				if (descWords.has(word)) score += 1;
			}

			if (score > bestScore) {
				bestScore = score;
				bestAgent = this.agents.get(id);
			}
		}

		return bestAgent;
	}
}
