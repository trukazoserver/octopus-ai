import type { ConnectionManager } from "../connection/manager.js";
import type {
	Channel,
	ChannelMessage,
	ChannelMessageHandler,
} from "./types.js";

export class ChannelManager {
	private channels: Map<string, Channel>;
	private messageHandlers: Set<ChannelMessageHandler>;

	constructor(private connectionManager: ConnectionManager) {
		this.channels = new Map();
		this.messageHandlers = new Set();
	}

	public register(channel: Channel): void {
		this.channels.set(channel.id, channel);
		this.connectionManager.registerChannel(channel.id);

		channel.onMessage((msg: ChannelMessage) => {
			for (const handler of this.messageHandlers) {
				void Promise.resolve()
					.then(() => handler(msg))
					.catch((error) => {
						console.error(
							`Error in message handler for channel ${channel.id}:`,
							error,
						);
					});
			}
		});

		this.connectionManager.startHealthMonitor(async (channelId: string) => {
			const ch = this.channels.get(channelId);
			if (ch) {
				return await ch.isHealthy();
			}
			return false;
		});
	}

	public get(id: string): Channel | undefined {
		return this.channels.get(id);
	}

	public getAll(): Channel[] {
		return Array.from(this.channels.values());
	}

	public async start(id: string): Promise<boolean> {
		const channel = this.channels.get(id);
		if (!channel) return false;
		await channel.connect();
		return channel.isHealthy();
	}

	public async stop(id: string): Promise<boolean> {
		const channel = this.channels.get(id);
		if (!channel) return false;
		await channel.disconnect();
		return true;
	}

	public async replace(channel: Channel, start = true): Promise<void> {
		const existing = this.channels.get(channel.id);
		if (start) {
			await channel.connect();
			const detailed = (
				channel as Channel & { getStatus?: () => { status: string } }
			).getStatus?.();
			const ready =
				(await channel.isHealthy()) ||
				(channel.type === "whatsapp" &&
					(detailed?.status === "connecting" || detailed?.status === "qr"));
			if (!ready) {
				await channel.disconnect().catch(() => undefined);
				throw new Error(`Channel ${channel.id} did not become ready`);
			}
		}
		if (existing) await existing.disconnect().catch(() => undefined);
		this.register(channel);
	}

	public async unregister(id: string): Promise<boolean> {
		const existing = this.channels.get(id);
		if (!existing) return false;
		await existing.disconnect().catch(() => undefined);
		this.channels.delete(id);
		return true;
	}

	public async getStatus(id: string): Promise<{
		registered: boolean;
		connected: boolean;
		status:
			| "connecting"
			| "qr"
			| "connected"
			| "disconnected"
			| "logged_out"
			| "error";
	}> {
		const channel = this.channels.get(id);
		if (!channel) {
			return { registered: false, connected: false, status: "disconnected" };
		}
		try {
			const detailed = (
				channel as Channel & {
					getStatus?: () => {
						status: "connecting" | "qr" | "connected" | "disconnected" | "logged_out";
						connected: boolean;
					};
				}
			).getStatus?.();
			if (detailed) return { registered: true, ...detailed };
			const connected = await channel.isHealthy();
			return {
				registered: true,
				connected,
				status: connected ? "connected" : "disconnected",
			};
		} catch {
			return { registered: true, connected: false, status: "error" };
		}
	}

	public async send(
		channelId: string,
		to: string,
		content: string,
		options?: { replyTo?: string },
	): Promise<string> {
		const channel = this.channels.get(channelId);
		if (!channel) {
			throw new Error(`Channel ${channelId} not found`);
		}

		try {
			return await this.connectionManager.executeWithRetry(channelId, () =>
				channel.send(to, content, options),
			);
		} catch (error) {
			this.connectionManager.getOfflineQueue(channelId).enqueue({
				operation: "send",
				payload: { to, content, options },
			});
			return "queued";
		}
	}

	public onMessage(handler: ChannelMessageHandler): void {
		this.messageHandlers.add(handler);
	}

	public async startAll(): Promise<void> {
		const connectPromises = Array.from(this.channels.values()).map((channel) =>
			this.start(channel.id).catch((err) => {
				console.error(`Failed to connect channel ${channel.id}:`, err);
			}),
		);
		await Promise.all(connectPromises);
	}

	public async stopAll(): Promise<void> {
		const disconnectPromises = Array.from(this.channels.values()).map(
			(channel) =>
				this.stop(channel.id).catch((err) => {
					console.error(`Failed to disconnect channel ${channel.id}:`, err);
				}),
		);
		await Promise.all(disconnectPromises);
	}
}
