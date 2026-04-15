import { Client, GatewayIntentBits, Message } from 'discord.js';
import { Channel, ChannelMessage } from '../types.js';

export class DiscordChannel implements Channel {
    public readonly name = "Discord";
    public readonly type = "discord";
    private client: Client;
    private messageHandlers: Set<(msg: ChannelMessage) => void> = new Set();
    private botToken: string;

    constructor(
        public readonly id: string,
        botToken: string
    ) {
        this.botToken = botToken;
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages
            ]
        });

        this.client.on('messageCreate', (msg: Message) => {
            if (msg.author.bot) return;
            if (!msg.content) return;

            const isGroup = msg.channel.isDMBased() === false;
            
            const channelMessage: ChannelMessage = {
                id: msg.id,
                channelId: this.id,
                senderId: msg.channelId,
                senderName: msg.author.username,
                content: msg.content,
                timestamp: msg.createdAt,
                isGroup,
                replyTo: msg.reference?.messageId || undefined,
                metadata: {
                    authorId: msg.author.id,
                    guildId: msg.guildId
                }
            };

            for (const handler of this.messageHandlers) {
                try {
                    handler(channelMessage);
                } catch (error) {
                    console.error(`Error in Discord message handler for channel ${this.id}:`, error);
                }
            }
        });
    }

    public async connect(): Promise<void> {
        await this.client.login(this.botToken);
    }

    public async disconnect(): Promise<void> {
        this.client.destroy();
    }

    public async send(to: string, content: string, options?: { replyTo?: string }): Promise<string> {
        const channel = await this.client.channels.fetch(to);
        if (!channel || !channel.isTextBased() || !("send" in channel)) {
            throw new Error(`Invalid text channel: ${to}`);
        }

        const msg = await channel.send({
            content,
            reply: options?.replyTo ? { messageReference: options.replyTo } : undefined
        });

        return msg.id;
    }

    public onMessage(handler: (msg: ChannelMessage) => void): void {
        this.messageHandlers.add(handler);
    }

    public async isHealthy(): Promise<boolean> {
        return this.client.isReady();
    }
}
