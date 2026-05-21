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
	const memory = masked.memory as Record<string, unknown> | undefined;
	const embeddings = memory?.embeddings as Record<string, unknown> | undefined;
	if (
		embeddings?.apiKey &&
		typeof embeddings.apiKey === "string" &&
		embeddings.apiKey.length > 0
	) {
		const key = embeddings.apiKey;
		embeddings.apiKey = `${key.slice(0, 4)}...${key.slice(-4)}`;
	}
	if (
		embeddings?.accessToken &&
		typeof embeddings.accessToken === "string" &&
		embeddings.accessToken.length > 0
	) {
		embeddings.accessToken = "****";
	}
	if (
		embeddings?.credentialsJson &&
		typeof embeddings.credentialsJson === "string" &&
		embeddings.credentialsJson.length > 0
	) {
		embeddings.credentialsJson = "****";
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
		const key = keys[i];
		if (key === undefined) return;
		if (
			!(key in current) ||
			typeof current[key] !== "object" ||
			current[key] === null
		) {
			current[key] = {};
		}
		current = current[key] as Record<string, unknown>;
	}
	const lastKey = keys.at(-1);
	if (lastKey === undefined) return;

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

type EmbeddingsOptions = {
	authMode?: string;
	apiKey?: string;
	apiKeyEnv?: string;
	accessTokenEnv?: string;
	credentialsFile?: string;
	projectId?: string;
	location?: string;
	model?: string;
	dimensions?: string;
};

function saveValidatedConfig(
	loader: ConfigLoader,
	config: OctopusConfig,
): void {
	const validator = new ConfigValidator();
	const result = validator.validate(config);
	if (!result.valid) {
		console.error(chalk.red("Validation failed:"), result.errors.join("; "));
		process.exit(1);
	}
	loader.save(config);
}

function configureEmbeddings(
	config: OctopusConfig,
	provider: string,
	options: EmbeddingsOptions,
): string[] {
	const embeddings = config.memory.embeddings;
	const notes: string[] = [];
	if (provider === "off" || provider === "disable") {
		embeddings.enabled = false;
		embeddings.provider = "auto";
		return ["Advanced embeddings disabled; hash fallback will be used."];
	}

	if (provider !== "openai" && provider !== "google") {
		throw new Error("Embedding provider must be one of: openai, google, off");
	}

	embeddings.enabled = true;
	embeddings.provider = provider;
	embeddings.apiType = provider === "google" ? "google" : "openai";
	if (options.apiKey) embeddings.apiKey = options.apiKey;
	if (options.apiKeyEnv) embeddings.apiKeyEnv = options.apiKeyEnv;
	if (options.model) embeddings.model = options.model;
	if (options.dimensions)
		embeddings.dimensions = Number.parseInt(options.dimensions, 10);

	if (provider === "openai") {
		embeddings.authMode = "api-key";
		embeddings.model = embeddings.model || "text-embedding-3-small";
		if (!options.dimensions) embeddings.dimensions = 1536;
		if (!embeddings.apiKey && !embeddings.apiKeyEnv) {
			embeddings.apiKeyEnv = "OPENAI_API_KEY";
			notes.push("Set OPENAI_API_KEY before starting Octopus.");
		}
		notes.push(
			"OpenAI embeddings use the Platform API key, not Codex login tokens.",
		);
		return notes;
	}

	const authMode = options.authMode === "vertex" ? "vertex" : "api-key";
	embeddings.authMode = authMode;
	embeddings.model = embeddings.model || "gemini-embedding-2";
	if (!options.dimensions) embeddings.dimensions = 768;
	if (authMode === "vertex") {
		if (options.accessTokenEnv)
			embeddings.accessTokenEnv = options.accessTokenEnv;
		if (options.credentialsFile)
			embeddings.credentialsFile = options.credentialsFile;
		if (options.projectId) embeddings.projectId = options.projectId;
		if (options.location) embeddings.location = options.location;
		if (!embeddings.accessTokenEnv && !embeddings.credentialsFile) {
			embeddings.accessTokenEnv = "GOOGLE_VERTEX_ACCESS_TOKEN";
			notes.push(
				"Set GOOGLE_VERTEX_ACCESS_TOKEN or configure GOOGLE_APPLICATION_CREDENTIALS for Vertex AI.",
			);
		}
		if (!embeddings.projectId) {
			notes.push(
				"Set memory.embeddings.projectId or GOOGLE_CLOUD_PROJECT for Vertex AI.",
			);
		}
		return notes;
	}

	if (!embeddings.apiKey && !embeddings.apiKeyEnv) {
		embeddings.apiKeyEnv = "GEMINI_API_KEY";
		notes.push("Set GEMINI_API_KEY before starting Octopus.");
	}
	return notes;
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
		.command("embeddings <provider>")
		.description("Enable or disable advanced memory embeddings")
		.option("--auth-mode <mode>", "Google auth mode: api-key or vertex")
		.option("--api-key <key>", "Embedding API key to store in config")
		.option("--api-key-env <name>", "Environment variable containing API key")
		.option(
			"--access-token-env <name>",
			"Environment variable containing Vertex access token",
		)
		.option("--credentials-file <path>", "Google service account JSON path")
		.option("--project-id <id>", "Google Cloud project ID for Vertex")
		.option("--location <location>", "Google Cloud location for Vertex")
		.option("--model <model>", "Embedding model name")
		.option("--dimensions <number>", "Embedding dimensions")
		.action((provider: string, options: EmbeddingsOptions) => {
			try {
				const loader = new ConfigLoader();
				const config = loader.load();
				const notes = configureEmbeddings(config, provider, options);
				saveValidatedConfig(loader, config);
				console.log(chalk.green(`✓ Configured embeddings: ${provider}`));
				for (const note of notes) console.log(chalk.yellow(`  ${note}`));
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
