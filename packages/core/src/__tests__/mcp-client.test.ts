import { describe, expect, it } from "vitest";
import { resolveMCPSpawnCommand } from "../plugins/mcp/client.js";

describe("resolveMCPSpawnCommand", () => {
	it("uses the .cmd shim for package-manager commands on Windows", () => {
		expect(resolveMCPSpawnCommand("npx", "win32")).toEqual({
			command: "npx.cmd",
			shell: true,
		});
		expect(resolveMCPSpawnCommand("npm", "win32")).toEqual({
			command: "npm.cmd",
			shell: true,
		});
		expect(resolveMCPSpawnCommand("pnpm", "win32")).toEqual({
			command: "pnpm.cmd",
			shell: true,
		});
		expect(resolveMCPSpawnCommand("yarn", "win32")).toEqual({
			command: "yarn.cmd",
			shell: true,
		});
		expect(resolveMCPSpawnCommand("bun", "win32")).toEqual({
			command: "bun.cmd",
			shell: true,
		});
	});

	it("keeps other commands unchanged", () => {
		expect(resolveMCPSpawnCommand("node", "win32")).toEqual({
			command: "node",
			shell: false,
		});
		expect(resolveMCPSpawnCommand("npx", "linux")).toEqual({
			command: "npx",
			shell: false,
		});
	});
});
