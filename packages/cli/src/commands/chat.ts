import * as readline from "node:readline";
import { AgentRuntime } from "@octopus-ai/core";
import chalk from "chalk";
import { Command } from "commander";
import { bootstrap } from "../bootstrap.js";

export function createChatCommand(): Command {
	return new Command("chat")
		.description("Start an interactive chat session with Octopus AI")
		.option("--model <model>", "Override the default AI model")
		.action(async (options: { model?: string }) => {
			const rl = readline.createInterface({
				input: process.stdin,
				output: process.stdout,
			});

			let system: Awaited<ReturnType<typeof bootstrap>> | null = null;

			try {
				system = await bootstrap();

				if (options.model) {
					system.agentRuntime = new AgentRuntime(
						{
							id: "default-agent",
							name: "Octopus AI",
							description: "Default Octopus AI agent",
							systemPrompt: `You are Octopus AI, an intelligent assistant with memory and skill capabilities.
You help users accomplish tasks efficiently by leveraging your memory of past interactions
and your library of learned skills. Be concise, helpful, and proactive.`,
							model: options.model,
							maxTokens: system.config.ai.maxTokens,
						},
						system.router,
						system.stm,
						system.memoryRetrieval,
						system.memoryConsolidator,
						system.skillLoader,
					);
				}

				console.log(chalk.cyan.bold("\n🐙 Octopus AI Chat"));
				console.log(
					chalk.gray(`Model: ${options.model ?? system.config.ai.default}`),
				);
				console.log(
					chalk.gray("Type /help for available commands, /exit to quit\n"),
				);

				const prompt = (): Promise<string> =>
					new Promise((resolve) => {
						rl.question(chalk.green("> "), (answer) => {
							resolve(answer.trim());
						});
					});

				let running = true;

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
								console.log(chalk.gray("\nGoodbye! 👋\n"));
								break;
							}

							case "/clear": {
								system.stm.clear();
								console.log(chalk.green("  ✓ Conversation context cleared\n"));
								break;
							}

							case "/memory": {
								const load = system.stm.getLoad();
								const turns = system.stm.getContext().length;
								const ltmCount = await system.ltm.count();
								console.log(chalk.cyan("  Memory Status:"));
								console.log(
									chalk.gray(
										`    STM Load:  ${load.toFixed(1)}% (${turns} turns)`,
									),
								);
								console.log(chalk.gray(`    LTM Items: ${ltmCount}`));
								console.log(
									chalk.gray(`    Enabled:   ${system.config.memory.enabled}`),
								);
								console.log();
								break;
							}

							case "/skills": {
								const skills = await system.skillRegistry.list();
								if (skills.length === 0) {
									console.log(chalk.gray("  No skills loaded\n"));
								} else {
									console.log(chalk.cyan("  Loaded Skills:"));
									for (const skill of skills) {
										console.log(
											chalk.gray(
												`    • ${skill.name} (v${skill.version}) - ${skill.description.slice(0, 60)}`,
											),
										);
									}
									console.log();
								}
								break;
							}

							case "/help": {
								console.log(chalk.cyan("  Available Commands:"));
								console.log(chalk.gray("    /exit, /quit  - Exit chat"));
								console.log(
									chalk.gray("    /clear        - Clear conversation context"),
								);
								console.log(
									chalk.gray("    /memory       - Show memory status"),
								);
								console.log(
									chalk.gray("    /skills       - List loaded skills"),
								);
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
						process.stdout.write(chalk.gray("  Loading context..."));
						process.stdout.write("\r");

						const response = await system.agentRuntime.processMessage(input);

						process.stdout.write(`${" ".repeat(30)}\r`);

						console.log(chalk.white(`  ${response}\n`));

						if (system.config.memory.enabled) {
							await system.memoryConsolidator.consolidate(system.stm);
						}
					} catch (err) {
						process.stdout.write(`${" ".repeat(30)}\r`);
						console.error(
							chalk.red(
								`  Error: ${err instanceof Error ? err.message : String(err)}\n`,
							),
						);
					}
				}

				await system.shutdown();
			} catch (err) {
				console.error(
					chalk.red("\n✗ Failed to start chat:"),
					err instanceof Error ? err.message : String(err),
				);
				if (system) await system.shutdown();
				process.exit(1);
			} finally {
				rl.close();
			}
		});
}
