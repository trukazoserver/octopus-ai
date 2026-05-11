import { describe, expect, it } from "vitest";
import { resolveMCPSpawnCommand } from "../plugins/mcp/client.js";

describe("resolveMCPSpawnCommand", () => {
	it("uses the .cmd shim for npx and npm on Windows", () => {
		expect(resolveMCPSpawnCommand("npx", "win32")).toEqual({
			command: "npx.cmd",
			shell: false,
		});
		expect(resolveMCPSpawnCommand("npm", "win32")).toEqual({
			command: "npm.cmd",
			shell: false,
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
