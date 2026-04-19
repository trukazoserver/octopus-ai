import { nanoid } from "nanoid";
import type { DatabaseAdapter } from "../storage/database.js";

export interface Automation {
	id: string;
	name: string;
	description: string | null;
	trigger_type: string;
	trigger_config: string;
	action_type: string;
	action_config: string;
	agent_id: string | null;
	enabled: number;
	last_run: string | null;
	run_count: number;
	created_at: string;
	updated_at: string;
}

export interface CreateAutomationInput {
	name: string;
	description?: string;
	triggerType: string;
	triggerConfig: Record<string, unknown>;
	actionType: string;
	actionConfig: Record<string, unknown>;
	agentId?: string;
	enabled?: boolean;
}

export class AutomationManager {
	constructor(private db: DatabaseAdapter) {}

	async createAutomation(input: CreateAutomationInput): Promise<Automation> {
		const id = nanoid(16);
		const now = new Date().toISOString();
		await this.db.run(
			"INSERT INTO automations (id, name, description, trigger_type, trigger_config, action_type, action_config, agent_id, enabled, last_run, run_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)",
			[
				id,
				input.name,
				input.description ?? null,
				input.triggerType,
				JSON.stringify(input.triggerConfig),
				input.actionType,
				JSON.stringify(input.actionConfig),
				input.agentId ?? null,
				(input.enabled ?? true) ? 1 : 0,
				now,
				now,
			],
		);
		return {
			id,
			name: input.name,
			description: input.description ?? null,
			trigger_type: input.triggerType,
			trigger_config: JSON.stringify(input.triggerConfig),
			action_type: input.actionType,
			action_config: JSON.stringify(input.actionConfig),
			agent_id: input.agentId ?? null,
			enabled: (input.enabled ?? true) ? 1 : 0,
			last_run: null,
			run_count: 0,
			created_at: now,
			updated_at: now,
		};
	}

	async getAutomation(id: string): Promise<Automation | null> {
		return (
			(await this.db.get<Automation>("SELECT * FROM automations WHERE id = ?", [
				id,
			])) ?? null
		);
	}

	async listAutomations(): Promise<Automation[]> {
		return this.db.all<Automation>(
			"SELECT * FROM automations ORDER BY created_at DESC",
		);
	}

	async updateAutomation(
		id: string,
		updates: Partial<Omit<CreateAutomationInput, "name">> & {
			enabled?: boolean;
		},
	): Promise<boolean> {
		const existing = await this.getAutomation(id);
		if (!existing) return false;

		const fields: string[] = [];
		const values: unknown[] = [];
		const now = new Date().toISOString();

		if (updates.description !== undefined) {
			fields.push("description = ?");
			values.push(updates.description);
		}
		if (updates.triggerType !== undefined) {
			fields.push("trigger_type = ?");
			values.push(updates.triggerType);
		}
		if (updates.triggerConfig !== undefined) {
			fields.push("trigger_config = ?");
			values.push(JSON.stringify(updates.triggerConfig));
		}
		if (updates.actionType !== undefined) {
			fields.push("action_type = ?");
			values.push(updates.actionType);
		}
		if (updates.actionConfig !== undefined) {
			fields.push("action_config = ?");
			values.push(JSON.stringify(updates.actionConfig));
		}
		if (updates.agentId !== undefined) {
			fields.push("agent_id = ?");
			values.push(updates.agentId);
		}
		if (updates.enabled !== undefined) {
			fields.push("enabled = ?");
			values.push(updates.enabled ? 1 : 0);
		}

		if (fields.length === 0) return true;
		fields.push("updated_at = ?");
		values.push(now);
		values.push(id);
		await this.db.run(
			`UPDATE automations SET ${fields.join(", ")} WHERE id = ?`,
			values,
		);
		return true;
	}

	async deleteAutomation(id: string): Promise<boolean> {
		const existing = await this.getAutomation(id);
		if (!existing) return false;
		await this.db.run("DELETE FROM automations WHERE id = ?", [id]);
		return true;
	}

	async toggleAutomation(id: string): Promise<boolean> {
		const existing = await this.getAutomation(id);
		if (!existing) return false;
		const newEnabled = existing.enabled ? 0 : 1;
		const now = new Date().toISOString();
		await this.db.run(
			"UPDATE automations SET enabled = ?, updated_at = ? WHERE id = ?",
			[newEnabled, now, id],
		);
		return true;
	}

	async recordRun(id: string): Promise<void> {
		const now = new Date().toISOString();
		await this.db.run(
			"UPDATE automations SET last_run = ?, run_count = run_count + 1, updated_at = ? WHERE id = ?",
			[now, now, id],
		);
	}

	async getEnabledAutomations(): Promise<Automation[]> {
		return this.db.all<Automation>(
			"SELECT * FROM automations WHERE enabled = 1 ORDER BY created_at ASC",
		);
	}
}
