import {
	type OctopusConfig,
	ConfigLoader,
	LLMRouter,
} from "@octopus-ai/core";
import type { ProviderConfig } from "@octopus-ai/core";
import chalk from "chalk";
import { Command } from "commander";

const PING_TIMEOUT_MS = 25_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise.finally(() => timer && clearTimeout(timer)),
		new Promise<T>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`timeout (${ms}ms)`)),
				ms,
			);
		}),
	]);
}

async function pingProvider(
	router: LLMRouter,
	providerName: string,
	model: string,
): Promise<{ ok: boolean; latencyMs: number; detail: string }> {
	const start = Date.now();
	try {
		const response = await withTimeout(
			router.chat({
				model,
				messages: [{ role: "user", content: "ping" }],
				maxTokens: 1,
			}),
			PING_TIMEOUT_MS,
		);
		const latencyMs = Date.now() - start;
		const ok = Boolean(
			response?.content ||
				response?.thinking ||
				response?.finishReason,
		);
		return { ok, latencyMs, detail: ok ? "OK" : "empty response" };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, latencyMs: Date.now() - start, detail: msg };
	}
}

export function createProvidersCommand(): Command {
	const providers = new Command("providers").description(
		"Check AI provider connectivity",
	);

	providers
		.command("check")
		.description(
			"Send a live 1-token ping to each configured AI provider and report status.",
		)
		.action(async () => {
			console.log(chalk.cyan.bold("\n🐙 Octopus AI — provider connectivity check\n"));

			let config: OctopusConfig;
			try {
				config = new ConfigLoader().load();
			} catch (err) {
				console.error(
					chalk.red(
						`Cannot read config: ${err instanceof Error ? err.message : String(err)}`,
					),
				);
				process.exit(1);
			}

			const router = new LLMRouter({
				default: config.ai.default,
				fallback: config.ai.fallback,
				providers: config.ai.providers as Record<string, ProviderConfig>,
			});

			try {
				await router.initialize();
			} catch (err) {
				console.error(
					chalk.red(
						`Router init failed: ${err instanceof Error ? err.message : String(err)}`,
					),
				);
				process.exit(1);
			}

			const available = router.getAvailableProviders();
			if (available.length === 0) {
				console.log(
					chalk.yellow(
						"No providers available. Configure at least one API key (e.g. `octopus setup`).",
					),
				);
				return;
			}

			console.log(chalk.gray(`Pinging ${available.length} provider(s)...\n`));
			let okCount = 0;
			for (const name of available) {
				const providerCfg = (
					config.ai.providers as Record<string, { models?: string[] }>
				)[name];
				const firstModel = providerCfg?.models?.[0];
				const model = firstModel ? `${name}/${firstModel}` : "default";
				const result = await pingProvider(router, name, model);
				const icon = result.ok ? chalk.green("✓") : chalk.red("✗");
				const detail = result.ok
					? chalk.gray(`${result.latencyMs}ms`)
					: chalk.yellow(result.detail.slice(0, 120));
				console.log(`  ${icon} ${name.padEnd(12)} ${detail}`);
				if (result.ok) okCount += 1;
			}

			console.log(
				chalk.cyan(
					`\n${okCount}/${available.length} provider(s) responding.\n`,
				),
			);
			if (okCount < available.length) process.exitCode = 1;
		});

	return providers;
}
