import { nanoid } from "nanoid";
import type { DatabaseAdapter } from "../storage/database.js";

export interface EnvVar {
	id: string;
	key: string;
	value: string;
	description: string | null;
	is_secret: number;
	created_at: string;
	updated_at: string;
}

export class EnvVarManager {
	constructor(private db: DatabaseAdapter) {}

	async set(
		key: string,
		value: string,
		opts?: { isSecret?: boolean; description?: string },
	): Promise<EnvVar> {
		const now = new Date().toISOString();
		const isSecret = (opts?.isSecret ?? false) ? 1 : 0;
		const description = opts?.description ?? null;
		const storedValue = isSecret
			? `enc:${Buffer.from(value, "utf-8").toString("base64")}`
			: value;

		const existing = await this.db.get<{ id: string }>(
			"SELECT id FROM env_vars WHERE key = ?",
			[key],
		);

		if (existing) {
			await this.db.run(
				"UPDATE env_vars SET value = ?, description = ?, is_secret = ?, updated_at = ? WHERE key = ?",
				[storedValue, description, isSecret, now, key],
			);
			return {
				id: existing.id,
				key,
				value: storedValue,
				description,
				is_secret: isSecret,
				created_at: now,
				updated_at: now,
			};
		}

		const id = nanoid(16);
		await this.db.run(
			"INSERT INTO env_vars (id, key, value, description, is_secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[id, key, storedValue, description, isSecret, now, now],
		);
		return {
			id,
			key,
			value: storedValue,
			description,
			is_secret: isSecret,
			created_at: now,
			updated_at: now,
		};
	}

	async get(key: string): Promise<string | null> {
		const row = await this.db.get<EnvVar>(
			"SELECT * FROM env_vars WHERE key = ?",
			[key],
		);
		if (!row) return null;
		return this.decodeValue(row);
	}

	async list(
		showSecrets?: boolean,
	): Promise<Array<Omit<EnvVar, "value"> & { value: string }>> {
		const rows = await this.db.all<EnvVar>(
			"SELECT * FROM env_vars ORDER BY key ASC",
		);
		return rows.map((row) => ({
			...row,
			value: row.is_secret && !showSecrets ? "••••••••" : this.decodeValue(row),
		}));
	}

	async delete(key: string): Promise<boolean> {
		const existing = await this.db.get<{ id: string }>(
			"SELECT id FROM env_vars WHERE key = ?",
			[key],
		);
		if (!existing) return false;
		await this.db.run("DELETE FROM env_vars WHERE key = ?", [key]);
		return true;
	}

	async resolveAsync(template: string): Promise<string> {
		const vars = await this.db.all<EnvVar>("SELECT * FROM env_vars");
		const varMap = new Map<string, string>();
		for (const v of vars) {
			varMap.set(v.key, this.decodeValue(v));
		}
		return template.replace(/\$\{(\w+)\}/g, (match, varName: string) => {
			return varMap.get(varName) ?? match;
		});
	}

	async toProcessEnv(): Promise<Record<string, string>> {
		const rows = await this.db.all<EnvVar>("SELECT * FROM env_vars");
		const env: Record<string, string> = {};
		for (const row of rows) {
			env[row.key] = this.decodeValue(row);
		}
		return env;
	}

	private decodeValue(row: EnvVar): string {
		if (row.is_secret && row.value.startsWith("enc:")) {
			return Buffer.from(row.value.slice(4), "base64").toString("utf-8");
		}
		return row.value;
	}
}
