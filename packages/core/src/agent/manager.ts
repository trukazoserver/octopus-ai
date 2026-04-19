import { nanoid } from "nanoid";
import type { DatabaseAdapter } from "../storage/database.js";
import type { AgentRuntime } from "./runtime.js";
import type { AgentConfig, AgentRecord, CreateAgentInput } from "./types.js";

export class AgentManager {
	private runtimes: Map<string, AgentRuntime> = new Map();

	constructor(private db: DatabaseAdapter) {}

	async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
		const id = nanoid(16);
		const now = new Date().toISOString();
		const role = input.role ?? "assistant";
		const systemPrompt = input.systemPrompt ?? this.buildSystemPrompt(input);
		const config = input.config ? JSON.stringify(input.config) : null;

		await this.db.run(
			"INSERT INTO agents (id, name, description, role, personality, system_prompt, model, avatar, color, is_default, is_main, parent_id, created_at, updated_at, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)",
			[
				id,
				input.name,
				input.description ?? null,
				role,
				input.personality ?? null,
				systemPrompt,
				input.model ?? null,
				input.avatar ?? null,
				input.color ?? null,
				input.isMain ? 1 : 0,
				input.parentId ?? null,
				now,
				now,
				config,
			],
		);

		return {
			id,
			name: input.name,
			description: input.description ?? null,
			role,
			personality: input.personality ?? null,
			system_prompt: systemPrompt,
			model: input.model ?? null,
			avatar: input.avatar ?? null,
			color: input.color ?? null,
			is_default: 0,
			is_main: input.isMain ? 1 : 0,
			parent_id: input.parentId ?? null,
			created_at: now,
			updated_at: now,
			config,
		};
	}

	async getAgent(id: string): Promise<AgentRecord | null> {
		return (
			(await this.db.get<AgentRecord>("SELECT * FROM agents WHERE id = ?", [
				id,
			])) ?? null
		);
	}

	async listAgents(): Promise<AgentRecord[]> {
		return this.db.all<AgentRecord>(
			"SELECT * FROM agents ORDER BY is_main DESC, name ASC",
		);
	}

	async updateAgent(
		id: string,
		updates: Partial<Omit<CreateAgentInput, "isMain">>,
	): Promise<boolean> {
		const existing = await this.getAgent(id);
		if (!existing) return false;

		const now = new Date().toISOString();
		const fields: string[] = [];
		const values: unknown[] = [];

		if (updates.name !== undefined) {
			fields.push("name = ?");
			values.push(updates.name);
		}
		if (updates.description !== undefined) {
			fields.push("description = ?");
			values.push(updates.description);
		}
		if (updates.role !== undefined) {
			fields.push("role = ?");
			values.push(updates.role);
		}
		if (updates.personality !== undefined) {
			fields.push("personality = ?");
			values.push(updates.personality);
		}
		if (updates.systemPrompt !== undefined) {
			fields.push("system_prompt = ?");
			values.push(updates.systemPrompt);
		}
		if (updates.model !== undefined) {
			fields.push("model = ?");
			values.push(updates.model);
		}
		if (updates.avatar !== undefined) {
			fields.push("avatar = ?");
			values.push(updates.avatar);
		}
		if (updates.color !== undefined) {
			fields.push("color = ?");
			values.push(updates.color);
		}
		if (updates.config !== undefined) {
			fields.push("config = ?");
			values.push(JSON.stringify(updates.config));
		}

		if (fields.length === 0) return true;

		fields.push("updated_at = ?");
		values.push(now);
		values.push(id);

		await this.db.run(
			`UPDATE agents SET ${fields.join(", ")} WHERE id = ?`,
			values,
		);
		return true;
	}

	async deleteAgent(id: string): Promise<boolean> {
		const existing = await this.getAgent(id);
		if (!existing) return false;
		if (existing.is_main) return false;
		this.runtimes.delete(id);
		await this.db.run("DELETE FROM agents WHERE id = ?", [id]);
		return true;
	}

	async getMainAgent(): Promise<AgentRecord | null> {
		return (
			(await this.db.get<AgentRecord>(
				"SELECT * FROM agents WHERE is_main = 1 LIMIT 1",
			)) ?? null
		);
	}

	async ensureMainAgent(defaultConfig: AgentConfig): Promise<AgentRecord> {
		const existing = await this.getMainAgent();
		if (existing) return existing;

		const now = new Date().toISOString();
		const id = defaultConfig.id;
		await this.db.run(
			"INSERT INTO agents (id, name, description, role, personality, system_prompt, model, avatar, color, is_default, is_main, parent_id, created_at, updated_at, config) VALUES (?, ?, ?, 'coordinator', ?, ?, ?, ?, 1, 1, NULL, ?, ?, NULL)",
			[
				id,
				defaultConfig.name,
				defaultConfig.description ?? "Main orchestrator agent",
				"You are the main coordinator. You always stay in touch with the user and delegate tasks to sub-agents.",
				defaultConfig.systemPrompt,
				defaultConfig.model ?? null,
				null,
				null,
				now,
				now,
			],
		);

		return {
			id,
			name: defaultConfig.name,
			description: defaultConfig.description ?? "Main orchestrator agent",
			role: "coordinator",
			personality:
				"You are the main coordinator. You always stay in touch with the user and delegate tasks to sub-agents.",
			system_prompt: defaultConfig.systemPrompt,
			model: defaultConfig.model ?? null,
			avatar: null,
			color: null,
			is_default: 1,
			is_main: 1,
			parent_id: null,
			created_at: now,
			updated_at: now,
			config: null,
		};
	}

	registerRuntime(agentId: string, runtime: AgentRuntime): void {
		this.runtimes.set(agentId, runtime);
	}

	unregisterRuntime(agentId: string): void {
		this.runtimes.delete(agentId);
	}

	getRuntime(agentId: string): AgentRuntime | undefined {
		return this.runtimes.get(agentId);
	}

	toAgentConfig(record: AgentRecord): AgentConfig {
		let extraConfig: Record<string, unknown> = {};
		if (record.config) {
			try {
				extraConfig = JSON.parse(record.config);
			} catch {
				/* ignore */
			}
		}
		return {
			id: record.id,
			name: record.name,
			description: record.description ?? record.role,
			systemPrompt: record.system_prompt,
			model: record.model ?? undefined,
			maxTokens:
				typeof extraConfig.maxTokens === "number"
					? extraConfig.maxTokens
					: undefined,
			temperature:
				typeof extraConfig.temperature === "number"
					? extraConfig.temperature
					: undefined,
		};
	}

	private buildSystemPrompt(input: CreateAgentInput): string {
		const parts: string[] = [];
		parts.push(`You are ${input.name}, an AI assistant.`);
		if (input.role) parts.push(`Your role is: ${input.role}.`);
		if (input.personality) parts.push(`Your personality: ${input.personality}`);
		parts.push(
			"Help the user accomplish their tasks effectively and concisely.",
		);
		return parts.join("\n\n");
	}
}
