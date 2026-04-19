import type { ConnectionManager } from "../connection/manager.js";
import type { Channel, ChannelMessage } from "./types.js";

export class ChannelManager {
	private channels: Map<string, Channel>;
	private messageHandlers: Set<(msg: ChannelMessage) => void>;

	constructor(private connectionManager: ConnectionManager) {
		this.channels = new Map();
		this.messageHandlers = new Set();
	}

	public register(channel: Channel): void {
		this.channels.set(channel.id, channel);
		this.connectionManager.registerChannel(channel.id);

		channel.onMessage((msg: ChannelMessage) => {
			for (const handler of this.messageHandlers) {
				try {
					handler(msg);
				} catch (error) {
					console.error(
						`Error in message handler for channel ${channel.id}:`,
						error,
					);
				}
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

	public onMessage(handler: (msg: ChannelMessage) => void): void {
		this.messageHandlers.add(handler);
	}

	public async startAll(): Promise<void> {
		const connectPromises = Array.from(this.channels.values()).map((channel) =>
			channel.connect().catch((err) => {
				console.error(`Failed to connect channel ${channel.id}:`, err);
			}),
		);
		await Promise.all(connectPromises);
	}

	public async stopAll(): Promise<void> {
		const disconnectPromises = Array.from(this.channels.values()).map(
			(channel) =>
				channel.disconnect().catch((err) => {
					console.error(`Failed to disconnect channel ${channel.id}:`, err);
				}),
		);
		await Promise.all(disconnectPromises);
	}
}
