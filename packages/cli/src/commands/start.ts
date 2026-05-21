import { spawn } from "node:child_process";
import { Socket } from "node:net";
import { platform as getPlatform } from "node:os";
import * as readline from "node:readline";
import {
	ChannelManager,
	ChatExecutionManager,
	type ChatManager,
	ConfigLoader,
	InputFile,
	MessageType,
	TelegramChannel,
	TransportServer,
	mediaContext,
} from "@octopus-ai/core";
import type { ChannelMessage, Conversation } from "@octopus-ai/core";
import chalk from "chalk";
import { Command } from "commander";
import { type OctopusSystem, bootstrap } from "../bootstrap.js";
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

export function buildTransportSystemContext(
	system: OctopusSystem,
	chatExecutionManager: ChatExecutionManager,
): Pick<OctopusSystem, "config"> & Record<string, unknown> {
	return {
		config: system.config,
		db: system.db,
		router: system.router,
		ltm: system.ltm,
		memoryOrchestrator: system.memoryOrchestrator,
		contextAssembler: system.contextAssembler,
		memoryConsolidator: system.memoryConsolidator,
		skillRegistry: system.skillRegistry,
		pluginRegistry: system.pluginRegistry,
		codeExecutor: system.codeExecutor,
		chatManager: system.chatManager,
		chatExecutionManager,
		agentManager: system.agentManager,
		taskManager: system.taskManager,
		automationManager: system.automationManager,
		envVarManager: system.envVarManager,
		mcpManager: system.mcpManager,
		refreshBrowserTools: system.refreshBrowserTools,
		refreshEmbeddingProvider: system.refreshEmbeddingProvider,
		reloadDynamicTool: system.reloadDynamicTool,
		embedFn: system.embedFn,
		userProfileManager: system.userProfileManager,
		learningEngine: system.learningEngine,
		agentRuntime: system.agentRuntime,
		toolRegistry: system.toolRegistry,
		dailyMemory: system.dailyMemory,
	};
}

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

type TelegramConversationCommand =
	| { action: "help" }
	| { action: "new"; title?: string }
	| { action: "clear" }
	| { action: "delete"; ref?: string }
	| { action: "list" }
	| { action: "search"; query?: string }
	| { action: "open"; ref?: string }
	| { action: "rename"; title?: string }
	| { action: "current" };

function normalizeTelegramCommandName(name: string): string {
	return name
		.split("@")[0]
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase();
}

function parseTelegramConversationCommand(
	content: string,
): TelegramConversationCommand | null {
	const trimmed = content.trim();
	if (!trimmed.startsWith("/")) return null;
	const [rawCommand = "", ...restParts] = trimmed.split(/\s+/);
	const command = normalizeTelegramCommandName(rawCommand.slice(1));
	const rest = restParts.join(" ").trim();

	switch (command) {
		case "start":
		case "ayuda":
		case "help":
		case "comandos":
			return { action: "help" };
		case "nueva":
		case "nuevo":
		case "new":
		case "reiniciar":
		case "reset":
			return { action: "new", title: rest || undefined };
		case "limpiar":
		case "clear":
		case "vaciar":
			return { action: "clear" };
		case "borrar":
		case "eliminar":
		case "delete":
		case "borrar_conversacion":
		case "eliminar_conversacion":
			return { action: "delete", ref: rest || undefined };
		case "listar":
		case "lista":
		case "conversaciones":
		case "historial":
		case "chats":
			return { action: "list" };
		case "buscar":
		case "search":
			return { action: "search", query: rest || undefined };
		case "abrir":
		case "usar":
		case "continuar":
		case "switch":
			return { action: "open", ref: rest || undefined };
		case "renombrar":
		case "nombre":
		case "rename":
			return { action: "rename", title: rest || undefined };
		case "actual":
		case "estado":
		case "current":
			return { action: "current" };
		default:
			return null;
	}
}

function getTelegramConversationTitle(
	msg: ChannelMessage,
	channelLabel: string,
	title?: string,
): string {
	if (title?.trim()) return title.trim().slice(0, 140);
	const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
	const owner = msg.senderName
		? `${msg.senderName} (${channelLabel})`
		: channelLabel;
	return `${owner} ${timestamp}`;
}

async function getTelegramChatConversations(
	chatManager: ChatManager,
	convKey: string,
	limit = 100,
): Promise<Conversation[]> {
	const conversations = await chatManager.listConversations({ limit });
	return conversations.filter(
		(conversation) => conversation.channel === convKey,
	);
}

function formatConversationDate(conversation: Conversation): string {
	return conversation.updated_at.replace("T", " ").slice(0, 16);
}

function formatConversationLine(
	conversation: Conversation,
	index: number,
	activeId?: string,
): string {
	const active = conversation.id === activeId ? " <b>(actual)</b>" : "";
	const title = conversation.title?.trim() || "Sin titulo";
	return `${index}. <code>${escapeHtml(conversation.id.slice(0, 8))}</code> ${escapeHtml(title)} - ${escapeHtml(formatConversationDate(conversation))}${active}`;
}

function findConversationByRef(
	conversations: Conversation[],
	ref: string,
): Conversation | null {
	const normalized = ref.trim().toLowerCase();
	if (!normalized) return null;
	return (
		conversations.find(
			(conversation) =>
				conversation.id.toLowerCase() === normalized ||
				conversation.id.toLowerCase().startsWith(normalized),
		) ??
		conversations.find((conversation) =>
			(conversation.title ?? "").toLowerCase().includes(normalized),
		) ??
		null
	);
}

async function sendTelegramCommandMessage(
	tgBot: TelegramBotLike["bot"],
	chatId: string,
	text: string,
	replyTo?: string,
): Promise<void> {
	try {
		await tgBot.api.sendMessage(chatId, text, {
			parse_mode: "HTML",
			reply_parameters: replyTo ? { message_id: Number(replyTo) } : undefined,
		});
	} catch {
		await tgBot.api.sendMessage(
			chatId,
			text.replace(/<[^>]+>/g, ""),
			replyTo
				? { reply_parameters: { message_id: Number(replyTo) } }
				: undefined,
		);
	}
}

function getTelegramHelpText(): string {
	return [
		"<b>Comandos de conversaciones</b>",
		"/nueva [titulo] - inicia otro contexto. Telegram seguira mostrando el historial visual.",
		"/limpiar - borra el contexto interno actual y empieza uno vacio.",
		"/borrar [id|titulo] - borra la actual o una conversacion encontrada.",
		"/listar - muestra las ultimas conversaciones de este chat.",
		"/buscar &lt;texto&gt; - busca conversaciones por mensajes.",
		"/abrir &lt;id|titulo&gt; - vuelve a una conversacion encontrada.",
		"/renombrar &lt;titulo&gt; - cambia el titulo de la actual.",
		"/actual - muestra la conversacion activa.",
		"",
		"Nota: Telegram no permite que el bot cree otra ventana de chat privado ni oculte mensajes anteriores. Estos comandos cambian lo que Octopus usa como memoria/contexto.",
	].join("\n");
}

async function handleTelegramConversationCommand(opts: {
	command: TelegramConversationCommand;
	msg: ChannelMessage;
	chatManager: ChatManager;
	tgBot: TelegramBotLike["bot"];
	channelLabel: string;
	convKey: string;
}): Promise<void> {
	const { command, msg, chatManager, tgBot, channelLabel, convKey } = opts;
	const conversations = await getTelegramChatConversations(
		chatManager,
		convKey,
	);
	const current = conversations[0];
	const reply = (text: string) =>
		sendTelegramCommandMessage(tgBot, msg.senderId, text, msg.id);

	switch (command.action) {
		case "help": {
			await reply(getTelegramHelpText());
			return;
		}
		case "new": {
			const conv = await chatManager.createConversation({
				title: getTelegramConversationTitle(msg, channelLabel, command.title),
				channel: convKey,
			});
			await reply(
				[
					"<b>Nueva conversacion activa</b>",
					`ID: <code>${escapeHtml(conv.id.slice(0, 8))}</code>`,
					"Los mensajes anteriores siguen visibles en Telegram, pero Octopus ya no los usa como contexto de esta conversacion.",
				].join("\n"),
			);
			return;
		}
		case "clear": {
			const nextTitle =
				current?.title ?? getTelegramConversationTitle(msg, channelLabel);
			if (current) await chatManager.deleteConversation(current.id);
			const conv = await chatManager.createConversation({
				title: nextTitle,
				channel: convKey,
			});
			await reply(
				[
					"<b>Contexto interno limpiado</b>",
					`Nueva ID: <code>${escapeHtml(conv.id.slice(0, 8))}</code>`,
					"Telegram seguira mostrando los mensajes anteriores, pero Octopus empieza desde una conversacion vacia.",
				].join("\n"),
			);
			return;
		}
		case "delete": {
			const target = command.ref
				? findConversationByRef(conversations, command.ref)
				: current;
			if (!target) {
				await reply("No encontre una conversacion para borrar.");
				return;
			}
			await chatManager.deleteConversation(target.id);
			if (target.id === current?.id) {
				await chatManager.createConversation({
					title: getTelegramConversationTitle(msg, channelLabel),
					channel: convKey,
				});
			}
			await reply(
				`Conversacion borrada: <code>${escapeHtml(target.id.slice(0, 8))}</code>`,
			);
			return;
		}
		case "list": {
			if (conversations.length === 0) {
				await reply("No hay conversaciones guardadas para este chat.");
				return;
			}
			const lines = conversations
				.slice(0, 10)
				.map((conversation, index) =>
					formatConversationLine(conversation, index + 1, current?.id),
				);
			await reply(["<b>Conversaciones recientes</b>", ...lines].join("\n"));
			return;
		}
		case "search": {
			if (!command.query) {
				await reply("Uso: /buscar &lt;texto&gt;");
				return;
			}
			const messageMatches = (
				await chatManager.searchConversations(command.query)
			).filter((conversation) => conversation.channel === convKey);
			const normalizedQuery = command.query.toLowerCase();
			const titleMatches = conversations.filter((conversation) =>
				(conversation.title ?? "").toLowerCase().includes(normalizedQuery),
			);
			const matches = [...titleMatches, ...messageMatches].filter(
				(conversation, index, all) =>
					all.findIndex((item) => item.id === conversation.id) === index,
			);
			if (matches.length === 0) {
				await reply(`Sin resultados para: ${escapeHtml(command.query)}`);
				return;
			}
			const lines = matches
				.slice(0, 10)
				.map((conversation, index) =>
					formatConversationLine(conversation, index + 1, current?.id),
				);
			await reply(["<b>Resultados</b>", ...lines].join("\n"));
			return;
		}
		case "open": {
			if (!command.ref) {
				await reply("Uso: /abrir &lt;id|titulo&gt;");
				return;
			}
			const target = findConversationByRef(conversations, command.ref);
			if (!target) {
				await reply("No encontre esa conversacion en este chat.");
				return;
			}
			await chatManager.updateConversation(target.id, {
				title: target.title ?? getTelegramConversationTitle(msg, channelLabel),
			});
			await reply(
				`Conversacion activa: <code>${escapeHtml(target.id.slice(0, 8))}</code> ${escapeHtml(target.title ?? "Sin titulo")}`,
			);
			return;
		}
		case "rename": {
			if (!current) {
				await reply("No hay una conversacion activa para renombrar.");
				return;
			}
			if (!command.title) {
				await reply("Uso: /renombrar &lt;titulo&gt;");
				return;
			}
			await chatManager.updateConversation(current.id, {
				title: command.title.slice(0, 140),
			});
			await reply(
				`Titulo actualizado: ${escapeHtml(command.title.slice(0, 140))}`,
			);
			return;
		}
		case "current": {
			if (!current) {
				await reply("No hay una conversacion activa todavia.");
				return;
			}
			await reply(
				[
					"<b>Conversacion actual</b>",
					formatConversationLine(current, 1, current.id),
				].join("\n"),
			);
			return;
		}
	}
}

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
							chalk.yellow("  ⚠ Telegram enabled but no botToken configured"),
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
			try {
				if (channel?.type === "telegram") {
					const telegramCommand = parseTelegramConversationCommand(msg.content);
					if (telegramCommand) {
						await handleTelegramConversationCommand({
							command: telegramCommand,
							msg,
							chatManager,
							tgBot: (channel as unknown as TelegramBotLike).bot,
							channelLabel,
							convKey: queueKey,
						});
						return;
					}

					const tg = channel as TelegramChannel;
					await tg.sendTyping(msg.senderId).catch(() => {});
					typingInterval = setInterval(
						() => void tg.sendTyping(msg.senderId).catch(() => {}),
						4000,
					);
				}
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
				const history = await chatManager.getConversationMessages(convId, {
					limit: CONVERSATION_HISTORY_LIMIT,
					recent: true,
				});
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
							if (statusMatch[2]?.includes("image")) action = "upload_photo";
							else if (
								statusMatch[2]?.includes("voice") ||
								statusMatch[2]?.includes("audio")
							)
								action = "record_voice";

							tgBot.api.sendChatAction(msg.senderId, action).catch(() => {});
						}
						continue;
					}
					accumulated += chunk;
					if (Date.now() - lastCheckpointAt >= STREAM_CHECKPOINT_INTERVAL_MS) {
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
								const sent = await tgBot.api.sendMessage(msg.senderId, safe, {
									parse_mode: "HTML",
								});
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
		const runningSystem = system;
		if (!runningSystem) throw new Error("System not initialized");
		server = new TransportServer({
			port: runningSystem.config.server.port,
			host: runningSystem.config.server.host,
		});
		const chatExecutionManager = new ChatExecutionManager({
			chatManager: runningSystem.chatManager,
			conversationHistoryLimit: CONVERSATION_HISTORY_LIMIT,
			streamCheckpointIntervalMs: STREAM_CHECKPOINT_INTERVAL_MS,
			getAgentRuntime: (agentId?: string) =>
				agentId && runningSystem.agentManager
					? (runningSystem.agentManager.getRuntime(agentId) ??
						runningSystem.agentRuntime)
					: runningSystem.agentRuntime,
			emit: (event) => {
				if (!server) return;
				const type =
					event.type === "event"
						? MessageType.event
						: event.type === "stream"
							? MessageType.stream
							: event.type === "stream_end"
								? MessageType.stream_end
								: event.type === "error"
									? MessageType.error
									: event.type === "response"
										? MessageType.response
										: MessageType.event;
				server.sendToConversation(event.conversationId, {
					id: event.requestId ?? event.executionId,
					type,
					channel: "chat",
					payload: event.payload,
					timestamp: Date.now(),
				});
			},
		});
		await chatExecutionManager.initialize();
		server.setSystemContext(
			buildTransportSystemContext(system, chatExecutionManager),
		);
		server.onMessage((clientId, message) => {
			void (async () => {
				if (!system || !server) return;
				try {
					if (message.channel === "chat.control") {
						const payload = message.payload as {
							action?: string;
							conversationId?: string;
							executionId?: string;
						};
						if (payload.action === "subscribe" && payload.conversationId) {
							server.subscribeConversation(clientId, payload.conversationId);
							return;
						}
						if (payload.action === "unsubscribe" && payload.conversationId) {
							server.unsubscribeConversation(clientId, payload.conversationId);
							return;
						}
						if (payload.action === "cancel") {
							if (payload.executionId) {
								await chatExecutionManager.cancel(payload.executionId);
							} else if (payload.conversationId) {
								await chatExecutionManager.cancelByConversation(
									payload.conversationId,
								);
							}
						}
						return;
					}

					const payload = message.payload as {
						message?: string;
						stream?: boolean;
						conversationId?: string;
						agentId?: string;
					};
					if (message.channel !== "chat" || !payload?.message) return;
					if (payload.conversationId) {
						server.subscribeConversation(clientId, payload.conversationId);
					}
					const execution = await chatExecutionManager.start({
						requestId: message.id,
						message: payload.message,
						stream: payload.stream,
						conversationId: payload.conversationId,
						agentId: payload.agentId,
					});
					server.subscribeConversation(clientId, execution.conversation_id);
					server.send(clientId, {
						id: message.id,
						type: MessageType.event,
						channel: "chat",
						payload: {
							execution,
							agentStatus: execution.current_status ?? "thinking",
							conversationId: execution.conversation_id,
							executionId: execution.id,
						},
						timestamp: Date.now(),
					});
				} catch (err) {
					server?.send(clientId, {
						id: message.id,
						type: MessageType.error,
						channel: message.channel,
						payload: {
							error:
								err instanceof Error
									? err.message
									: "Failed to process message",
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
		console.log(chalk.gray(`    Port:        ${system.config.server.port}`));
		console.log(chalk.gray(`    Host:        ${system.config.server.host}`));
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

		console.log(chalk.gray("  Server remains active. Press Ctrl+C to stop\n"));
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
