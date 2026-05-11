import { Bot } from "grammy";
import type {
	Channel,
	ChannelMessage,
	ChannelMessageHandler,
} from "../types.js";

import { mediaContext } from "../../tools/media.js";

export class TelegramChannel implements Channel {
	public readonly name = "Telegram";
	public readonly type = "telegram";
	private bot: Bot;
	private messageHandlers: Set<ChannelMessageHandler> = new Set();
	private readonly processedMessageKeys = new Set<string>();
	private readonly recentMessageKeys: string[] = [];
	private isConnected = false;
	private static readonly maxRecentMessages = 1000;

	constructor(
		public readonly id: string,
		botToken: string,
	) {
		this.bot = new Bot(botToken);

		this.bot.on("message", async (ctx) => {
			const isGroup =
				ctx.chat.type === "group" || ctx.chat.type === "supergroup";
			const messageKey = `${ctx.chat.id}:${ctx.msg.message_id}`;
			if (!this.rememberMessage(messageKey)) return;

			let content = ctx.msg.text || ctx.msg.caption || "";

			try {
				if (ctx.msg.photo) {
					const photo = ctx.msg.photo[ctx.msg.photo.length - 1];
					const file = await ctx.api.getFile(photo.file_id);
					const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
					const buffer = await fetch(url).then((r) => r.arrayBuffer()).then(Buffer.from);
					const saved = await mediaContext.save(buffer, "image/jpeg", "Telegram Photo");
					content += `\n[Image attached: ${saved.url}]`;
				} else if (ctx.msg.voice) {
					const file = await ctx.api.getFile(ctx.msg.voice.file_id);
					const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
					const buffer = await fetch(url).then((r) => r.arrayBuffer()).then(Buffer.from);
					const saved = await mediaContext.save(buffer, ctx.msg.voice.mime_type || "audio/ogg", "Telegram Voice Note");
					content += `\n[Voice note attached: ${saved.url}]`;
				} else if (ctx.msg.audio) {
					const file = await ctx.api.getFile(ctx.msg.audio.file_id);
					const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
					const buffer = await fetch(url).then((r) => r.arrayBuffer()).then(Buffer.from);
					const saved = await mediaContext.save(buffer, ctx.msg.audio.mime_type || "audio/mpeg", ctx.msg.audio.file_name);
					content += `\n[Audio attached: ${saved.url}]`;
				} else if (ctx.msg.video) {
					const file = await ctx.api.getFile(ctx.msg.video.file_id);
					const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
					const buffer = await fetch(url).then((r) => r.arrayBuffer()).then(Buffer.from);
					const saved = await mediaContext.save(buffer, ctx.msg.video.mime_type || "video/mp4", ctx.msg.video.file_name);
					content += `\n[Video attached: ${saved.url}]`;
				} else if (ctx.msg.document) {
					const file = await ctx.api.getFile(ctx.msg.document.file_id);
					const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
					const buffer = await fetch(url).then((r) => r.arrayBuffer()).then(Buffer.from);
					const saved = await mediaContext.save(buffer, ctx.msg.document.mime_type || "application/octet-stream", ctx.msg.document.file_name);
					content += `\n[Document attached: ${saved.url}]`;
				}
			} catch (err) {
				console.error(`Error downloading media from Telegram for channel ${this.id}:`, err);
			}

			if (!content.trim()) return;

			const channelMessage: ChannelMessage = {
				id: String(ctx.msg.message_id),
				channelId: this.id,
				senderId: String(ctx.chat.id),
				senderName: ctx.from?.username || ctx.from?.first_name || undefined,
				content: content.trim(),
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
				void Promise.resolve()
					.then(() => handler(channelMessage))
					.catch((error) => {
						console.error(
							`Error in Telegram message handler for channel ${this.id}:`,
							error,
						);
					});
			}
		});
	}

	public async connect(): Promise<void> {
		if (this.isConnected) return;

		try {
			await this.bot.api.deleteWebhook({ drop_pending_updates: true });
		} catch (err) {
			console.warn(
				`Could not clear Telegram pending updates for channel ${this.id}:`,
				err,
			);
		}

		this.bot.start({
			drop_pending_updates: true,
			allowed_updates: ["message"],
		}).catch((err) => {
			console.error(`Telegram bot error for channel ${this.id}:`, err);
			this.isConnected = false;
		});
		this.isConnected = true;
	}

	public async disconnect(): Promise<void> {
		if (!this.isConnected) return;
		await this.bot.stop();
		this.isConnected = false;
	}

	private rememberMessage(messageKey: string): boolean {
		if (this.processedMessageKeys.has(messageKey)) return false;

		this.processedMessageKeys.add(messageKey);
		this.recentMessageKeys.push(messageKey);

		if (
			this.recentMessageKeys.length > TelegramChannel.maxRecentMessages
		) {
			const oldest = this.recentMessageKeys.shift();
			if (oldest) this.processedMessageKeys.delete(oldest);
		}

		return true;
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

	public onMessage(handler: ChannelMessageHandler): void {
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
