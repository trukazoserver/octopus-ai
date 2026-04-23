import {
	ChannelManager,
	MessageType,
	TelegramChannel,
	TransportServer,
	mediaContext,
	InputFile,
} from "@octopus-ai/core";
import type { ChannelMessage } from "@octopus-ai/core";
import chalk from "chalk";
import { Command } from "commander";
import { bootstrap } from "../bootstrap.js";

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function markdownToTelegramHtml(md: string): string {
	let html = md.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "");
	html = html.replace(
		/```(\w*)\n([\s\S]*?)```/g,
		(_m, _lang: string, code: string) =>
			`<pre><code>${escapeHtml(code.trim())}</code></pre>`,
	);
	html = html.replace(
		/`([^`\n]+)`/g,
		(_m, code: string) => `<code>${escapeHtml(code)}</code>`,
	);
	html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
	html = html.replace(/__(.+?)__/g, "<b>$1</b>");
	html = html.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "<i>$1</i>");
	html = html.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "<i>$1</i>");
	html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");
	html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
	html = html.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
	html = html.replace(/^[\-\*]\s+(.+)$/gm, "• $1");
	html = html.replace(/^&gt;\s?(.+)$/gm, "<i>$1</i>");
	html = html.replace(/^[\-\*]{3,}$/gm, "──────────");
	html = html.replace(/\n{3,}/g, "\n\n");
	return html.trim();
}

function splitTelegramMessage(text: string, maxLen: number): string[] {
	if (text.length <= maxLen) return [text];
	const parts: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= maxLen) {
			parts.push(remaining);
			break;
		}
		let splitAt = remaining.lastIndexOf("\n", maxLen);
		if (splitAt < maxLen * 0.3) splitAt = remaining.lastIndexOf(" ", maxLen);
		if (splitAt < maxLen * 0.3) splitAt = maxLen;
		parts.push(remaining.substring(0, splitAt));
		remaining = remaining.substring(splitAt).trimStart();
	}
	return parts;
}

function stripToolMarkers(text: string): string {
	let clean = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "");
	return clean
		.replace(/^\n?[⚙️⚠️]+ .+ (?:completed|error:.*)\n?$/gm, "")
		.replace(/^\n?<!-- tool:[^>]+ -->\n?$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

type TelegramBotLike = {
	bot: {
		api: {
			sendMessage: (...args: any[]) => Promise<{ message_id: number }>;
			editMessageText: (...args: any[]) => Promise<unknown>;
			sendChatAction: (chat_id: string, action: string) => Promise<unknown>;
			sendPhoto: (chat_id: string, file: any, options?: any) => Promise<unknown>;
			sendAudio: (chat_id: string, file: any, options?: any) => Promise<unknown>;
			sendVideo: (chat_id: string, file: any, options?: any) => Promise<unknown>;
			sendDocument: (chat_id: string, file: any, options?: any) => Promise<unknown>;
		};
	};
};

export function createStartCommand(): Command {
	return new Command("start")
		.description("Start the Octopus AI server")
		.option("--channel <name>", "Start only a specific channel")
		.action(async (options: { channel?: string }) => {
			console.log(chalk.cyan.bold("\n🐙 Starting Octopus AI Server...\n"));
			let system: Awaited<ReturnType<typeof bootstrap>> | null = null;
			let server: TransportServer | null = null;
			const shutdown = async (signal: string) => {
				console.log(chalk.yellow(`\nReceived ${signal}, shutting down...`));
				if (server) {
					await server.stop();
					console.log(chalk.green("  ✓ Transport server stopped"));
				}
				if (system) {
					await system.shutdown();
					console.log(chalk.green("  ✓ Systems shut down"));
				}
				console.log(chalk.green("\nGoodbye! 👋\n"));
				process.exit(0);
			};
			process.on("SIGINT", () => shutdown("SIGINT"));
			process.on("SIGTERM", () => shutdown("SIGTERM"));
			try {
				system = await bootstrap();
				await system.automationRunner.initialize();
				
				const enabledChannels: string[] = [];
				const channels = system.config.channels;
				const channelManager = new ChannelManager(system.connectionManager);
				for (const [name, ch] of Object.entries(channels)) {
					if (!ch.enabled) continue;
					if (options.channel && options.channel !== name) continue;
					enabledChannels.push(name);
					try {
						if (name === "telegram") {
							const botToken = (ch as Record<string, unknown>).botToken as
								| string
								| undefined;
							if (botToken) {
								channelManager.register(
									new TelegramChannel("telegram", botToken),
								);
								console.log(chalk.green("  ✓ Telegram channel registered"));
							} else {
								console.log(
									chalk.yellow(
										"  ⚠ Telegram enabled but no botToken configured",
									),
								);
							}
						} else {
							system.connectionManager.registerChannel(name);
						}
					} catch (err) {
						console.log(
							chalk.red(`  ✗ Failed to register channel ${name}: ${err}`),
						);
					}
				}

				// Bridge: channel messages with persistent conversation memory
				channelManager.onMessage(async (msg: ChannelMessage) => {
					if (!system) return;
					const targetAgent = system.agentRuntime;
					const channel = channelManager.get(msg.channelId);
					const channelLabel = channel?.type ?? msg.channelId;
					let typingInterval: ReturnType<typeof setInterval> | undefined;
					if (channel?.type === "telegram") {
						const tg = channel as TelegramChannel;
						await tg.sendTyping(msg.senderId);
						typingInterval = setInterval(
							() => void tg.sendTyping(msg.senderId).catch(() => {}),
							4000,
						);
					}
					try {
						// Find or create persistent conversation
						const convKey = `${channelLabel}:${msg.senderId}`;
						const allConvs = await system.chatManager.listConversations({
							limit: 100,
						});
						let conv = allConvs.find((c) => c.channel === convKey);
						if (!conv) {
							const label = msg.senderName
								? `${msg.senderName} (${channelLabel})`
								: convKey;
							conv = await system.chatManager.createConversation({
								title: label,
								channel: convKey,
							});
						}
						const convId = conv.id;
						// Save user message
						await system.chatManager.addMessage(convId, "user", msg.content, {
							metadata: {
								source: channelLabel,
								senderId: msg.senderId,
								senderName: msg.senderName,
							},
						});
						// Load history into STM for context
						targetAgent.stm.clear();
						const history = await system.chatManager.getConversationMessages(
							convId,
							{ limit: 20 },
						);
						const prevMsgs = history.slice(0, -1);
						for (const m of prevMsgs) {
							if (m.role === "user" || m.role === "assistant") {
								targetAgent.stm.add({
									role: m.role,
									content: m.content,
									timestamp: new Date(m.timestamp),
								});
							}
						}
						// Stream response
						let accumulated = "";
						let lastSentLength = 0;
						let lastMessageId: string | undefined;
						for await (const chunk of targetAgent.processMessageStream(
							msg.content,
							msg.channelId,
						)) {
							const statusMatch = chunk.match(/^\0STATUS:(\w+)(?::([\w-]+))?(?::([A-Za-z0-9+/=]*))?\0$/);
							if (statusMatch) {
								if (channel?.type === "telegram") {
									const tgBot = (channel as unknown as TelegramBotLike).bot;
									let action = "typing";
									if (statusMatch[2]?.includes("image")) action = "upload_photo";
									else if (statusMatch[2]?.includes("voice") || statusMatch[2]?.includes("audio")) action = "record_voice";
									
									tgBot.api.sendChatAction(msg.senderId, action).catch(() => {});
								}
								continue;
							}
							accumulated += chunk;
							if (
								channel?.type === "telegram" &&
								accumulated.length - lastSentLength >= 100
							) {
							const tgBot = (channel as unknown as TelegramBotLike).bot;
								try {
									const safe = markdownToTelegramHtml(accumulated);
									if (lastMessageId) {
										await tgBot.api.editMessageText(
											msg.senderId,
											Number(lastMessageId),
											safe,
											{ parse_mode: "HTML" },
										);
									} else {
										const sent = await tgBot.api.sendMessage(
											msg.senderId,
											safe,
											{ parse_mode: "HTML" },
										);
										lastMessageId = String(sent.message_id);
									}
									lastSentLength = accumulated.length;
								} catch {
									try {
										if (lastMessageId) {
											await tgBot.api.editMessageText(
												msg.senderId,
												Number(lastMessageId),
												accumulated,
											);
										} else {
											const sent = await tgBot.api.sendMessage(
												msg.senderId,
												accumulated,
											);
											lastMessageId = String(sent.message_id);
										}
										lastSentLength = accumulated.length;
									} catch {}
								}
							}
						}
						// Save assistant response
						await system.chatManager.addMessage(
							convId,
							"assistant",
							accumulated,
							{
								metadata: { source: channelLabel },
							},
						);
						// Final formatted response
					if (channel?.type === "telegram") {
						const tgBot = (channel as unknown as TelegramBotLike).bot;
						accumulated = stripToolMarkers(accumulated);
						
						const mediaUrls: { url: string; alt: string; buffer?: Buffer; mimeType?: string }[] = [];
						if (accumulated.includes("/api/media/file/")) {
								const imgRegex = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+|\/api\/media\/file\/[^\s)]+)\)/g;
								let match;
								while ((match = imgRegex.exec(accumulated)) !== null) {
									mediaUrls.push({ alt: match[1], url: match[2] });
								}
								accumulated = accumulated.replace(imgRegex, "").trim();

								for (const media of mediaUrls) {
									if (!media.url.startsWith("/api/media/file/")) continue;
									try {
										const resolved = await mediaContext.resolve(media.url);
										media.buffer = resolved.buffer;
										media.mimeType = resolved.mimeType;
									} catch (err) {
										console.warn(`Could not resolve media url: ${media.url}`);
									}
								}
							}

							if (accumulated.length > 0) {
								const parts = splitTelegramMessage(accumulated, 4096);
							for (let i = 0; i < parts.length; i++) {
								const part = parts[i];
								if (!part) continue;
								const safe = markdownToTelegramHtml(part);
								try {
									if (i === 0 && lastMessageId) {
										await tgBot.api.editMessageText(
											msg.senderId,
											Number(lastMessageId),
											safe,
											{ parse_mode: "HTML" },
										);
									} else {
										await tgBot.api.sendMessage(msg.senderId, safe, {
											parse_mode: "HTML",
											reply_parameters:
												i === 0 ? { message_id: Number(msg.id) } : undefined,
										});
									}
								} catch {
									try {
										if (i === 0 && lastMessageId) {
											await tgBot.api.editMessageText(
												msg.senderId,
												Number(lastMessageId),
												part,
											);
										} else {
											await tgBot.api.sendMessage(msg.senderId, part);
										}
									} catch {}
								}
							}
							}

							for (const media of mediaUrls) {
								if (!media.buffer) continue;
								const inputFile = new InputFile(media.buffer);
								try {
									if (media.mimeType?.startsWith("audio/")) {
										await tgBot.api.sendAudio(msg.senderId, inputFile, { caption: media.alt });
									} else if (media.mimeType?.startsWith("video/")) {
										await tgBot.api.sendVideo(msg.senderId, inputFile, { caption: media.alt });
									} else {
										await tgBot.api.sendPhoto(msg.senderId, inputFile, { caption: media.alt });
									}
								} catch (err) {
									console.error("Error sending media to telegram", err);
								}
							}
						} else {
							await channelManager.send(
								msg.channelId,
								msg.senderId,
								accumulated,
								{ replyTo: msg.id },
							);
						}
					} catch (err) {
						console.error("Error processing channel message:", err);
					} finally {
						if (typingInterval) clearInterval(typingInterval);
						try {
							targetAgent.runConsolidation().catch((e) => console.error("LTM consolidation error:", e));
						} catch {}
					}
				});

				await channelManager.startAll();
				server = new TransportServer({
					port: system.config.server.port,
					host: system.config.server.host,
				});
				server.setSystemContext({
					config: system.config,
					ltm: system.ltm,
					memoryConsolidator: system.memoryConsolidator,
					skillRegistry: system.skillRegistry,
					pluginRegistry: system.pluginRegistry,
					codeExecutor: system.codeExecutor,
					chatManager: system.chatManager,
					agentManager: system.agentManager,
					taskManager: system.taskManager,
					automationManager: system.automationManager,
					envVarManager: system.envVarManager,
					mcpManager: system.mcpManager,
					embedFn: system.embedFn,
					userProfileManager: system.userProfileManager,
					agentRuntime: system.agentRuntime,
					toolRegistry: system.toolRegistry,
					dailyMemory: system.dailyMemory,
				});
				server.onMessage((clientId, message) => {
					let conversationId: string | undefined;
					void (async () => {
						if (!system || !server) return;
						try {
							const payload = message.payload as {
								message?: string;
								channelId?: string;
								stream?: boolean;
								conversationId?: string;
								agentId?: string;
							};
							if (!payload?.message) return;
							conversationId = payload.conversationId;
							const autoTitle =
								payload.message.length > 50
									? `${payload.message.substring(0, 50).trimEnd()}...`
									: payload.message;
							if (!conversationId) {
								const conv = await system.chatManager.createConversation({
									agentId: payload.agentId ?? undefined,
									title: autoTitle,
								});
								conversationId = conv.id;
							} else {
								const existing =
									await system.chatManager.getConversation(conversationId);
								if (!existing) {
									const conv = await system.chatManager.createConversation({
										agentId: payload.agentId ?? undefined,
										title: autoTitle,
									});
									conversationId = conv.id;
								}
							}
							await system.chatManager.addMessage(
								conversationId,
								"user",
								payload.message,
							);
							const targetAgent =
								payload.agentId && system.agentManager
									? (system.agentManager.getRuntime(payload.agentId) ??
										system.agentRuntime)
									: system.agentRuntime;
									
							targetAgent.stm.clear();
							const history = await system.chatManager.getConversationMessages(
								conversationId,
								{ limit: 20 },
							);
							// Don't include the very last one because processMessageStream adds it, wait actually addMessage was just called!
							// So the last message is the user message! We should slice(0, -1) if we let processMessageStream add the user message.
							// Yes, processMessageStream does `this.stm.add(userTurn);` with the new message.
							const prevMsgs = history.slice(0, -1);
							for (const m of prevMsgs) {
								if (m.role === "user" || m.role === "assistant") {
									targetAgent.stm.add({
										role: m.role,
										content: m.content,
										timestamp: new Date(m.timestamp),
									});
								}
							}

							if (payload.stream) {
								let fullText = "";
								const stream = targetAgent.processMessageStream(
									payload.message,
									payload.channelId,
								);
								for await (const chunk of stream) {
									const statusMatch = chunk.match(
										/^\0STATUS:(\w+)(?::([\w-]+))?(?::([A-Za-z0-9+/=]*))?\0$/,
									);
									if (statusMatch) {
										server.send(clientId, {
											id: message.id,
											type: MessageType.event,
											channel: message.channel,
											payload: {
												agentStatus: statusMatch[1],
												toolName: statusMatch[2] || null,
												uiIconB64: statusMatch[3] || null,
												conversationId,
											},
											timestamp: Date.now(),
										});
										continue;
									}
									fullText += chunk;
									const sent = server.send(clientId, {
										id: message.id,
										type: MessageType.stream,
										channel: message.channel,
										payload: { content: chunk, conversationId },
										timestamp: Date.now(),
									});
									if (!sent) break;
								}
								if (fullText.trim().length > 0) {
									await system.chatManager.addMessage(
										conversationId,
										"assistant",
										fullText,
									);
								}
								server.send(clientId, {
									id: message.id,
									type: MessageType.stream_end,
									channel: message.channel,
									payload: { done: true, conversationId },
									timestamp: Date.now(),
								});
							} else {
								const response = await targetAgent.processMessage(
									payload.message,
									payload.channelId,
								);
								await system.chatManager.addMessage(
									conversationId,
									"assistant",
									response,
								);
								server.send(clientId, {
									id: message.id,
									type: MessageType.response,
									channel: message.channel,
									payload: { content: response, conversationId },
									timestamp: Date.now(),
								});
							}
							
							try {
								targetAgent.runConsolidation().catch((e) => console.error("LTM consolidation error (web):", e));
							} catch {}
						} catch (err) {
							const errorMessage =
								err instanceof Error ? err.message : "Failed to process message";
							if (conversationId) {
								await system.chatManager.addMessage(
									conversationId,
									"assistant",
									`⚠️ Error: ${errorMessage}`,
								);
							}
							server.send(clientId, {
								id: message.id,
								type: MessageType.error,
								channel: message.channel,
								payload: {
									error: errorMessage,
									conversationId,
								},
								timestamp: Date.now(),
							});
						}
					})();
				});
				await server.start();
				system.connectionManager.startHealthMonitor(async () => true);
				const toolCount = system.toolRegistry.list().length;
				console.log(chalk.green("  ✓ Systems initialized"));
				console.log(chalk.green("  ✓ Transport server started"));
				console.log(chalk.green("  ✓ Health monitoring active"));
				console.log(chalk.green(`  ✓ ${toolCount} tools registered`));
				console.log(chalk.cyan("\n  Server Info:"));
				console.log(
					chalk.gray(`    Port:        ${system.config.server.port}`),
				);
				console.log(
					chalk.gray(`    Host:        ${system.config.server.host}`),
				);
				console.log(
					chalk.gray(`    Transport:   ${system.config.server.transport}`),
				);
				console.log(chalk.gray(`    AI Provider: ${system.config.ai.default}`));
				console.log(chalk.gray(`    Tools:       ${toolCount} available`));
				console.log(
					chalk.gray(
						enabledChannels.length > 0
							? `    Channels:    ${enabledChannels.join(", ")}`
							: "    Channels:    none enabled",
					),
				);
				console.log(
					chalk.green(
						`\n  Server running at ws://${system.config.server.host}:${system.config.server.port}`,
					),
				);
				console.log(chalk.gray("  Press Ctrl+C to stop\n"));
				await new Promise(() => {});
			} catch (err) {
				console.error(
					chalk.red("\n✗ Failed to start server:"),
					err instanceof Error ? err.stack : String(err),
				);
				if (server) await server.stop();
				if (system) await system.shutdown();
				process.exit(1);
			}
		});
}
