import { homedir } from "node:os";
import * as readline from "node:readline";
import { AgentRuntime, getProviderRegistry } from "@octopus-ai/core";
import type { Skill, ToolDefinition } from "@octopus-ai/core";
import chalk from "chalk";
import { Command } from "commander";
import { bootstrap } from "../bootstrap.js";
import {
	createLocalConsoleSession,
	createRemoteConsoleSession,
} from "../runtime/console-session.js";
import {
	detectConfiguredServer,
	getWebUrl,
} from "../runtime/server-session.js";
import { runOctopusTui } from "../tui/index.js";

const CLI_VERSION = "0.1.0";
const STATUS_RE =
	/^\0STATUS:(\w+)(?::([\w-]+))?(?::([A-Za-z0-9+/=]*))?(?::([A-Za-z0-9+/=]*))?\0$/;
const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

type OctopusSystem = Awaited<ReturnType<typeof bootstrap>>;

const accent = chalk.hex("#f59e0b");
const mutedGold = chalk.hex("#9a6b16");
const borderColor = chalk.hex("#52525b");
const labelColor = chalk.hex("#8b949e");

function visibleLength(value: string): number {
	return value.replace(ansiPattern, "").length;
}

function fit(value: string, width: number): string {
	if (value.length > width)
		return `${value.slice(0, Math.max(0, width - 3))}...`;
	return value.padEnd(width, " ");
}

function truncate(value: string, width: number): string {
	if (value.length <= width) return value;
	return `${value.slice(0, Math.max(0, width - 3))}...`;
}

function padVisible(value: string, width: number): string {
	return `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;
}

function terminalWidth(): number {
	return Math.max(84, Math.min(process.stdout.columns || 104, 118));
}

function shortenPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function formatCount(value: number): string {
	return new Intl.NumberFormat("en-US").format(value);
}

function describeModel(modelRef: string): {
	provider: string;
	model: string;
	label: string;
} {
	const registry = getProviderRegistry();
	const slashIndex = modelRef.indexOf("/");
	if (slashIndex === -1) {
		return { provider: "auto", model: modelRef, label: modelRef };
	}
	const provider = modelRef.slice(0, slashIndex);
	const model = modelRef.slice(slashIndex + 1);
	const displayName = registry[provider]?.displayName ?? provider;
	return { provider, model, label: `${displayName} (${provider})` };
}

function sessionId(): string {
	return Date.now().toString(36).slice(-8);
}

function groupToolName(tool: ToolDefinition): string {
	const source = tool.metadata?.source;
	if (typeof source === "string" && source === "mcp") return "mcp";
	if (tool.name.startsWith("browser_")) return "browser";
	if (
		tool.name.includes("file") ||
		tool.name.includes("directory") ||
		tool.name === "manage_workspace"
	)
		return "file";
	if (
		tool.name.includes("code") ||
		tool.name.includes("shell") ||
		tool.name.includes("sandbox")
	)
		return "terminal";
	if (
		tool.name.includes("task") ||
		tool.name.includes("automation") ||
		tool.name.includes("cron")
	)
		return "cronjob";
	if (tool.name.includes("delegate") || tool.name.includes("worker"))
		return "delegation";
	return tool.name.split(/[_-]/)[0] || "tools";
}

function formatToolRows(tools: ToolDefinition[], maxRows = 7): string[] {
	const groups = new Map<string, string[]>();
	for (const tool of tools) {
		const group = groupToolName(tool);
		groups.set(group, [...(groups.get(group) ?? []), tool.name]);
	}

	const entries = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
	const rows = entries.slice(0, maxRows).map(([group, names]) => {
		const sample = names.slice(0, 4).join(", ");
		return `${group}: ${sample}${names.length > 4 ? ", ..." : ""}`;
	});
	if (entries.length > maxRows)
		rows.push(`(and ${entries.length - maxRows} more toolsets...)`);
	return rows.length > 0 ? rows : ["none: no tools registered"];
}

function formatSkillRows(skills: Skill[], maxRows = 6): string[] {
	const groups = new Map<string, string[]>();
	for (const skill of skills) {
		const group = skill.tags[0] ?? "general";
		groups.set(group, [...(groups.get(group) ?? []), skill.name]);
	}

	const entries = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
	const rows = entries.slice(0, maxRows).map(([group, names]) => {
		const sample = names.slice(0, 4).join(", ");
		return `${group}: ${sample}${names.length > 4 ? ", ..." : ""}`;
	});
	if (entries.length > maxRows)
		rows.push(`(and ${entries.length - maxRows} more skillsets...)`);
	return rows.length > 0 ? rows : ["none: no skills loaded"];
}

function printBorder(width: number): void {
	console.log(borderColor(`+${"-".repeat(width - 2)}+`));
}

function printRule(title: string, width: number): void {
	const label = ` ${title} `;
	const remaining = Math.max(0, width - label.length - 2);
	console.log(borderColor(`|${label}${"-".repeat(remaining)}|`));
}

function printBoxLine(content: string, width: number): void {
	console.log(
		`${borderColor("|")} ${padVisible(content, width - 4)} ${borderColor("|")}`,
	);
}

function formatGroupedPanelRow(row: string, width: number): string {
	if (row.startsWith("(")) return mutedGold(truncate(row, width));
	const colonIndex = row.indexOf(":");
	if (colonIndex === -1) return chalk.white(truncate(row, width));

	const label = row.slice(0, colonIndex);
	const value = row.slice(colonIndex + 1).trim();
	const labelWidth = 13;
	const valueWidth = Math.max(10, width - labelWidth - 1);
	return `${labelColor(fit(label, labelWidth))} ${chalk.white(truncate(value, valueWidth))}`;
}

async function printConsoleDeck(
	system: OctopusSystem,
	model: string,
	sid: string,
): Promise<void> {
	const width = terminalWidth();
	const contentWidth = width - 4;
	const tools = system.toolRegistry.list();
	const skills = await system.skillRegistry.list();
	const usage = system.router.getUsage();
	const requests = Object.values(usage.byProvider).reduce(
		(total, provider) => total + provider.requests,
		0,
	);
	const active = describeModel(model);
	const fallback = system.config.ai.fallback
		? describeModel(system.config.ai.fallback)
		: undefined;

	console.log();
	printBorder(width);
	printBoxLine(
		`${accent.bold("OCTOPUS-AI")} ${chalk.gray(`agent v${CLI_VERSION}`)}  ${labelColor("provider")} ${chalk.white(active.label)}  ${labelColor("model")} ${chalk.white(active.model)}`,
		width,
	);
	printBoxLine(
		`${labelColor("fallback")} ${chalk.white(fallback ? `${fallback.provider}/${fallback.model}` : "off")}  ${labelColor("requests")} ${chalk.white(formatCount(requests))}  ${labelColor("tokens")} ${chalk.white(formatCount(usage.totalTokens))}`,
		width,
	);
	printBoxLine(
		`${labelColor("thinking")} ${chalk.white(system.config.ai.thinking)}  ${labelColor("memory")} ${chalk.white(system.config.memory.enabled ? "on" : "off")}  ${labelColor("tools")} ${chalk.white(String(tools.length))}  ${labelColor("skills")} ${chalk.white(String(skills.length))}`,
		width,
	);
	printBoxLine(
		`${labelColor("workspace")} ${chalk.white(truncate(shortenPath(process.cwd()), contentWidth - 28))}  ${labelColor("session")} ${chalk.white(sid)}`,
		width,
	);
	printRule("TOOLS", width);
	for (const row of formatToolRows(tools, 8)) {
		printBoxLine(formatGroupedPanelRow(row, contentWidth), width);
	}
	printRule("SKILLS", width);
	for (const row of formatSkillRows(skills, 6)) {
		printBoxLine(formatGroupedPanelRow(row, contentWidth), width);
	}
	printRule("READY", width);
	printBoxLine(
		chalk.gray("Type a message. Use /help for commands, /exit to return."),
		width,
	);
	printBorder(width);
	console.log();
}

function printToolSummary(tools: ToolDefinition[]): void {
	console.log(accent.bold("TOOLS"));
	for (const row of formatToolRows(tools, 20))
		console.log(`  ${formatGroupedPanelRow(row, terminalWidth() - 4)}`);
	console.log();
}

function printSkillSummary(skills: Skill[]): void {
	console.log(accent.bold("SKILLS"));
	for (const row of formatSkillRows(skills, 20))
		console.log(`  ${formatGroupedPanelRow(row, terminalWidth() - 4)}`);
	console.log();
}

function decodeStatusField(value: string | undefined): string {
	if (!value) return "";
	try {
		return Buffer.from(value, "base64").toString("utf8");
	} catch {
		return "";
	}
}

function clearActivityLine(): void {
	if (process.stdout.isTTY) {
		readline.clearLine(process.stdout, 0);
		readline.cursorTo(process.stdout, 0);
		return;
	}
	process.stdout.write(`\r${" ".repeat(terminalWidth())}\r`);
}

function writeActivity(
	status: string,
	toolName?: string,
	detail?: string,
): void {
	const tool = toolName ? ` ${toolName}` : "";
	const suffix = detail ? chalk.gray(` - ${detail}`) : "";
	const labels: Record<string, string> = {
		thinking: "thinking",
		responding: "writing",
		tool: "using tool",
		code: "executing code",
		tool_done: "tool done",
		tool_error: "tool error",
		tool_skipped: "tool skipped",
	};
	const label = labels[status] ?? status;
	const line = `${chalk.gray("[")}${accent(label)}${chalk.gray("]")}${chalk.white(tool)}${suffix}`;
	clearActivityLine();
	process.stdout.write(line);
}

async function streamResponse(
	system: OctopusSystem,
	input: string,
): Promise<string> {
	let response = "";
	let startedResponse = false;
	writeActivity("thinking");

	for await (const chunk of system.agentRuntime.processMessageStream(
		input,
		"cli",
	)) {
		const statusMatch = chunk.match(STATUS_RE);
		if (statusMatch) {
			writeActivity(
				statusMatch[1] ?? "status",
				statusMatch[2],
				decodeStatusField(statusMatch[4]),
			);
			continue;
		}

		if (!startedResponse) {
			startedResponse = true;
			clearActivityLine();
			process.stdout.write(`${accent.bold("octopus")}${chalk.gray(" > ")}`);
		}
		response += chunk;
		process.stdout.write(chalk.white(chunk));
	}

	if (startedResponse) {
		console.log("\n");
	} else {
		clearActivityLine();
		console.log(chalk.gray("  (sin respuesta)\n"));
	}

	return response;
}

async function applyModelOverride(
	system: OctopusSystem,
	model: string,
): Promise<void> {
	const runtime = new AgentRuntime(
		{
			id: "default-agent",
			name: "Octavio",
			description: "Agente principal de Octopus AI",
			systemPrompt: `You are Octopus AI, an intelligent assistant with memory and skill capabilities.
You help users accomplish tasks efficiently by leveraging your memory of past interactions
and your library of learned skills. Be concise, helpful, and proactive.`,
			model,
			maxTokens: system.config.ai.maxTokens,
			toolIterationLimit: system.config.tools.iterationLimit,
			continuityGuard: system.config.continuityGuard,
		},
		system.router,
		system.stm,
		system.memoryRetrieval,
		system.memoryConsolidator,
		system.skillLoader,
	);
	runtime.setToolSystem(system.toolRegistry, system.toolExecutor);
	runtime.setDailyMemory(system.dailyMemory);
	runtime.setUserProfileManager(system.userProfileManager);
	runtime.setLearningEngine(system.learningEngine);
	await runtime.initialize();
	system.agentRuntime = runtime;
}

export async function runInteractiveChat(
	system: OctopusSystem,
	options: { model?: string; showDeck?: boolean } = {},
): Promise<void> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	const model = options.model ?? system.config.ai.default;
	const sid = sessionId();

	if (options.showDeck !== false) {
		await printConsoleDeck(system, model, sid);
	}

	const prompt = (): Promise<string> =>
		new Promise((resolve) => {
			rl.question(`${accent.bold("user")}${chalk.gray(" > ")}`, (answer) => {
				resolve(answer.trim());
			});
		});

	let running = true;
	try {
		while (running) {
			const input = await prompt();

			if (!input) continue;

			if (input.startsWith("/")) {
				const parts = input.split(" ");
				const cmd = parts[0]?.toLowerCase();

				switch (cmd) {
					case "/exit":
					case "/quit": {
						running = false;
						console.log(chalk.gray("\nSession closed.\n"));
						break;
					}

					case "/clear": {
						system.stm.clear();
						console.log(chalk.green("  Conversation context cleared\n"));
						break;
					}

					case "/memory": {
						const load = system.stm.getLoad();
						const turns = system.stm.getContext().length;
						const ltmCount = await system.ltm.count();
						console.log(chalk.cyan("  Memory Status:"));
						console.log(
							chalk.gray(`    STM Load:  ${load.toFixed(1)}% (${turns} turns)`),
						);
						console.log(chalk.gray(`    LTM Items: ${ltmCount}`));
						console.log(
							chalk.gray(`    Enabled:   ${system.config.memory.enabled}`),
						);
						console.log();
						break;
					}

					case "/tools": {
						printToolSummary(system.toolRegistry.list());
						break;
					}

					case "/skills": {
						const skills = await system.skillRegistry.list();
						if (skills.length === 0) {
							console.log(chalk.gray("  No skills loaded\n"));
						} else {
							printSkillSummary(skills);
						}
						break;
					}

					case "/redraw": {
						await printConsoleDeck(system, model, sid);
						break;
					}

					case "/help": {
						console.log(accent.bold("  Available Commands:"));
						console.log(chalk.gray("    /exit, /quit  - Exit chat"));
						console.log(
							chalk.gray("    /clear        - Clear conversation context"),
						);
						console.log(chalk.gray("    /memory       - Show memory status"));
						console.log(chalk.gray("    /skills       - List loaded skills"));
						console.log(chalk.gray("    /tools        - List available tools"));
						console.log(chalk.gray("    /redraw       - Redraw console deck"));
						console.log(chalk.gray("    /help         - Show this help\n"));
						break;
					}

					default: {
						console.log(
							chalk.yellow(
								`  Unknown command: ${cmd}. Type /help for available commands.\n`,
							),
						);
						break;
					}
				}
				continue;
			}

			try {
				await streamResponse(system, input);

				if (system.config.memory.enabled) {
					await system.memoryConsolidator.consolidate(system.stm);
				}
			} catch (err) {
				clearActivityLine();
				console.error(
					chalk.red(
						`  Error: ${err instanceof Error ? err.message : String(err)}\n`,
					),
				);
			}
		}
	} finally {
		rl.close();
	}
}

export function createChatCommand(): Command {
	return new Command("chat")
		.description("Start an interactive chat session with Octopus AI")
		.option("--model <model>", "Override the default AI model")
		.action(async (options: { model?: string }) => {
			let system: Awaited<ReturnType<typeof bootstrap>> | null = null;

			try {
				const existing = await detectConfiguredServer();
				if (existing.state === "octopus") {
					const session = await createRemoteConsoleSession(
						existing.address.webUrl,
						existing.address.wsUrl,
					);
					await runOctopusTui(session);
					return;
				}

				system = await bootstrap();

				if (options.model) {
					await applyModelOverride(system, options.model);
				}

				await runOctopusTui(
					createLocalConsoleSession(
						system,
						getWebUrl(system.config.server.host, system.config.server.port),
						options.model,
					),
				);
				await system.shutdown();
			} catch (err) {
				console.error(
					chalk.red("\n✗ Failed to start chat:"),
					err instanceof Error ? err.message : String(err),
				);
				if (system) await system.shutdown();
				process.exit(1);
			}
		});
}
