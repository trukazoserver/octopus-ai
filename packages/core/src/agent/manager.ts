import { nanoid } from "nanoid";
import type { DatabaseAdapter } from "../storage/database.js";
import { OCTOPUS_ARM_PROFILES } from "./arm-profiles.js";
import type { AgentRuntime } from "./runtime.js";
import type {
	AgentConfig,
	AgentReasoningEffort,
	AgentRecord,
	AgentStoredMessage,
	CreateAgentInput,
	CreateAgentMessageInput,
	ListAgentMessagesInput,
	SpawnSubagentInput,
} from "./types.js";

export class AgentManager {
	private runtimes: Map<string, AgentRuntime> = new Map();

	constructor(private db: DatabaseAdapter) {}

	async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
		const id = nanoid(16);
		const now = new Date().toISOString();
		const role = input.role ?? "assistant";
		const systemPrompt = input.systemPrompt ?? this.buildSystemPrompt(input);
		const config = input.config ? JSON.stringify(input.config) : null;
		const capabilities = input.capabilities
			? JSON.stringify(input.capabilities)
			: null;
		const toolPermissions = input.toolPermissions
			? JSON.stringify(input.toolPermissions)
			: null;
		const knowledgeBaseIds = input.knowledgeBaseIds
			? JSON.stringify(input.knowledgeBaseIds)
			: null;

		await this.db.run(
			"INSERT INTO agents (id, name, description, role, personality, system_prompt, model, avatar, color, is_default, is_main, parent_id, created_at, updated_at, config, fallback_model, capabilities, tool_permissions, knowledge_base_ids, can_spawn_subagents, max_spawn_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
				input.fallbackModel ?? null,
				capabilities,
				toolPermissions,
				knowledgeBaseIds,
				input.canSpawnSubagents === false ? 0 : 1,
				input.maxSpawnDepth ?? 2,
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
			is_builtin_arm: 0,
			arm_key: null,
			base_profile: null,
			user_overrides: null,
			capabilities,
			tool_permissions: toolPermissions,
			knowledge_base_ids: knowledgeBaseIds,
			fallback_model: input.fallbackModel ?? null,
			can_spawn_subagents: input.canSpawnSubagents === false ? 0 : 1,
			max_spawn_depth: input.maxSpawnDepth ?? 2,
		};
	}

	async ensureBuiltinArmAgents(defaultModel?: string): Promise<AgentRecord[]> {
		const now = new Date().toISOString();
		const records: AgentRecord[] = [];

		for (const profile of OCTOPUS_ARM_PROFILES) {
			const baseProfile = JSON.stringify(profile);
			const capabilities = JSON.stringify(profile.capabilities);
			const toolPermissions = JSON.stringify({
				mode: "allowlist",
				tools: profile.defaultTools,
			});
			const config = JSON.stringify({
				armKey: profile.key,
				defaultSkills: profile.defaultSkills,
				defaultTools: profile.defaultTools,
				partialEditable: true,
			});

			await this.db.run(
				"INSERT OR IGNORE INTO agents (id, name, description, role, personality, system_prompt, model, avatar, color, is_default, is_main, parent_id, created_at, updated_at, config, is_builtin_arm, arm_key, base_profile, user_overrides, capabilities, tool_permissions, knowledge_base_ids, fallback_model, can_spawn_subagents, max_spawn_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, ?, ?, ?, 1, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?)",
				[
					profile.agentId,
					profile.name,
					profile.description,
					profile.role,
					profile.personality,
					profile.systemPrompt,
					defaultModel ?? null,
					profile.avatar,
					profile.color,
					now,
					now,
					config,
					profile.key,
					baseProfile,
					capabilities,
					toolPermissions,
					profile.canSpawnSubagents ? 1 : 0,
					profile.maxSpawnDepth,
				],
			);

			await this.db.run(
				[
					"UPDATE agents SET",
					"name = ?, description = ?, role = ?, system_prompt = ?, avatar = ?, color = ?,",
					"is_default = 1, is_builtin_arm = 1, arm_key = ?, base_profile = ?, capabilities = ?,",
					"tool_permissions = ?, can_spawn_subagents = ?, max_spawn_depth = ?, updated_at = ?,",
					"model = COALESCE(model, ?)",
					"WHERE id = ?",
				].join(" "),
				[
					profile.name,
					profile.description,
					profile.role,
					profile.systemPrompt,
					profile.avatar,
					profile.color,
					profile.key,
					baseProfile,
					capabilities,
					toolPermissions,
					profile.canSpawnSubagents ? 1 : 0,
					profile.maxSpawnDepth,
					now,
					defaultModel ?? null,
					profile.agentId,
				],
			);

			const record = await this.getAgent(profile.agentId);
			if (record) records.push(record);
		}

		return records;
	}

	async getAgent(id: string): Promise<AgentRecord | null> {
		return (
			(await this.db.get<AgentRecord>("SELECT * FROM agents WHERE id = ?", [
				id,
			])) ?? null
		);
	}

	async sendMessage(
		input: CreateAgentMessageInput,
	): Promise<AgentStoredMessage> {
		const content = input.content.trim();
		if (!content) throw new Error("Agent message content is required");
		if (content.length > 32_000) {
			throw new Error("Agent message content exceeds 32000 characters");
		}
		if (input.toAgentId) {
			const to = await this.getAgent(input.toAgentId);
			if (!to) throw new Error(`Target agent not found: ${input.toAgentId}`);
		}

		const id = nanoid(16);
		const now = new Date().toISOString();
		const messageType = input.messageType ?? (input.toAgentId ? "message" : "broadcast");
		const metadata = input.metadata ? JSON.stringify(input.metadata) : null;
		await this.db.run(
			"INSERT INTO agent_messages (id, run_id, from_agent_id, to_agent_id, task_id, message_type, content, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				id,
				input.runId ?? null,
				input.fromAgentId,
				input.toAgentId ?? null,
				input.taskId ?? null,
				messageType,
				content,
				now,
				metadata,
			],
		);
		return {
			id,
			run_id: input.runId ?? null,
			from_agent_id: input.fromAgentId,
			to_agent_id: input.toAgentId ?? null,
			task_id: input.taskId ?? null,
			message_type: messageType,
			content,
			created_at: now,
			read_at: null,
			metadata,
		};
	}

	async listInbox(input: ListAgentMessagesInput): Promise<AgentStoredMessage[]> {
		const agent = await this.getAgent(input.agentId);
		if (!agent) throw new Error(`Agent not found: ${input.agentId}`);
		const where = input.includeBroadcasts
			? ["(to_agent_id = ? OR to_agent_id IS NULL)"]
			: ["to_agent_id = ?"];
		const params: unknown[] = [input.agentId];
		if (input.runId) {
			where.push("run_id = ?");
			params.push(input.runId);
		}
		if (input.unreadOnly) where.push("read_at IS NULL");
		const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
		params.push(limit);
		return this.db.all<AgentStoredMessage>(
			`SELECT * FROM agent_messages WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
			params,
		);
	}

	async markMessagesRead(
		agentId: string,
		messageIds: string[],
	): Promise<number> {
		const ids = [...new Set(messageIds.map((id) => id.trim()).filter(Boolean))];
		if (ids.length === 0) return 0;
		const now = new Date().toISOString();
		let updated = 0;
		for (const id of ids) {
			const message = await this.db.get<{ id: string }>(
				"SELECT id FROM agent_messages WHERE id = ? AND to_agent_id = ?",
				[id, agentId],
			);
			if (!message) continue;
			await this.db.run("UPDATE agent_messages SET read_at = ? WHERE id = ?", [
				now,
				id,
			]);
			updated += 1;
		}
		return updated;
	}

	async canSpawnSubagent(parentAgentId: string): Promise<{
		allowed: boolean;
		reason?: string;
		depth: number;
		maxDepth: number;
	}> {
		const parent = await this.getAgent(parentAgentId);
		if (!parent) {
			return { allowed: false, reason: "Parent agent not found", depth: 0, maxDepth: 0 };
		}
		const maxDepth = parent.max_spawn_depth ?? 0;
		const depth = await this.getAgentDepth(parent.id);
		if (parent.can_spawn_subagents === 0) {
			return { allowed: false, reason: "Parent agent cannot spawn subagents", depth, maxDepth };
		}
		if (depth >= maxDepth) {
			return { allowed: false, reason: "Max subagent depth reached", depth, maxDepth };
		}
		return { allowed: true, depth, maxDepth };
	}

	async spawnSubagent(input: SpawnSubagentInput): Promise<AgentRecord> {
		const decision = await this.canSpawnSubagent(input.parentAgentId);
		if (!decision.allowed) {
			throw new Error(decision.reason ?? "Subagent spawn is not allowed");
		}
		const parent = (await this.getAgent(input.parentAgentId)) as AgentRecord;
		return this.createAgent({
			...input,
			parentId: input.parentAgentId,
			toolPermissions: input.toolPermissions ?? this.parseJsonObject(parent.tool_permissions),
			knowledgeBaseIds:
				input.knowledgeBaseIds ?? this.parseJsonArray(parent.knowledge_base_ids),
			canSpawnSubagents:
				input.canSpawnSubagents ?? decision.depth + 1 < decision.maxDepth,
			maxSpawnDepth: decision.maxDepth,
		});
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
		const isBuiltinArm = existing.is_builtin_arm === 1;

		if (!isBuiltinArm && updates.name !== undefined) {
			fields.push("name = ?");
			values.push(updates.name);
		}
		if (updates.description !== undefined) {
			fields.push("description = ?");
			values.push(updates.description);
		}
		if (!isBuiltinArm && updates.role !== undefined) {
			fields.push("role = ?");
			values.push(updates.role);
		}
		if (updates.personality !== undefined) {
			fields.push("personality = ?");
			values.push(updates.personality);
		}
		if (!isBuiltinArm && updates.systemPrompt !== undefined) {
			fields.push("system_prompt = ?");
			values.push(updates.systemPrompt);
		}
		if (updates.model !== undefined) {
			fields.push("model = ?");
			values.push(updates.model);
		}
		if (!isBuiltinArm && updates.avatar !== undefined) {
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
		if (updates.fallbackModel !== undefined) {
			fields.push("fallback_model = ?");
			values.push(updates.fallbackModel);
		}
		if (updates.capabilities !== undefined) {
			fields.push("capabilities = ?");
			values.push(JSON.stringify(updates.capabilities));
		}
		if (updates.toolPermissions !== undefined) {
			fields.push("tool_permissions = ?");
			values.push(JSON.stringify(updates.toolPermissions));
		}
		if (updates.knowledgeBaseIds !== undefined) {
			fields.push("knowledge_base_ids = ?");
			values.push(JSON.stringify(updates.knowledgeBaseIds));
		}
		if (updates.canSpawnSubagents !== undefined) {
			fields.push("can_spawn_subagents = ?");
			values.push(updates.canSpawnSubagents ? 1 : 0);
		}
		if (updates.maxSpawnDepth !== undefined) {
			fields.push("max_spawn_depth = ?");
			values.push(updates.maxSpawnDepth);
		}

		if (isBuiltinArm) {
			fields.push("user_overrides = ?");
			values.push(
				JSON.stringify({
					personality: updates.personality,
					model: updates.model,
					fallbackModel: updates.fallbackModel,
					config: updates.config,
					capabilities: updates.capabilities,
					toolPermissions: updates.toolPermissions,
					knowledgeBaseIds: updates.knowledgeBaseIds,
					canSpawnSubagents: updates.canSpawnSubagents,
					maxSpawnDepth: updates.maxSpawnDepth,
				}),
			);
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
		if (existing.is_builtin_arm === 1) return false;
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

	// --- Per-agent, per-model reasoning profiles ---

	/** Read the persisted reasoning effort for an (agent, model) pair, if any. */
	async getModelProfile(
		agentId: string,
		model: string,
	): Promise<AgentReasoningEffort | undefined> {
		const row = await this.db.get<{ reasoning_effort: string }>(
			"SELECT reasoning_effort FROM agent_model_profiles WHERE agent_id = ? AND model = ?",
			[agentId, model],
		);
		if (!row) return undefined;
		const effort = row.reasoning_effort as AgentReasoningEffort;
		return ["none", "low", "medium", "high"].includes(effort) ? effort : undefined;
	}

	/** Persist (or update) the reasoning effort for an (agent, model) pair. */
	async upsertModelProfile(
		agentId: string,
		model: string,
		effort: AgentReasoningEffort,
	): Promise<void> {
		await this.db.run(
			`INSERT INTO agent_model_profiles (agent_id, model, reasoning_effort, created_at, updated_at)
			 VALUES (?, ?, ?, datetime('now'), datetime('now'))
			 ON CONFLICT(agent_id, model) DO UPDATE SET reasoning_effort = excluded.reasoning_effort, updated_at = datetime('now')`,
			[agentId, model, effort],
		);
	}

	/**
	 * Resolve the effective reasoning effort for an agent's model: the stored
	 * profile if present, otherwise the provided default (typically the model's
	 * capability default, or the global thinking setting during seeding).
	 */
	async resolveReasoningForModel(
		agentId: string,
		model: string,
		fallback: AgentReasoningEffort,
	): Promise<AgentReasoningEffort> {
		const stored = await this.getModelProfile(agentId, model);
		return stored ?? fallback;
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
			toolIterationLimit:
				typeof extraConfig.toolIterationLimit === "object" && extraConfig.toolIterationLimit !== null
					? extraConfig.toolIterationLimit as import("./types.js").ToolIterationLimitConfig
					: undefined,
			continuityGuard:
				typeof extraConfig.continuityGuard === "object" && extraConfig.continuityGuard !== null
					? extraConfig.continuityGuard as import("./types.js").ContinuityGuardRuntimeConfig
					: undefined,
			tenacidad:
				typeof extraConfig.tenacidad === "object" && extraConfig.tenacidad !== null
					? extraConfig.tenacidad as import("./types.js").TenacidadConfig
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

	private async getAgentDepth(agentId: string): Promise<number> {
		let depth = 0;
		let current = await this.getAgent(agentId);
		const seen = new Set<string>();
		while (current?.parent_id && !seen.has(current.parent_id)) {
			seen.add(current.id);
			depth += 1;
			current = await this.getAgent(current.parent_id);
		}
		return depth;
	}

	private parseJsonObject(value?: string | null): Record<string, unknown> | undefined {
		if (!value) return undefined;
		try {
			const parsed = JSON.parse(value) as unknown;
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: undefined;
		} catch {
			return undefined;
		}
	}

	private parseJsonArray(value?: string | null): string[] | undefined {
		if (!value) return undefined;
		try {
			const parsed = JSON.parse(value) as unknown;
			return Array.isArray(parsed)
				? parsed.filter((item): item is string => typeof item === "string")
				: undefined;
		} catch {
			return undefined;
		}
	}
}
