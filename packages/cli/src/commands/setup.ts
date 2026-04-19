import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import {
	ConfigLoader,
	ConfigValidator,
	DEFAULT_CONFIG,
	createDatabaseAdapter,
} from "@octopus-ai/core";
import type { OctopusConfig } from "@octopus-ai/core";
import chalk from "chalk";
import { Command } from "commander";
import { checkPrerequisites, printPrereqResults } from "./prereqs.js";

function askQuestion(rl: readline.Interface, prompt: string): Promise<string> {
	return new Promise((resolve) => {
		rl.question(prompt, (answer) => {
			resolve(answer.trim());
		});
	});
}

export function createSetupCommand(): Command {
	return new Command("setup")
		.description("Run the setup wizard to configure Octopus AI")
		.action(async () => {
			const rl = readline.createInterface({
				input: process.stdin,
				output: process.stdout,
			});

			try {
				console.log(chalk.cyan.bold("\n🐙 Octopus AI Setup Wizard\n"));

				console.log(chalk.cyan("  Verificando requisitos del sistema...\n"));
				const prereqs = checkPrerequisites();
				const allPrereqsOk = printPrereqResults(prereqs);

				if (!allPrereqsOk) {
					const failed = prereqs.filter((r) => !r.passed);
					console.log(chalk.yellow.bold("\n  Requisitos faltantes:"));
					for (const item of failed) {
						console.log(chalk.yellow(`    - ${item.name}: ${item.message}`));
						if (item.fixHint) {
							console.log(chalk.gray(`      ${item.fixHint.split("\n")[0]}`));
						}
					}
					console.log(
						chalk.red.bold(
							"\n  Ejecuta 'node scripts/install.mjs' para instalarlos automáticamente.\n",
						),
					);
					const proceed = await askQuestion(
						rl,
						chalk.yellow("  ¿Continuar de todas formas? (s/N): "),
					);
					if (proceed.toLowerCase() !== "s" && proceed.toLowerCase() !== "si") {
						process.exit(1);
					}
					console.log();
				} else {
					console.log(chalk.green("  Todos los requisitos cumplidos ✓\n"));
				}

				const anthropicKey = await askQuestion(
					rl,
					chalk.yellow("Anthropic API Key (Enter para saltar): "),
				);
				const openaiKey = await askQuestion(
					rl,
					chalk.yellow("OpenAI API Key (Enter para saltar): "),
				);
				const zhipuKey = await askQuestion(
					rl,
					chalk.yellow(
						"Z.ai / ZhipuAI API Key (proveedor por defecto, Enter para saltar): ",
					),
				);
				const googleKey = await askQuestion(
					rl,
					chalk.yellow("Google AI API Key (Enter para saltar): "),
				);
				const openrouterKey = await askQuestion(
					rl,
					chalk.yellow("OpenRouter API Key (Enter para saltar): "),
				);

				console.log(chalk.cyan("\n📁 Creating directory structure..."));

				const octopusDir = path.join(homedir(), ".octopus");
				const dataDir = path.join(octopusDir, "data");
				const skillsDir = path.join(octopusDir, "skills");
				const pluginsDir = path.join(octopusDir, "plugins");

				for (const dir of [dataDir, skillsDir, pluginsDir]) {
					if (!fs.existsSync(dir)) {
						fs.mkdirSync(dir, { recursive: true });
					}
				}

				console.log(chalk.green("  ✓ Directories created"));

				console.log(chalk.cyan("\n⚙️  Generating configuration..."));

				const config: OctopusConfig = JSON.parse(
					JSON.stringify(DEFAULT_CONFIG),
				);
				if (anthropicKey) {
					config.ai.providers.anthropic.apiKey = anthropicKey;
				}
				if (openaiKey) {
					config.ai.providers.openai.apiKey = openaiKey;
				}
				if (zhipuKey) {
					config.ai.providers.zhipu.apiKey = zhipuKey;
				}
				if (googleKey) {
					config.ai.providers.google.apiKey = googleKey;
				}
				if (openrouterKey) {
					config.ai.providers.openrouter.apiKey = openrouterKey;
				}

				const validator = new ConfigValidator();
				const result = validator.validate(config);
				if (!result.valid) {
					console.error(
						chalk.red("  ✗ Configuration validation failed:"),
						result.errors.join("; "),
					);
					process.exit(1);
				}
				console.log(chalk.green("  ✓ Configuration validated"));

				const loader = new ConfigLoader();
				loader.save(config);
				console.log(
					chalk.green("  ✓ Configuration saved to ~/.octopus/config.json"),
				);

				console.log(chalk.cyan("\n💾 Initializing database..."));
				const db = createDatabaseAdapter(
					config.storage.backend as
						| "sqlite"
						| "postgresql"
						| "mysql"
						| "mongodb",
					{
						path: config.storage.path,
					},
				);
				await db.initialize();
				await db.close();
				console.log(chalk.green("  ✓ Database initialized"));

				console.log(chalk.green.bold("\n✅ Octopus AI setup complete!\n"));
				console.log(
					chalk.gray(
						"Run 'octopus-ai start' to start the server or 'octopus-ai chat' for interactive mode.\n",
					),
				);
			} catch (err) {
				console.error(
					chalk.red("\n✗ Setup failed:"),
					err instanceof Error ? err.message : String(err),
				);
				process.exit(1);
			} finally {
				rl.close();
			}
		});
}
