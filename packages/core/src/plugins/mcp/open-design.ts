import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import type { MCPServerConfig } from "../types.js";

const WINDOWS_NAMESPACE = "release-stable-win";
const WINDOWS_IPC_PATH = `\\\\.\\pipe\\open-design-${WINDOWS_NAMESPACE}-daemon`;

export interface OpenDesignIntegration {
	runtimePath: string;
	cliPath: string;
	dataDir: string;
	ipcPath: string;
	resourcesDir: string;
	mcpConfig: MCPServerConfig;
}

export interface OpenDesignDiscoveryOptions {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	fileExists?: (filePath: string) => boolean;
}

export function discoverOpenDesignIntegration(
	options: OpenDesignDiscoveryOptions = {},
): OpenDesignIntegration | undefined {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const fileExists = options.fileExists ?? existsSync;

	let runtimePath = env.OPEN_DESIGN_RUNTIME;
	let dataDir = env.OPEN_DESIGN_DATA_DIR;
	let ipcPath = env.OPEN_DESIGN_IPC_PATH;

	if (platform === "win32") {
		if (!runtimePath && env.LOCALAPPDATA) {
			runtimePath = join(
				env.LOCALAPPDATA,
				"Programs",
				"Open Design",
				"Open Design.exe",
			);
		}
		if (!dataDir && env.APPDATA) {
			dataDir = join(
				env.APPDATA,
				"Open Design",
				"namespaces",
				WINDOWS_NAMESPACE,
				"data",
			);
		}
		ipcPath ??= WINDOWS_IPC_PATH;
	}

	if (!runtimePath || !dataDir || !ipcPath) return undefined;

	const cliPath =
		env.OPEN_DESIGN_CLI ??
		join(
			dirname(runtimePath),
			"resources",
			"app",
			"prebundled",
			"daemon",
			"daemon-cli.mjs",
		);
	if (!fileExists(runtimePath) || !fileExists(cliPath)) return undefined;

	const resourcesDir =
		env.OPEN_DESIGN_RESOURCES ??
		join(dirname(runtimePath), "resources", "open-design");

	return {
		runtimePath,
		cliPath,
		dataDir,
		ipcPath,
		resourcesDir,
		mcpConfig: {
			type: "stdio",
			command: runtimePath,
			args: [cliPath, "mcp"],
			env: {
				OD_DATA_DIR: dataDir,
				OD_SIDECAR_IPC_PATH: ipcPath,
				ELECTRON_RUN_AS_NODE: "1",
			},
			enabled: true,
		},
	};
}

export async function isOpenDesignSidecarAvailable(
	ipcPath: string,
	timeoutMs = 750,
): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(ipcPath);
		let settled = false;
		const finish = (available: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(available);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

export async function ensureOpenDesignSidecar(
	integration: OpenDesignIntegration,
	timeoutMs = 30_000,
): Promise<boolean> {
	if (await isOpenDesignSidecarAvailable(integration.ipcPath)) return true;

	const childEnv = { ...process.env };
	childEnv.ELECTRON_RUN_AS_NODE = undefined;
	try {
		const child = spawn(integration.runtimePath, [], {
			detached: true,
			env: childEnv,
			stdio: "ignore",
			windowsHide: false,
		});
		child.unref();
	} catch {
		return false;
	}

	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await isOpenDesignSidecarAvailable(integration.ipcPath)) return true;
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	return false;
}
