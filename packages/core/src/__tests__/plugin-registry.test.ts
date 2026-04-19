import { beforeEach, describe, expect, it } from "vitest";
import { PluginRegistry } from "../plugins/registry.js";
import type { Plugin, SlashCommand } from "../plugins/types.js";

describe("PluginRegistry", () => {
	let registry: PluginRegistry;

	beforeEach(() => {
		registry = new PluginRegistry();
	});

	const createPlugin = (name: string, version = "1.0.0"): Plugin => ({
		manifest: {
			name,
			version,
			description: `Test plugin ${name}`,
			author: "test",
		},
		commands: [
			{
				name: `/${name}-cmd`,
				description: `Command for ${name}`,
				execute: async () => `result from ${name}`,
			},
		],
		onLoad: async () => {},
		onUnload: async () => {},
	});

	describe("register", () => {
		it("should register a plugin", () => {
			const plugin = createPlugin("test-plugin");
			registry.register(plugin);
			expect(registry.get("test-plugin")).toBe(plugin);
		});

		it("should overwrite existing plugin with same name", () => {
			const plugin1 = createPlugin("test", "1.0.0");
			const plugin2 = createPlugin("test", "2.0.0");
			registry.register(plugin1);
			registry.register(plugin2);
			expect(registry.get("test")?.manifest.version).toBe("2.0.0");
		});
	});

	describe("unregister", () => {
		it("should unregister a plugin and call onUnload", async () => {
			let unloaded = false;
			const plugin: Plugin = {
				manifest: {
					name: "test",
					version: "1.0.0",
					description: "test",
					author: "test",
				},
				onUnload: async () => {
					unloaded = true;
				},
			};
			registry.register(plugin);
			await registry.unregister("test");
			expect(registry.get("test")).toBeUndefined();
			expect(unloaded).toBe(true);
		});

		it("should handle unregistering non-existent plugin", async () => {
			await expect(registry.unregister("nonexistent")).resolves.toBeUndefined();
		});
	});

	describe("get", () => {
		it("should return undefined for non-existent plugin", () => {
			expect(registry.get("nonexistent")).toBeUndefined();
		});
	});

	describe("getAll", () => {
		it("should return all registered plugins", () => {
			registry.register(createPlugin("a"));
			registry.register(createPlugin("b"));
			registry.register(createPlugin("c"));
			expect(registry.getAll()).toHaveLength(3);
		});

		it("should return empty array when no plugins registered", () => {
			expect(registry.getAll()).toHaveLength(0);
		});
	});

	describe("getCommands", () => {
		it("should return all commands from all plugins", () => {
			registry.register(createPlugin("a"));
			registry.register(createPlugin("b"));
			const commands = registry.getCommands();
			expect(commands).toHaveLength(2);
		});

		it("should exclude plugins without commands", () => {
			registry.register({
				manifest: {
					name: "no-cmd",
					version: "1.0.0",
					description: "test",
					author: "test",
				},
			});
			registry.register(createPlugin("with-cmd"));
			expect(registry.getCommands()).toHaveLength(1);
		});
	});

	describe("getMCPServers", () => {
		it("should return all MCP servers from plugins", () => {
			registry.register({
				manifest: {
					name: "mcp",
					version: "1.0.0",
					description: "test",
					author: "test",
				},
				mcpServers: [{ command: "node", args: ["server.js"] }],
			});
			expect(registry.getMCPServers()).toHaveLength(1);
		});
	});
});
