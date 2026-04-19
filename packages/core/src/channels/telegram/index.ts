import { Bot } from "grammy";
import type { Channel, ChannelMessage } from "../types.js";

export class TelegramChannel implements Channel {
	public readonly name = "Telegram";
	public readonly type = "telegram";
	private bot: Bot;
	private messageHandlers: Set<(msg: ChannelMessage) => void> = new Set();
	private isConnected = false;

	constructor(
		public readonly id: string,
		botToken: string,
	) {
		this.bot = new Bot(botToken);

		this.bot.on("message:text", (ctx) => {
			const isGroup =
				ctx.chat.type === "group" || ctx.chat.type === "supergroup";

			const channelMessage: ChannelMessage = {
				id: String(ctx.msg.message_id),
				channelId: this.id,
				senderId: String(ctx.chat.id),
				senderName: ctx.from?.username || ctx.from?.first_name || undefined,
				content: ctx.msg.text,
				timestamp: new Date(ctx.msg.date * 1000),
				isGroup,
				replyTo: ctx.msg.reply_to_message
					? String(ctx.msg.reply_to_message.message_id)
					: undefined,
				metadata: {
					fromId: ctx.from?.id,
				},
			};

			for (const handler of this.messageHandlers) {
				try {
					handler(channelMessage);
				} catch (error) {
					console.error(
						`Error in Telegram message handler for channel ${this.id}:`,
						error,
					);
				}
			}
		});
	}

	public async connect(): Promise<void> {
		this.bot.start().catch((err) => {
			console.error(`Telegram bot error for channel ${this.id}:`, err);
			this.isConnected = false;
		});
		this.isConnected = true;
	}

	public async disconnect(): Promise<void> {
		await this.bot.stop();
		this.isConnected = false;
	}

	public async send(
		to: string,
		content: string,
		options?: { replyTo?: string },
	): Promise<string> {
		const msg = await this.bot.api.sendMessage(to, content, {
			reply_parameters: options?.replyTo
				? { message_id: Number.parseInt(options.replyTo, 10) }
				: undefined,
		});
		return String(msg.message_id);
	}

	public async sendTyping(chatId: string): Promise<void> {
		await this.bot.api.sendChatAction(chatId, "typing");
	}

	public onMessage(handler: (msg: ChannelMessage) => void): void {
		this.messageHandlers.add(handler);
	}

	public async isHealthy(): Promise<boolean> {
		try {
			await this.bot.api.getMe();
			return this.isConnected;
		} catch {
			return false;
		}
	}
}
