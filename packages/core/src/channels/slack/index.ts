import { App } from "@slack/bolt";
import type { Channel, ChannelMessage } from "../types.js";

export class SlackChannel implements Channel {
	public readonly name = "Slack";
	public readonly type = "slack";
	private app: App;
	private messageHandlers: Set<(msg: ChannelMessage) => void> = new Set();
	private isConnected = false;

	constructor(
		public readonly id: string,
		token: string,
		signingSecret: string,
		appToken: string,
	) {
		this.app = new App({
			token,
			signingSecret,
			appToken,
			socketMode: true,
		});

		this.app.message(async ({ message }) => {
			if (!("text" in message) || !message.text) return;
			if (message.subtype && message.subtype === "bot_message") return;

			const isGroup = message.channel_type !== "im";

			const channelMessage: ChannelMessage = {
				id: message.ts,
				channelId: this.id,
				senderId: message.channel,
				senderName: "user" in message ? message.user : undefined,
				content: message.text,
				timestamp: new Date(Number.parseFloat(message.ts) * 1000),
				isGroup,
				replyTo: "thread_ts" in message ? message.thread_ts : undefined,
				metadata: {
					user: "user" in message ? message.user : undefined,
				},
			};

			for (const handler of this.messageHandlers) {
				try {
					handler(channelMessage);
				} catch (error) {
					console.error(
						`Error in Slack message handler for channel ${this.id}:`,
						error,
					);
				}
			}
		});
	}

	public async connect(): Promise<void> {
		await this.app.start();
		this.isConnected = true;
	}

	public async disconnect(): Promise<void> {
		await this.app.stop();
		this.isConnected = false;
	}

	public async send(
		to: string,
		content: string,
		options?: { replyTo?: string },
	): Promise<string> {
		const result = await this.app.client.chat.postMessage({
			channel: to,
			text: content,
			thread_ts: options?.replyTo,
		});

		return result.ts || String(Date.now());
	}

	public onMessage(handler: (msg: ChannelMessage) => void): void {
		this.messageHandlers.add(handler);
	}

	public async isHealthy(): Promise<boolean> {
		try {
			await this.app.client.api.test();
			return this.isConnected;
		} catch {
			return false;
		}
	}
}
