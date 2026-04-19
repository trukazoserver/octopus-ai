import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { ConfigLoader, ConfigValidator } from "@octopus-ai/core";
import type { OctopusConfig } from "@octopus-ai/core";
import chalk from "chalk";
import { Command } from "commander";

function maskApiKeys(config: OctopusConfig): Record<string, unknown> {
	const masked = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
	const ai = masked.ai as Record<string, unknown>;
	const providers = ai.providers as Record<string, Record<string, unknown>>;

	for (const provider of Object.values(providers)) {
		if (
			provider.apiKey &&
			typeof provider.apiKey === "string" &&
			provider.apiKey.length > 0
		) {
			const key = provider.apiKey as string;
			provider.apiKey = `${key.slice(0, 4)}...${key.slice(-4)}`;
		}
	}

	if (
		masked.security &&
		typeof masked.security === "object" &&
		(masked.security as Record<string, unknown>).encryptionKey
	) {
		(masked.security as Record<string, unknown>).encryptionKey = "****";
	}

	return masked;
}

function getNestedValue(
	obj: Record<string, unknown>,
	keyPath: string,
): unknown {
	const keys = keyPath.split(".");
	let current: unknown = obj;
	for (const key of keys) {
		if (
			current === null ||
			current === undefined ||
			typeof current !== "object"
		) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function setNestedValue(
	obj: Record<string, unknown>,
	keyPath: string,
	value: string,
): void {
	const keys = keyPath.split(".");
	let current: Record<string, unknown> = obj;
	for (let i = 0; i < keys.length - 1; i++) {
		const key = keys[i]!;
		if (
			!(key in current) ||
			typeof current[key] !== "object" ||
			current[key] === null
		) {
			current[key] = {};
		}
		current = current[key] as Record<string, unknown>;
	}
	const lastKey = keys[keys.length - 1]!;

	try {
		const parsed = JSON.parse(value);
		current[lastKey] = parsed;
	} catch {
		if (value === "true") {
			current[lastKey] = true;
		} else if (value === "false") {
			current[lastKey] = false;
		} else if (/^-?\d+(\.\d+)?$/.test(value)) {
			current[lastKey] = Number.parseFloat(value);
		} else {
			current[lastKey] = value;
		}
	}
}

export function createConfigCommand(): Command {
	const cmd = new Command("config").description(
		"Manage Octopus AI configuration",
	);

	cmd
		.command("get <key>")
		.description("Get a configuration value")
		.action((key: string) => {
			try {
				const loader = new ConfigLoader();
				const config = loader.load();
				const value = getNestedValue(
					config as unknown as Record<string, unknown>,
					key,
				);
				if (value === undefined) {
					console.log(chalk.yellow(`Key '${key}' not found in configuration`));
					return;
				}
				console.log(JSON.stringify(value, null, 2));
			} catch (err) {
				console.error(
					chalk.red("Error:"),
					err instanceof Error ? err.message : String(err),
				);
				process.exit(1);
			}
		});

	cmd
		.command("set <key> <value>")
		.description("Set a configuration value")
		.action((key: string, value: string) => {
			try {
				const loader = new ConfigLoader();
				const config = loader.load();

				const configObj = config as unknown as Record<string, unknown>;
				setNestedValue(configObj, key, value);

				const validator = new ConfigValidator();
				const result = validator.validate(
					configObj as unknown as OctopusConfig,
				);
				if (!result.valid) {
					console.error(
						chalk.red("Validation failed:"),
						result.errors.join("; "),
					);
					process.exit(1);
				}

				loader.save(configObj as unknown as OctopusConfig);
				console.log(chalk.green(`✓ Set ${key}`));
			} catch (err) {
				console.error(
					chalk.red("Error:"),
					err instanceof Error ? err.message : String(err),
				);
				process.exit(1);
			}
		});

	cmd
		.command("edit")
		.description("Show configuration file path for editing")
		.action(() => {
			const configPath = path.join(homedir(), ".octopus", "config.json");
			console.log(chalk.cyan("Configuration file:"));
			console.log(chalk.white(`  ${configPath}`));
			if (fs.existsSync(configPath)) {
				console.log(chalk.green("  File exists"));
			} else {
				console.log(
					chalk.yellow(
						"  File does not exist yet. Run 'octopus-ai setup' first.",
					),
				);
			}
		});

	cmd
		.command("show")
		.description("Show the full configuration (API keys masked)")
		.action(() => {
			try {
				const loader = new ConfigLoader();
				const config = loader.load();
				const masked = maskApiKeys(config);
				console.log(JSON.stringify(masked, null, 2));
			} catch (err) {
				console.error(
					chalk.red("Error:"),
					err instanceof Error ? err.message : String(err),
				);
				process.exit(1);
			}
		});

	return cmd;
}
