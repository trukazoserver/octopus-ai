import { spawn } from "node:child_process";
import { Socket } from "node:net";
import { platform as getPlatform } from "node:os";
import * as readline from "node:readline";
import {
	ChannelManager,
	ConfigLoader,
	InputFile,
	MessageType,
	TelegramChannel,
	TransportServer,
	mediaContext,
} from "@octopus-ai/core";
import type { ChannelMessage } from "@octopus-ai/core";
import chalk from "chalk";
import { Command } from "commander";
import { bootstrap } from "../bootstrap.js";
import {
	createLocalConsoleSession,
	createRemoteConsoleSession,
} from "../runtime/console-session.js";
import { runOctopusTui } from "../tui/index.js";

type StartOptions = {
	channel?: string;
	open?: boolean;
	console?: boolean;
	choice?: boolean;
};

type InterfaceMode = "web" | "console" | "server";

type ExistingServerState = "free" | "octopus" | "occupied";

const STREAM_CHECKPOINT_INTERVAL_MS = getPositiveIntEnv(
	"OCTOPUS_STREAM_CHECKPOINT_INTERVAL_MS",
	5000,
);
const CONVERSATION_HISTORY_LIMIT = getPositiveIntEnv(
	"OCTOPUS_CONVERSATION_HISTORY_LIMIT",
	80,
);

function getPositiveIntEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hostForBrowser(host: string): string {
	return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

function getWebUrl(host: string, port: number): string {
	return `http://${hostForBrowser(host)}:${port}`;
}

function openUrl(url: string): void {
	const platform = getPlatform();
	const command =
		platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
	const args = platform === "win32" ? ["/c", "start", "", url] : [url];
	const child = spawn(command, args, {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	child.unref();
}

function ask(prompt: string): Promise<string> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	return new Promise((resolve) => {
		rl.question(prompt, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

async function chooseInterfaceMode(webUrl: string): Promise<InterfaceMode> {
	console.log(chalk.cyan("\n  Elige cómo quieres usar Octopus ahora:"));
	console.log(chalk.gray(`    1. Abrir interfaz web (${webUrl})`));
	console.log(chalk.gray("    2. Quedarme en la consola/chat"));
	console.log(chalk.gray("    3. Solo dejar el servidor corriendo"));
	const answer = await ask(chalk.yellow("  Selección [1]: "));
	if (answer === "2") return "console";
	if (answer === "3") return "server";
	return "web";
}

function canConnect(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = new Socket();
		const finish = (connected: boolean) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(connected);
		};
		socket.setTimeout(800);
		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(false));
		socket.once("error", () => finish(false));
		socket.connect(port, hostForBrowser(host));
	});
}

async function getExistingServerState(
	host: string,
	port: number,
): Promise<ExistingServerState> {
	const connected = await canConnect(host, port);
	if (!connected) return "free";

	try {
		const response = await fetch(`${getWebUrl(host, port)}/api/status`, {
			signal: AbortSignal.timeout(1200),
		});
		if (!response.ok) return "occupied";
		const data = (await response.json()) as { status?: string };
		return data.status === "running" ? "octopus" : "occupied";
	} catch {
		return "occupied";
	}
}

async function runConsoleOnly(): Promise<void> {
	const system = await bootstrap();
	try {
		await runOctopusTui(
			createLocalConsoleSession(
				system,
				getWebUrl(system.config.server.host, system.config.server.port),
			),
		);
	} finally {
		await system.shutdown();
	}
}

async function handleExistingServer(options: StartOptions): Promise<boolean> {
	const config = new ConfigLoader().load();
	const webUrl = getWebUrl(config.server.host, config.server.port);
	const state = await getExistingServerState(
		config.server.host,
		config.server.port,
	);
	if (state === "free") return false;

	if (state === "occupied") {
		console.error(
			chalk.red(
				`\n✗ Port ${config.server.host}:${config.server.port} is already in use by another process.`,
			),
		);
		console.log(chalk.gray("  Windows: netstat -ano | findstr :18789"));
		console.log(chalk.gray("  Stop PID: taskkill /PID <pid> /F\n"));
		process.exit(1);
	}

	console.log(chalk.green(`\n  ✓ Octopus is already running at ${webUrl}`));
	let mode: InterfaceMode = "server";
	if (options.open) {
		mode = "web";
	} else if (options.console) {
		mode = "console";
	} else if (
		options.choice !== false &&
		process.stdin.isTTY &&
		!options.channel
	) {
		mode = await chooseInterfaceMode(webUrl);
	}

	if (mode === "web") {
		openUrl(webUrl);
		console.log(chalk.green("  ✓ Web interface opened\n"));
	} else if (mode === "console") {
		console.log(chalk.gray("\n  Attaching console to the existing server.\n"));
		const session = await createRemoteConsoleSession(
			webUrl,
			`ws://${hostForBrowser(config.server.host)}:${config.server.port}`,
		);
		await runOctopusTui(session);
	} else {
		console.log(
			chalk.gray(
				"  No new server was started. Existing server remains active.\n",
			),
		);
	}
	return true;
}

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

const TELEGRAM_STREAM_MIN_FLUSH_CHARS = 100;

function findTelegramStreamBoundary(text: string, minLength: number): number {
	let bestBoundary = -1;
	for (const match of text.matchAll(/\.|\n+/g)) {
		const end = (match.index ?? 0) + match[0].length;
		if (end >= minLength) bestBoundary = end;
	}
	return bestBoundary >= minLength ? bestBoundary : -1;
}

function getTelegramStreamFlushText(
	text: string,
	lastSentLength: number,
): string | null {
	if (text.length - lastSentLength < TELEGRAM_STREAM_MIN_FLUSH_CHARS) {
		return null;
	}
	const boundary = findTelegramStreamBoundary(
		text,
		lastSentLength + TELEGRAM_STREAM_MIN_FLUSH_CHARS,
	);
	if (boundary <= lastSentLength) return null;
	const flushText = text.slice(0, boundary).trimEnd();
	return flushText.length > lastSentLength ? flushText : null;
}

function stripToolMarkers(text: string): string {
	const clean = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "");
	return clean
		.replace(/^\n?(?:⚙️|⚠️)+ .+ (?:completed|error:.*)\n?$/gm, "")
		.replace(/^\n?<!-- tool:[^>]+ -->\n?$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

type TelegramBotLike = {
	bot: {
		api: {
			sendMessage: (...args: unknown[]) => Promise<{ message_id: number }>;
			editMessageText: (...args: unknown[]) => Promise<unknown>;
			sendChatAction: (chat_id: string, action: string) => Promise<unknown>;
			sendPhoto: (
				chat_id: string,
				file: unknown,
				options?: unknown,
			) => Promise<unknown>;
			sendAudio: (
				chat_id: string,
				file: unknown,
				options?: unknown,
			) => Promise<unknown>;
			sendVideo: (
				chat_id: string,
				file: unknown,
				options?: unknown,
			) => Promise<unknown>;
			sendDocument: (
				chat_id: string,
				file: unknown,
				options?: unknown,
			) => Promise<unknown>;
		};
	};
};

export async function runStart(options: StartOptions): Promise<void> {
	if (await handleExistingServer(options)) return;

			console.log(chalk.cyan.bold("\n🐙 Starting Octopus AI Server...\n"));
			let system: Awaited<ReturnType<typeof bootstrap>> | null = null;
			let server: TransportServer | null = null;
			let channelManager: ChannelManager | null = null;
			const shutdown = async (signal: string) => {
				console.log(chalk.yellow(`\nReceived ${signal}, shutting down...`));
				if (channelManager) {
					await channelManager.stopAll();
					console.log(chalk.green("  ✓ Channels stopped"));
				}
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
				channelManager = new ChannelManager(system.connectionManager);
				const activeChannelManager = channelManager;
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
								activeChannelManager.register(
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
				const channelProcessingQueues = new Map<string, Promise<void>>();
				activeChannelManager.onMessage(async (msg: ChannelMessage) => {
					if (!system) return;
					const targetAgent = system.agentRuntime;
					const chatManager = system.chatManager;
					const channel = activeChannelManager.get(msg.channelId);
					const channelLabel = channel?.type ?? msg.channelId;
					const queueKey = `${channelLabel}:${msg.senderId}`;
					const previousProcessing =
						channelProcessingQueues.get(queueKey) ?? Promise.resolve();
					let releaseProcessing!: () => void;
					const currentProcessing = new Promise<void>((resolve) => {
						releaseProcessing = resolve;
					});
					const queuedProcessing = previousProcessing
						.catch(() => {})
						.then(() => currentProcessing);
					channelProcessingQueues.set(queueKey, queuedProcessing);
					await previousProcessing.catch(() => {});
					let typingInterval: ReturnType<typeof setInterval> | undefined;
					let activeConvId: string | undefined;
					let accumulated = "";
					let assistantCheckpointId: string | undefined;
					let lastCheckpointAt = 0;
					if (channel?.type === "telegram") {
						const tg = channel as TelegramChannel;
						await tg.sendTyping(msg.senderId).catch(() => {});
						typingInterval = setInterval(
							() => void tg.sendTyping(msg.senderId).catch(() => {}),
							4000,
						);
					}
					try {
						// Find or create persistent conversation
						const convKey = queueKey;
						const allConvs = await chatManager.listConversations({
							limit: 100,
						});
						let conv = allConvs.find((c) => c.channel === convKey);
						if (!conv) {
							const label = msg.senderName
								? `${msg.senderName} (${channelLabel})`
								: convKey;
							conv = await chatManager.createConversation({
								title: label,
								channel: convKey,
							});
						}
						const convId = conv.id;
						activeConvId = convId;
						// Save user message
						await chatManager.addMessage(convId, "user", msg.content, {
							metadata: {
								source: channelLabel,
								senderId: msg.senderId,
								senderName: msg.senderName,
							},
						});
						// Load history into STM for context
						targetAgent.stm.clear();
						const history = await chatManager.getConversationMessages(
							convId,
							{ limit: CONVERSATION_HISTORY_LIMIT, recent: true },
						);
						const prevMsgs = history.slice(0, -1);
						for (const m of prevMsgs) {
							if (m.role === "user" || m.role === "assistant") {
								targetAgent.stm.add({
									role: m.role,
									content: m.content,
									timestamp: new Date(m.timestamp),
									metadata: { conversationId: convId },
								});
							}
						}
						// Stream response
						let lastSentLength = 0;
						let lastMessageId: string | undefined;
						const saveAssistantCheckpoint = async (
							status: "streaming" | "completed",
						) => {
							if (!accumulated.trim()) return;
							const metadata = {
								source: channelLabel,
								partial: status !== "completed",
								status,
								channelMessageId: msg.id,
							};
							if (assistantCheckpointId) {
								await chatManager.updateMessage(
									assistantCheckpointId,
									accumulated,
									{ metadata },
								);
							} else {
								const saved = await chatManager.addMessage(
									convId,
									"assistant",
									accumulated,
									{ metadata },
								);
								assistantCheckpointId = saved.id;
							}
							lastCheckpointAt = Date.now();
						};
						for await (const chunk of targetAgent.processMessageStream(
							msg.content,
							convId,
						)) {
							const statusMatch = chunk.match(
								/^\0STATUS:(\w+)(?::([\w-]+))?(?::([A-Za-z0-9+/=]*))?(?::([A-Za-z0-9+/=]*))?\0$/,
							);
							if (statusMatch) {
								if (channel?.type === "telegram") {
									const tgBot = (channel as unknown as TelegramBotLike).bot;
									let action = "typing";
									if (statusMatch[2]?.includes("image"))
										action = "upload_photo";
									else if (
										statusMatch[2]?.includes("voice") ||
										statusMatch[2]?.includes("audio")
									)
										action = "record_voice";

									tgBot.api
										.sendChatAction(msg.senderId, action)
										.catch(() => {});
								}
								continue;
							}
							accumulated += chunk;
							if (
								Date.now() - lastCheckpointAt >=
								STREAM_CHECKPOINT_INTERVAL_MS
							) {
								await saveAssistantCheckpoint("streaming");
							}
							const telegramFlushText =
								channel?.type === "telegram"
									? getTelegramStreamFlushText(accumulated, lastSentLength)
									: null;
							if (telegramFlushText) {
								const tgBot = (channel as unknown as TelegramBotLike).bot;
								try {
									const safe = markdownToTelegramHtml(telegramFlushText);
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
									lastSentLength = telegramFlushText.length;
								} catch {
									try {
										if (lastMessageId) {
											await tgBot.api.editMessageText(
												msg.senderId,
												Number(lastMessageId),
												telegramFlushText,
											);
										} else {
											const sent = await tgBot.api.sendMessage(
												msg.senderId,
												telegramFlushText,
											);
											lastMessageId = String(sent.message_id);
										}
										lastSentLength = telegramFlushText.length;
									} catch {}
								}
							}
						}
						// Save assistant response, upgrading any streaming checkpoint in-place.
						await saveAssistantCheckpoint("completed");
						// Final formatted response
						if (channel?.type === "telegram") {
							const tgBot = (channel as unknown as TelegramBotLike).bot;
							accumulated = stripToolMarkers(accumulated);

							const mediaUrls: {
								url: string;
								alt: string;
								buffer?: Buffer;
								mimeType?: string;
							}[] = [];
							if (accumulated.includes("/api/media/file/")) {
								const imgRegex =
									/!\[([^\]]*)\]\((https?:\/\/[^\s)]+|\/api\/media\/file\/[^\s)]+)\)/g;
								let match: RegExpExecArray | null = imgRegex.exec(accumulated);
								while (match !== null) {
									mediaUrls.push({ alt: match[1], url: match[2] });
									match = imgRegex.exec(accumulated);
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
										await tgBot.api.sendAudio(msg.senderId, inputFile, {
											caption: media.alt,
										});
									} else if (media.mimeType?.startsWith("video/")) {
										await tgBot.api.sendVideo(msg.senderId, inputFile, {
											caption: media.alt,
										});
									} else {
										await tgBot.api.sendPhoto(msg.senderId, inputFile, {
											caption: media.alt,
										});
									}
								} catch (err) {
									console.error("Error sending media to telegram", err);
								}
							}
						} else {
							await activeChannelManager.send(
								msg.channelId,
								msg.senderId,
								accumulated,
								{ replyTo: msg.id },
							);
						}
					} catch (err) {
						if (activeConvId && accumulated.trim()) {
							try {
								const metadata = {
									source: channelLabel,
									partial: true,
									status: "interrupted",
									channelMessageId: msg.id,
									error: err instanceof Error ? err.message : String(err),
								};
								if (assistantCheckpointId) {
									await chatManager.updateMessage(
										assistantCheckpointId,
										accumulated,
										{ metadata },
									);
								} else {
									await chatManager.addMessage(
										activeConvId,
										"assistant",
										accumulated,
										{ metadata },
									);
								}
							} catch (checkpointErr) {
								console.error("Error saving channel checkpoint:", checkpointErr);
							}
						}
						console.error("Error processing channel message:", err);
					} finally {
						if (typingInterval) clearInterval(typingInterval);
						releaseProcessing();
						if (channelProcessingQueues.get(queueKey) === queuedProcessing) {
							channelProcessingQueues.delete(queueKey);
						}
						try {
							targetAgent
								.runConsolidation()
								.catch((e) => console.error("LTM consolidation error:", e));
						} catch {}
					}
				});

				await activeChannelManager.startAll();
				server = new TransportServer({
					port: system.config.server.port,
					host: system.config.server.host,
				});
				server.setSystemContext({
					config: system.config,
					router: system.router,
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
					refreshBrowserTools: system.refreshBrowserTools,
					embedFn: system.embedFn,
					userProfileManager: system.userProfileManager,
					learningEngine: system.learningEngine,
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
								{ limit: CONVERSATION_HISTORY_LIMIT, recent: true },
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
										metadata: { conversationId },
									});
								}
							}

							if (payload.stream) {
								const streamConversationId = conversationId;
								if (!streamConversationId) {
									throw new Error("Conversation was not initialized for stream");
								}
								const chatManager = system.chatManager;
								let fullText = "";
								let assistantMessageId: string | undefined;
								let lastCheckpointAt = 0;
								const saveAssistantCheckpoint = async (
									status: "streaming" | "completed" | "interrupted",
									force = false,
								) => {
									if (!fullText.trim()) return;
									const now = Date.now();
									if (
										!force &&
										assistantMessageId &&
										now - lastCheckpointAt < STREAM_CHECKPOINT_INTERVAL_MS
									) {
										return;
									}
									const metadata = {
										status,
										partial: status !== "completed",
										checkpointedAt: new Date(now).toISOString(),
										source: "stream",
									};
									if (assistantMessageId) {
										await chatManager.updateMessage(
											assistantMessageId,
											fullText,
											{ metadata },
										);
									} else {
										const msg = await chatManager.addMessage(
											streamConversationId,
											"assistant",
											fullText,
											{ metadata },
										);
										assistantMessageId = msg.id;
									}
									lastCheckpointAt = now;
								};
								const stream = targetAgent.processMessageStream(
									payload.message,
									conversationId,
								);
								try {
									for await (const chunk of stream) {
										const statusMatch = chunk.match(
											/^\0STATUS:(\w+)(?::([\w-]+))?(?::([A-Za-z0-9+/=]*))?(?::([A-Za-z0-9+/=]*))?\0$/,
										);
										if (statusMatch) {
											let activityDetail: string | null = null;
											if (statusMatch[4]) {
												try {
													activityDetail = Buffer.from(
														statusMatch[4],
														"base64",
													).toString("utf8");
												} catch {
													activityDetail = null;
												}
											}
											server.send(clientId, {
												id: message.id,
												type: MessageType.event,
												channel: message.channel,
												payload: {
													agentStatus: statusMatch[1],
													toolName: statusMatch[2] || null,
													uiIconB64: statusMatch[3] || null,
													activityDetail,
													conversationId,
												},
												timestamp: Date.now(),
											});
											continue;
										}
										fullText += chunk;
										await saveAssistantCheckpoint("streaming");
										const sent = server.send(clientId, {
											id: message.id,
											type: MessageType.stream,
											channel: message.channel,
											payload: { content: chunk, conversationId },
											timestamp: Date.now(),
										});
										// if (!sent) break; // Removed to allow background execution
									}
								} catch (streamErr) {
									await saveAssistantCheckpoint("interrupted", true);
									throw streamErr;
								}
								if (fullText.trim().length > 0) {
									await saveAssistantCheckpoint("completed", true);
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
									conversationId,
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
								targetAgent
									.runConsolidation()
									.catch((e) =>
										console.error("LTM consolidation error (web):", e),
									);
							} catch {}
						} catch (err) {
							const errorMessage =
								err instanceof Error
									? err.message
									: "Failed to process message";
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
				const webUrl = getWebUrl(
					system.config.server.host,
					system.config.server.port,
				);
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
				console.log(chalk.green(`  Web interface: ${webUrl}`));

				let mode: InterfaceMode = "server";
				if (options.open) {
					mode = "web";
				} else if (options.console) {
					mode = "console";
				} else if (
					options.choice !== false &&
					process.stdin.isTTY &&
					!options.channel
				) {
					mode = await chooseInterfaceMode(webUrl);
				}

				if (mode === "web") {
					openUrl(webUrl);
					console.log(chalk.green("  ✓ Web interface opened"));
				} else if (mode === "console") {
					console.log(
						chalk.gray(
							"\n  Console mode active. Use /exit to return to the server process.\n",
						),
					);
					await runOctopusTui(createLocalConsoleSession(system, webUrl));
				}

				console.log(
					chalk.gray("  Server remains active. Press Ctrl+C to stop\n"),
				);
				await new Promise(() => {});
			} catch (err) {
				if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
					console.error(
						chalk.red(
							`\n✗ Port ${system?.config.server.host ?? "127.0.0.1"}:${system?.config.server.port ?? 18789} is already in use.`,
						),
					);
					console.log(
						chalk.gray(
							"  If Octopus is already running, open http://127.0.0.1:18789",
						),
					);
					console.log(chalk.gray("  Windows: netstat -ano | findstr :18789"));
					console.log(chalk.gray("  Stop PID: taskkill /PID <pid> /F\n"));
				} else {
					console.error(
						chalk.red("\n✗ Failed to start server:"),
						err instanceof Error ? err.stack : String(err),
					);
				}
				if (server) await server.stop();
				if (system) await system.shutdown();
				process.exit(1);
			}
}

export function createStartCommand(): Command {
	return new Command("start")
		.description("Start the Octopus AI server")
		.option("--channel <name>", "Start only a specific channel")
		.option("--open", "Open the web interface after startup")
		.option("--no-open", "Do not open the web interface after startup")
		.option("--console", "Enter the console chat after startup")
		.option("--no-choice", "Do not ask whether to open web or console")
		.action(async (options: StartOptions) => {
			await runStart(options);
		});
}
