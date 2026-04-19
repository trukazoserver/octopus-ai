import { describe, expect, it } from "vitest";
import { PermissionManager } from "../team/permissions.js";

describe("PermissionManager", () => {
	const pm = new PermissionManager();

	describe("admin role", () => {
		it("should have all permissions", () => {
			expect(pm.hasPermission("admin", "chat")).toBe(true);
			expect(pm.hasPermission("admin", "use_tools")).toBe(true);
			expect(pm.hasPermission("admin", "manage_plugins")).toBe(true);
			expect(pm.hasPermission("admin", "manage_users")).toBe(true);
			expect(pm.hasPermission("admin", "execute_code")).toBe(true);
			expect(pm.hasPermission("admin", "manage_config")).toBe(true);
			expect(pm.hasPermission("admin", "manage_skills")).toBe(true);
			expect(pm.hasPermission("admin", "create_tools")).toBe(true);
			expect(pm.hasPermission("admin", "install_packages")).toBe(true);
		});
	});

	describe("user role", () => {
		it("should allow chat, use_tools, execute_code", () => {
			expect(pm.hasPermission("user", "chat")).toBe(true);
			expect(pm.hasPermission("user", "use_tools")).toBe(true);
			expect(pm.hasPermission("user", "execute_code")).toBe(true);
			expect(pm.hasPermission("user", "create_tools")).toBe(true);
			expect(pm.hasPermission("user", "manage_memory")).toBe(true);
		});

		it("should deny admin-level actions", () => {
			expect(pm.hasPermission("user", "manage_plugins")).toBe(false);
			expect(pm.hasPermission("user", "manage_users")).toBe(false);
			expect(pm.hasPermission("user", "manage_config")).toBe(false);
			expect(pm.hasPermission("user", "install_packages")).toBe(false);
		});
	});

	describe("guest role", () => {
		it("should only allow chat", () => {
			expect(pm.hasPermission("guest", "chat")).toBe(true);
			expect(pm.hasPermission("guest", "use_tools")).toBe(false);
			expect(pm.hasPermission("guest", "manage_plugins")).toBe(false);
			expect(pm.hasPermission("guest", "execute_code")).toBe(false);
		});
	});
});
