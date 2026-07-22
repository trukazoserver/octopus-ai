import { describe, expect, it } from "vitest";
import { discoverOpenDesignIntegration } from "../plugins/mcp/open-design.js";

describe("Open Design MCP integration", () => {
	it("discovers the default per-user Windows installation", () => {
		const integration = discoverOpenDesignIntegration({
			platform: "win32",
			env: {
				LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
				APPDATA: "C:\\Users\\test\\AppData\\Roaming",
			},
			fileExists: () => true,
		});

		expect(integration?.runtimePath).toBe(
			"C:\\Users\\test\\AppData\\Local\\Programs\\Open Design\\Open Design.exe",
		);
		expect(integration?.mcpConfig.args).toEqual([
			"C:\\Users\\test\\AppData\\Local\\Programs\\Open Design\\resources\\app\\prebundled\\daemon\\daemon-cli.mjs",
			"mcp",
		]);
		expect(integration?.mcpConfig.env).toMatchObject({
			ELECTRON_RUN_AS_NODE: "1",
			OD_SIDECAR_IPC_PATH: "\\\\.\\pipe\\open-design-release-stable-win-daemon",
		});
	});

	it("supports explicit paths on other platforms", () => {
		const integration = discoverOpenDesignIntegration({
			platform: "linux",
			env: {
				OPEN_DESIGN_RUNTIME: "/opt/open-design/node",
				OPEN_DESIGN_CLI: "/opt/open-design/daemon-cli.mjs",
				OPEN_DESIGN_DATA_DIR: "/home/test/.open-design",
				OPEN_DESIGN_IPC_PATH: "/tmp/open-design.sock",
				OPEN_DESIGN_RESOURCES: "/opt/open-design/resources",
			},
			fileExists: () => true,
		});

		expect(integration).toMatchObject({
			resourcesDir: "/opt/open-design/resources",
			mcpConfig: {
				command: "/opt/open-design/node",
				args: ["/opt/open-design/daemon-cli.mjs", "mcp"],
			},
		});
	});

	it("does not register an incomplete or missing installation", () => {
		expect(
			discoverOpenDesignIntegration({
				platform: "linux",
				env: {},
				fileExists: () => true,
			}),
		).toBeUndefined();
		expect(
			discoverOpenDesignIntegration({
				platform: "win32",
				env: { LOCALAPPDATA: "C:\\Local", APPDATA: "C:\\Roaming" },
				fileExists: () => false,
			}),
		).toBeUndefined();
	});
});
