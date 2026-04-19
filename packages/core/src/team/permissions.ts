import type { DatabaseAdapter } from "../storage/database.js";

export type Role = "admin" | "user" | "guest";

export interface RoleDefinition {
	name: Role;
	permissions: string[];
	description: string;
}

const DEFAULT_ROLES: RoleDefinition[] = [
	{
		name: "admin",
		permissions: [
			"chat",
			"use_tools",
			"manage_config",
			"manage_users",
			"manage_skills",
			"manage_plugins",
			"execute_code",
			"manage_memory",
			"manage_channels",
			"manage_workspace",
			"create_tools",
			"install_packages",
		],
		description: "Full access to all features",
	},
	{
		name: "user",
		permissions: [
			"chat",
			"use_tools",
			"execute_code",
			"manage_workspace",
			"manage_memory",
			"create_tools",
		],
		description: "Standard user with code execution and tool creation",
	},
	{
		name: "guest",
		permissions: ["chat"],
		description: "Read-only chat access",
	},
];

export class PermissionManager {
	private db: DatabaseAdapter | null;
	private roles: Map<string, RoleDefinition> = new Map();

	constructor(db?: DatabaseAdapter) {
		this.db = db ?? null;
		for (const role of DEFAULT_ROLES) {
			this.roles.set(role.name, role);
		}
	}

	async initialize(): Promise<void> {
		if (!this.db) return;

		await this.db.run(`CREATE TABLE IF NOT EXISTS role_overrides (
			role TEXT PRIMARY KEY,
			permissions TEXT NOT NULL,
			description TEXT,
			updatedAt TEXT NOT NULL
		)`);

		const rows = await this.db.all<{
			role: string;
			permissions: string;
			description: string;
		}>("SELECT * FROM role_overrides");

		for (const row of rows) {
			this.roles.set(row.role, {
				name: row.role as Role,
				permissions: JSON.parse(row.permissions),
				description: row.description ?? "",
			});
		}
	}

	hasPermission(role: Role, action: string): boolean {
		const definition = this.roles.get(role);
		if (!definition) return false;
		return definition.permissions.includes(action);
	}

	getPermissions(role: Role): string[] {
		return this.roles.get(role)?.permissions ?? [];
	}

	getRoleDefinition(role: Role): RoleDefinition | undefined {
		return this.roles.get(role);
	}

	listRoles(): RoleDefinition[] {
		return Array.from(this.roles.values());
	}

	async setPermissions(
		role: Role,
		permissions: string[],
		description?: string,
	): Promise<void> {
		const existing = this.roles.get(role);
		const def: RoleDefinition = {
			name: role,
			permissions,
			description: description ?? existing?.description ?? "",
		};
		this.roles.set(role, def);

		if (this.db) {
			await this.db.run(
				`INSERT INTO role_overrides (role, permissions, description, updatedAt)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(role) DO UPDATE SET
				 permissions = excluded.permissions,
				 description = excluded.description,
				 updatedAt = excluded.updatedAt`,
				[
					role,
					JSON.stringify(permissions),
					def.description,
					new Date().toISOString(),
				],
			);
		}
	}

	async addPermission(role: Role, permission: string): Promise<void> {
		const current = this.getPermissions(role);
		if (!current.includes(permission)) {
			current.push(permission);
			await this.setPermissions(role, current);
		}
	}

	async removePermission(role: Role, permission: string): Promise<void> {
		const current = this.getPermissions(role).filter((p) => p !== permission);
		await this.setPermissions(role, current);
	}

	getAllActions(): string[] {
		return [
			"chat",
			"use_tools",
			"manage_config",
			"manage_users",
			"manage_skills",
			"manage_plugins",
			"execute_code",
			"manage_memory",
			"manage_channels",
			"manage_workspace",
			"create_tools",
			"install_packages",
		];
	}
}
