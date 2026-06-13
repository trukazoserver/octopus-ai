import { describe, expect, it } from "vitest";
import {
	createMCPProcessEnv,
	resolveMCPSpawnCommand,
} from "../plugins/mcp/client.js";
import { EnvironmentFilter } from "../security/environment-filter.js";

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

describe("createMCPProcessEnv", () => {
	it("filters inherited secrets but preserves explicit server env", () => {
		const env = createMCPProcessEnv(
			{
				PATH: "/usr/bin",
				OCTOPUS_TEST_API_KEY: "inherited-secret",
			},
			{ OCTOPUS_TEST_API_KEY: "explicit-secret" },
			new EnvironmentFilter(),
		);

		expect(env.PATH).toBe("/usr/bin");
		expect(env.OCTOPUS_TEST_API_KEY).toBe("explicit-secret");
	});
});
