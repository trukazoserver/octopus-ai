export type ChannelMessageHandler = (
	msg: ChannelMessage,
) => void | Promise<void>;

export interface ChannelMessage {
	id: string;
	channelId: string;
	senderId: string;
	senderName?: string;
	content: string;
	timestamp: Date;
	replyTo?: string;
	isGroup: boolean;
	metadata?: Record<string, unknown>;
}

export interface Channel {
	id: string;
	name: string;
	type:
		| "whatsapp"
		| "telegram"
		| "discord"
		| "slack"
		| "teams"
		| "signal"
		| "wechat"
		| "webchat";
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	send(
		to: string,
		content: string,
		options?: { replyTo?: string },
	): Promise<string>;
	onMessage(handler: ChannelMessageHandler): void;
	isHealthy(): Promise<boolean>;
}
