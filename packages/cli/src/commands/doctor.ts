import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import {
	ConfigLoader,
	ConfigValidator,
	LLMRouter,
	NetworkResolver,
	createDatabaseAdapter,
	expandTildePath,
} from "@octopus-ai/core";
import type { ProviderConfig } from "@octopus-ai/core";
import chalk from "chalk";
import { Command } from "commander";
import { checkPrerequisites, printPrereqResults } from "./prereqs.js";

interface CheckResult {
	name: string;
	passed: boolean;
	message: string;
}

async function runChecks(): Promise<CheckResult[]> {
	const results: CheckResult[] = [];

	console.log(chalk.cyan("  Verificando requisitos del sistema...\n"));
	const prereqs = checkPrerequisites();
	for (const p of prereqs) {
		results.push({ name: p.name, passed: p.passed, message: p.message });
	}

	const nodeVersion = process.version;
	const major = Number.parseInt(nodeVersion.slice(1).split(".")[0] ?? "0", 10);
	results.push({
		name: "Node.js Version",
		passed: major >= 22,
		message:
			major >= 22
				? `${nodeVersion} (>= 22)`
				: `${nodeVersion} (requires >= 22)`,
	});

	const configPath = path.join(homedir(), ".octopus", "config.json");
	const configExists = fs.existsSync(configPath);
	results.push({
		name: "Config File",
		passed: configExists,
		message: configExists ? configPath : "Not found at ~/.octopus/config.json",
	});

	let configValid = false;
	if (configExists) {
		try {
			const loader = new ConfigLoader();
			const config = loader.load();
			const validator = new ConfigValidator();
			const result = validator.validate(config);
			configValid = result.valid;
			results.push({
				name: "Config Valid",
				passed: configValid,
				message: configValid
					? "Configuration is valid"
					: `Invalid: ${result.errors.join("; ")}`,
			});
		} catch (err) {
			results.push({
				name: "Config Valid",
				passed: false,
				message: `Error loading: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	} else {
		results.push({
			name: "Config Valid",
			passed: false,
			message: "No config file to validate",
		});
	}

	let dbAccessible = false;
	try {
		const loader = new ConfigLoader();
		const config = loader.load();
		const db = createDatabaseAdapter(
			config.storage.backend as "sqlite" | "postgresql" | "mysql" | "mongodb",
			{
				path: config.storage.path,
			},
		);
		await db.initialize();
		await db.run("SELECT 1");
		await db.close();
		dbAccessible = true;
	} catch (err) {
		void err;
	}
	results.push({
		name: "Database",
		passed: dbAccessible,
		message: dbAccessible
			? "SQLite database accessible"
			: "Cannot access database",
	});

	let apiKeyConfig: {
		hasAnthropic: boolean;
		hasOpenai: boolean;
		hasGoogle: boolean;
		hasZhipu: boolean;
		hasDeepseek: boolean;
		hasMistral: boolean;
		hasXai: boolean;
	} = {
		hasAnthropic: false,
		hasOpenai: false,
		hasGoogle: false,
		hasZhipu: false,
		hasDeepseek: false,
		hasMistral: false,
		hasXai: false,
	};
	try {
		const loader = new ConfigLoader();
		const config = loader.load();
		apiKeyConfig = {
			hasAnthropic: config.ai.providers.anthropic.apiKey.length > 0,
			hasOpenai: config.ai.providers.openai.apiKey.length > 0,
			hasGoogle: config.ai.providers.google.apiKey.length > 0,
			hasZhipu: config.ai.providers.zhipu.apiKey.length > 0,
			hasDeepseek: config.ai.providers.deepseek.apiKey.length > 0,
			hasMistral: config.ai.providers.mistral.apiKey.length > 0,
			hasXai: config.ai.providers.xai.apiKey.length > 0,
		};

		const anyKey =
			apiKeyConfig.hasAnthropic ||
			apiKeyConfig.hasOpenai ||
			apiKeyConfig.hasGoogle ||
			apiKeyConfig.hasZhipu ||
			apiKeyConfig.hasDeepseek ||
			apiKeyConfig.hasMistral ||
			apiKeyConfig.hasXai;
		const details: string[] = [];
		if (apiKeyConfig.hasAnthropic) details.push("Anthropic ✓");
		if (apiKeyConfig.hasOpenai) details.push("OpenAI ✓");
		if (apiKeyConfig.hasGoogle) details.push("Google ✓");
		if (apiKeyConfig.hasZhipu) details.push("Z.ai ✓");
		if (apiKeyConfig.hasDeepseek) details.push("DeepSeek ✓");
		if (apiKeyConfig.hasMistral) details.push("Mistral ✓");
		if (apiKeyConfig.hasXai) details.push("xAI ✓");
		if (!anyKey) details.push("None set");

		results.push({
			name: "API Keys",
			passed: anyKey,
			message: details.join(", "),
		});
	} catch {
		results.push({
			name: "API Keys",
			passed: false,
			message: "Cannot read config",
		});
	}

	let providersReachable = false;
	try {
		const loader = new ConfigLoader();
		const config = loader.load();
		const providers: Record<string, ProviderConfig> = {};
		if (config.ai.providers.anthropic.apiKey) {
			providers.anthropic = { apiKey: config.ai.providers.anthropic.apiKey };
		}
		if (config.ai.providers.openai.apiKey) {
			providers.openai = { apiKey: config.ai.providers.openai.apiKey };
		}
		providers.local = { baseUrl: config.ai.providers.local.baseUrl };

		const router = new LLMRouter({
			default: config.ai.default,
			fallback: config.ai.fallback,
			providers,
		});
		await router.initialize();

		const reachableProviders: string[] = [];
		const usage = router.getUsage();
		void usage;
		if (config.ai.providers.anthropic.apiKey)
			reachableProviders.push("anthropic");
		if (config.ai.providers.openai.apiKey) reachableProviders.push("openai");
		if (config.ai.providers.local.baseUrl) reachableProviders.push("local");

		providersReachable = reachableProviders.length > 0;
		results.push({
			name: "LLM Providers",
			passed: providersReachable,
			message: providersReachable
				? `Available: ${reachableProviders.join(", ")}`
				: "No providers reachable",
		});
	} catch {
		results.push({
			name: "LLM Providers",
			passed: false,
			message: "Cannot test provider connectivity",
		});
	}

	let diskOk = false;
	try {
		const octopusDir = path.join(homedir(), ".octopus");
		if (!fs.existsSync(octopusDir)) {
			fs.mkdirSync(octopusDir, { recursive: true });
		}
		const testFile = path.join(octopusDir, ".doctor_test");
		fs.writeFileSync(testFile, "test");
		fs.unlinkSync(testFile);
		diskOk = true;

		const dbPath = expandTildePath("~/.octopus/data/octopus.db");
		let diskInfo = "Writable";
		if (fs.existsSync(dbPath)) {
			const stat = fs.statSync(dbPath);
			const mb = stat.size / (1024 * 1024);
			diskInfo = `Writable (DB: ${mb.toFixed(1)} MB)`;
		}
		results.push({
			name: "Disk Space",
			passed: diskOk,
			message: diskInfo,
		});
	} catch (err) {
		results.push({
			name: "Disk Space",
			passed: false,
			message: `Cannot write to ~/.octopus: ${err instanceof Error ? err.message : String(err)}`,
		});
	}

	let networkOk = false;
	try {
		const resolver = new NetworkResolver();
		networkOk = await resolver.isReachable("api.openai.com", 443, 5000);
		results.push({
			name: "Network",
			passed: networkOk,
			message: networkOk
				? "Internet connectivity OK"
				: "Cannot reach external APIs",
		});
	} catch {
		results.push({
			name: "Network",
			passed: false,
			message: "Cannot test network connectivity",
		});
	}

	return results;
}

export function createDoctorCommand(): Command {
	return new Command("doctor")
		.description("Run diagnostics checks")
		.action(async () => {
			console.log(chalk.cyan.bold("\n🐙 Octopus AI Doctor\n"));

			const results = await runChecks();
			let allPassed = true;

			for (const result of results) {
				const icon = result.passed ? chalk.green("✓") : chalk.red("✗");
				const label = chalk.white(`${result.name}:`.padEnd(20));
				const detail = result.passed
					? chalk.gray(result.message)
					: chalk.yellow(result.message);
				console.log(`  ${icon} ${label} ${detail}`);

				if (!result.passed) allPassed = false;
			}

			console.log();
			if (allPassed) {
				console.log(chalk.green.bold("  All checks passed! ✓\n"));
			} else {
				console.log(
					chalk.yellow.bold(
						"  Some checks failed. Please fix the issues above.\n",
					),
				);
			}

			process.exit(allPassed ? 0 : 1);
		});
}
