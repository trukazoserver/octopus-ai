import { describe, expect, it, vi } from "vitest";
import { ChannelManager } from "../channels/manager.js";
import type { Channel } from "../channels/types.js";
import type { ConnectionManager } from "../connection/manager.js";

function createChannel(id: string, healthy = true): Channel {
	return {
		id,
		name: id,
		type: "telegram",
		connect: vi.fn(async () => undefined),
		disconnect: vi.fn(async () => undefined),
		send: vi.fn(async () => "sent"),
		onMessage: vi.fn(),
		isHealthy: vi.fn(async () => healthy),
	};
}

function createConnectionManager(): ConnectionManager {
	return {
		registerChannel: vi.fn(),
		startHealthMonitor: vi.fn(),
	} as unknown as ConnectionManager;
}

describe("ChannelManager runtime lifecycle", () => {
	it("starts, replaces, reports, and unregisters channels at runtime", async () => {
		const manager = new ChannelManager(createConnectionManager());
		const first = createChannel("telegram");
		const replacement = createChannel("telegram");
		manager.register(first);

		expect(await manager.start("telegram")).toBe(true);
		expect(await manager.getStatus("telegram")).toEqual({
			registered: true,
			connected: true,
			status: "connected",
		});

		await manager.replace(replacement, true);
		expect(first.disconnect).toHaveBeenCalledOnce();
		expect(replacement.connect).toHaveBeenCalledOnce();

		expect(await manager.unregister("telegram")).toBe(true);
		expect(replacement.disconnect).toHaveBeenCalledOnce();
		expect(await manager.getStatus("telegram")).toEqual({
			registered: false,
			connected: false,
			status: "disconnected",
		});
	});
});
