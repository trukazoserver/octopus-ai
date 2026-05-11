import { spawn } from "node:child_process";
import { Socket } from "node:net";
import { platform as getPlatform } from "node:os";
import { ConfigLoader } from "@octopus-ai/core";

export type ExistingServerState = "free" | "octopus" | "occupied";

export type ServerAddress = {
	host: string;
	port: number;
	webUrl: string;
	wsUrl: string;
};

export function hostForBrowser(host: string): string {
	return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

export function getWebUrl(host: string, port: number): string {
	return `http://${hostForBrowser(host)}:${port}`;
}

export function getWsUrl(host: string, port: number): string {
	return `ws://${hostForBrowser(host)}:${port}`;
}

export function getConfiguredServerAddress(): ServerAddress {
	const config = new ConfigLoader().load();
	return {
		host: config.server.host,
		port: config.server.port,
		webUrl: getWebUrl(config.server.host, config.server.port),
		wsUrl: getWsUrl(config.server.host, config.server.port),
	};
}

export function openUrl(url: string): void {
	const platform = getPlatform();
	const command =
		platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
	const args = platform === "win32" ? ["/c", "start", "", url] : [url];
	const child = spawn(command, args, {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	child.unref();
}

function canConnect(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = new Socket();
		const finish = (connected: boolean) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(connected);
		};
		socket.setTimeout(800);
		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(false));
		socket.once("error", () => finish(false));
		socket.connect(port, hostForBrowser(host));
	});
}

export async function getExistingServerState(
	host: string,
	port: number,
): Promise<ExistingServerState> {
	const connected = await canConnect(host, port);
	if (!connected) return "free";

	try {
		const response = await fetch(`${getWebUrl(host, port)}/api/status`, {
			signal: AbortSignal.timeout(1200),
		});
		if (!response.ok) return "occupied";
		const data = (await response.json()) as { status?: string };
		return data.status === "running" ? "octopus" : "occupied";
	} catch {
		return "occupied";
	}
}

export async function detectConfiguredServer(): Promise<{
	address: ServerAddress;
	state: ExistingServerState;
}> {
	const address = getConfiguredServerAddress();
	return {
		address,
		state: await getExistingServerState(address.host, address.port),
	};
}
