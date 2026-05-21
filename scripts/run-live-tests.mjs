import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = resolve(root, "docker/.env.integration");

if (existsSync(envFile)) {
	for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const separator = trimmed.indexOf("=");
		if (separator === -1) continue;
		const key = trimmed.slice(0, separator).trim();
		const value = trimmed.slice(separator + 1).trim();
		process.env[key] ??= value;
	}
}

if (!process.env.ZAI_API_KEY && !process.env.ZHIPU_API_KEY) {
	const configFile = resolve(homedir(), ".octopus/config.json");
	if (existsSync(configFile)) {
		const config = JSON.parse(readFileSync(configFile, "utf8"));
		const zhipu = config?.ai?.providers?.zhipu;
		const apiKey = zhipu?.apiKey;
		const mode = typeof zhipu?.mode === "string" ? zhipu.mode : "coding-plan";
		if (typeof apiKey === "string" && apiKey.trim()) {
			const resolved = apiKey.replace(
				/\$\{([^}]+)\}/g,
				(_match, name) => process.env[name] ?? "",
			);
			if (resolved.trim()) {
				if (mode === "coding-global") {
					process.env.ZAI_CODING_API_KEY ??= resolved;
				} else if (mode === "coding-plan") {
					process.env.ZHIPU_CODING_API_KEY ??= resolved;
				} else if (mode === "global") {
					process.env.ZAI_API_KEY ??= resolved;
				} else {
					process.env.ZHIPU_API_KEY ??= resolved;
				}
			}
		}
	}
}

const target = process.argv[2] ?? "all";
const script =
	target === "postgres"
		? "test:live:postgres"
		: target === "vectors"
			? "test:live:vectors"
			: "test:live";

const result = spawnSync("pnpm", ["--filter", "@octopus-ai/core", script], {
	cwd: root,
	env: process.env,
	stdio: "inherit",
	shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
