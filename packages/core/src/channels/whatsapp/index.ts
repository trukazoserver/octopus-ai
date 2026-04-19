import {
	DisconnectReason,
	makeWASocket,
	useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import type { Channel, ChannelMessage } from "../types.js";

export class WhatsAppChannel implements Channel {
	public readonly name = "WhatsApp";
	public readonly type = "whatsapp";
	private sock: ReturnType<typeof makeWASocket> | null = null;
	private messageHandlers: Set<(msg: ChannelMessage) => void> = new Set();
	private isConnected = false;

	constructor(
		public readonly id: string,
		private authPath: string,
	) {}

	public async connect(): Promise<void> {
		const { state, saveCreds } = await useMultiFileAuthState(this.authPath);

		this.sock = makeWASocket({
			auth: state,
			printQRInTerminal: true,
		});

		this.sock.ev.on("creds.update", saveCreds);

		this.sock.ev.on("connection.update", (update) => {
			const { connection, lastDisconnect } = update;
			if (connection === "close") {
				this.isConnected = false;
				const shouldReconnect =
					(
						lastDisconnect?.error as unknown as {
							output?: { statusCode?: number };
						}
					)?.output?.statusCode !== DisconnectReason.loggedOut;
				if (shouldReconnect) {
					this.connect().catch(console.error);
				}
			} else if (connection === "open") {
				this.isConnected = true;
			}
		});

		this.sock.ev.on("messages.upsert", (m) => {
			if (m.type === "notify") {
				for (const msg of m.messages) {
					if (!msg.message) continue;

					const senderId = msg.key.remoteJid || "unknown";
					const isGroup = senderId.endsWith("@g.us");
					const content =
						msg.message.conversation ||
						msg.message.extendedTextMessage?.text ||
						"";

					if (!content) continue;

					const channelMessage: ChannelMessage = {
						id: msg.key.id || String(Date.now()),
						channelId: this.id,
						senderId,
						senderName: msg.pushName || undefined,
						content,
						timestamp: new Date(
							(msg.messageTimestamp as number) * 1000 || Date.now(),
						),
						isGroup,
						metadata: {
							participant: msg.key.participant,
						},
					};

					for (const handler of this.messageHandlers) {
						try {
							handler(channelMessage);
						} catch (error) {
							console.error(
								`Error in WhatsApp message handler for channel ${this.id}:`,
								error,
							);
						}
					}
				}
			}
		});
	}

	public async disconnect(): Promise<void> {
		if (this.sock) {
			this.sock.end(undefined);
			this.sock = null;
		}
		this.isConnected = false;
	}

	public async send(
		to: string,
		content: string,
		options?: { replyTo?: string },
	): Promise<string> {
		if (!this.sock) {
			throw new Error("WhatsApp socket not initialized");
		}

		const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
		const sentMsg = await this.sock.sendMessage(
			jid,
			{ text: content },
			{
				quoted: options?.replyTo
					? ({
							key: { id: options.replyTo, remoteJid: jid },
							message: { conversation: "" },
							// biome-ignore lint/suspicious/noExplicitAny: <explanation>
						} as any)
					: undefined,
			},
		);

		return sentMsg?.key?.id || String(Date.now());
	}

	public onMessage(handler: (msg: ChannelMessage) => void): void {
		this.messageHandlers.add(handler);
	}

	public async isHealthy(): Promise<boolean> {
		return this.isConnected && this.sock !== null;
	}
}
