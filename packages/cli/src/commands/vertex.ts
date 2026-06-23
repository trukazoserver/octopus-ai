import { exec } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	type OctopusConfig,
	ConfigLoader,
	prepareVertexProject,
	refreshAccessToken,
} from "@octopus-ai/core";
import chalk from "chalk";
import { Command } from "commander";

const execAsync = promisify(exec);

interface VertexSetupOptions {
	token?: string;
	project?: string;
	billing?: string;
	location?: string;
	serviceAccount?: boolean;
}

/**
 * Resolve a Google OAuth access token with cloud-platform scope from, in order:
 * an explicit --token, `gcloud auth print-access-token`, or the stored OAuth
 * token in config (refreshing it if expired).
 */
async function resolveAccessToken(options: VertexSetupOptions): Promise<string> {
	if (options.token?.trim()) return options.token.trim();

	try {
		const { stdout } = await execAsync("gcloud auth print-access-token", {
			timeout: 15_000,
		});
		const tok = stdout.trim();
		if (tok && !/error|not found/i.test(tok)) return tok;
	} catch {
		// gcloud not installed / not logged in — fall through to stored token.
	}

	const config = new ConfigLoader().load();
	const vertex = config.ai.providers.vertex;
	let accessToken = vertex.oauthAccessToken?.trim() ?? "";
	const expiresAt = vertex.oauthExpiresAt;
	if (accessToken && expiresAt && Date.now() > expiresAt - 60_000) {
		if (vertex.oauthRefreshToken && vertex.oauthClientId) {
			const tokens = await refreshAccessToken(
				"google",
				vertex.oauthRefreshToken,
				vertex.oauthClientId,
				vertex.oauthClientSecret,
			);
			accessToken = tokens.access_token;
		}
	}
	return accessToken;
}

function saveServiceAccountKey(keyJson: string): string {
	const credsDir = join(homedir(), ".octopus", "credentials");
	if (!existsSync(credsDir)) mkdirSync(credsDir, { recursive: true });
	const keyPath = join(credsDir, "google-service-account.json");
	writeFileSync(keyPath, keyJson, { encoding: "utf-8", mode: 0o600 });
	return keyPath;
}

export function createVertexCommand(): Command {
	const vertex = new Command("vertex").description(
		"Manage Google Vertex AI credentials and provisioning",
	);

	vertex
		.command("setup")
		.description(
			"Log in with Google and auto-create a Vertex project, service account and JSON key.",
		)
		.option(
			"--token <token>",
			"Google OAuth access token with cloud-platform scope (alternative to gcloud / web login)",
		)
		.option("--project <id>", "Use an existing project id (instead of creating one)")
		.option("--billing <id>", "Billing account id to link")
		.option("--location <location>", "Vertex location", "us-central1")
		.option(
			"--no-service-account",
			"Do not create a service account + key (use the OAuth token instead)",
		)
		.action(async (options: VertexSetupOptions) => {
			console.log(chalk.cyan.bold("\n🐙 Octopus AI — Vertex AI setup\n"));

			const accessToken = await resolveAccessToken(options);
			if (!accessToken) {
				console.error(
					chalk.red(
						"\nNo Google access token found. Options:\n" +
							"  1) Run `gcloud auth login` (and pass nothing), or\n" +
							"  2) Pass --token <access-token>, or\n" +
							"  3) Do Google OAuth login in the web UI first.\n",
					),
				);
				process.exit(1);
			}

			try {
				console.log(chalk.cyan("Provisionando proyecto, APIs y service account..."));
				const result = await prepareVertexProject({
					accessToken,
					projectId: options.project,
					billingAccountName: options.billing,
					createServiceAccountKey: options.serviceAccount !== false,
				});

				const loader = new ConfigLoader();
				const config = loader.load() as OctopusConfig;
				const vertex = config.ai.providers.vertex;
				vertex.projectId = result.projectId;
				vertex.location = options.location || vertex.location || "us-central1";

				let keyPath: string | undefined;
				if (result.serviceAccountKey) {
					keyPath = saveServiceAccountKey(result.serviceAccountKey);
					vertex.credentialsFile = keyPath;
					vertex.credentialsJson = undefined;
					// Prefer the self-contained service account over the user token.
					vertex.oauthAccessToken = undefined;
					vertex.accessToken = undefined;
				} else {
					vertex.oauthAccessToken = accessToken;
				}
				loader.save(config);

				console.log(chalk.green("\n✓ Vertex AI configurado.\n"));
				console.log(`  ${chalk.white("Proyecto:")}           ${result.projectId}`);
				if (result.serviceAccountEmail) {
					console.log(
						`  ${chalk.white("Service account:")}    ${result.serviceAccountEmail}`,
					);
				}
				if (keyPath) {
					console.log(`  ${chalk.white("Clave JSON:")}         ${keyPath}`);
				}
				console.log(`  ${chalk.white("Location:")}           ${vertex.location}`);
				if (result.linkedBillingAccount) {
					console.log(
						`  ${chalk.white("Billing:")}             ${result.linkedBillingAccount}`,
					);
				}
				if (result.warnings.length > 0) {
					console.log(chalk.yellow("\nAvisos:"));
					for (const w of result.warnings) console.log(`  • ${w}`);
				}
				console.log(
					chalk.gray(
						"\nListo. El proveedor de Google usará Vertex AI con la service account.\n",
					),
				);
			} catch (err) {
				console.error(
					chalk.red(
						`\nVertex setup failed: ${err instanceof Error ? err.message : String(err)}\n`,
					),
				);
				process.exit(1);
			}
		});

	return vertex;
}
