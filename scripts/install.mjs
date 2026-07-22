#!/usr/bin/env node
import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import { platform as getPlatform, homedir } from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

const isWin = getPlatform() === "win32";
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_ARGS = new Set(process.argv.slice(2));
const IN_DOCKER =
	fs.existsSync("/.dockerenv") || process.env.OCTOPUS_DOCKER === "true";
const AUTO_YES =
	CLI_ARGS.has("--yes") ||
	CLI_ARGS.has("-y") ||
	process.env.CI === "true" ||
	IN_DOCKER;
const INTERACTIVE =
	CLI_ARGS.has("--interactive") || (!AUTO_YES && process.stdin.isTTY);
const SKIP_START = CLI_ARGS.has("--no-start");
const SKIP_OPEN = CLI_ARGS.has("--no-open");
const SKIP_SYSTEM_DEPS = CLI_ARGS.has("--no-system-deps");
const CLI_ENTRY = path.join(
	PROJECT_ROOT,
	"packages",
	"cli",
	"dist",
	"index.js",
);
const WEB_URL = "http://127.0.0.1:18789";
const SERVICE_NAME = "OctopusAI";
const DOCUMENT_RUNTIME_INSTALLER = path.join(
	PROJECT_ROOT,
	"scripts",
	"install-document-runtime.mjs",
);
const LOG_OK = "\x1b[32m\u2713\x1b[0m";
const LOG_FAIL = "\x1b[31m\u2717\x1b[0m";
const LOG_INFO = "\x1b[36m";
const LOG_WARN = "\x1b[33m";
const LOG_DIM = "\x1b[2m";
const LOG_BOLD = "\x1b[1m";
const LOG_GREEN_BOLD = "\x1b[32m\x1b[1m";
const LOG_RED = "\x1b[31m";
const LOG_GRAY = "\x1b[90m";
const RESET = "\x1b[0m";

function run(cmd, opts = {}) {
	try {
		const output = execSync(cmd, {
			encoding: "utf-8",
			timeout: opts.timeout ?? 60000,
			cwd: opts.cwd ?? PROJECT_ROOT,
			stdio: "pipe",
		});
		return { ok: true, output: output.trim() };
	} catch (err) {
		return {
			ok: false,
			output: ((err.stdout ?? "") + (err.stderr ?? "")).trim(),
		};
	}
}

function ask(rl, prompt) {
	return new Promise((resolve) => {
		rl.question(prompt, (answer) => resolve(answer.trim()));
	});
}

async function confirmInstall(prompt, defaultYes = true, options = {}) {
	if (options.systemDependency && SKIP_SYSTEM_DEPS) return false;
	if (!INTERACTIVE) return AUTO_YES;
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		const suffix = defaultYes ? "(S/n)" : "(s/N)";
		const answer = await ask(rl, `  ${LOG_WARN}${prompt} ${suffix}: ${RESET}`);
		if (!answer) return defaultYes;
		return ["s", "si", "sí", "y", "yes"].includes(answer.toLowerCase());
	} finally {
		rl.close();
	}
}

function banner() {
	console.log();
	console.log(
		`${LOG_INFO}${LOG_BOLD}  \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557${RESET}`,
	);
	console.log(
		`${LOG_INFO}${LOG_BOLD}  \u2551     Octopus AI - Instalador               \u2551${RESET}`,
	);
	console.log(
		`${LOG_INFO}${LOG_BOLD}  \u2551     Self-hosted AI Assistant              \u2551${RESET}`,
	);
	console.log(
		`${LOG_INFO}${LOG_BOLD}  \u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d${RESET}`,
	);
	console.log();
	console.log(
		`${LOG_DIM}  Este instalador verificara e instalara los requisitos${RESET}`,
	);
	console.log(`${LOG_DIM}  necesarios para ejecutar Octopus AI.${RESET}`);
	console.log(
		`${LOG_DIM}  Enter acepta valores por defecto; usa --yes para modo automatico o --no-start para no iniciar al final.${RESET}`,
	);
	console.log();
}

function checkNode() {
	const [major = 0, minor = 0] = process.version
		.slice(1)
		.split(".")
		.map(Number);
	if (major < 22 || (major === 22 && minor < 13)) {
		console.log(`${LOG_FAIL} Node.js ${process.version} - se requiere >= 22.13`);
		console.log(
			`${LOG_GRAY}  Descarga Node.js 22+ desde https://nodejs.org${RESET}`,
		);
		return false;
	}
	console.log(`  ${LOG_OK} Node.js ${process.version}`);
	return true;
}

function ensurePnpm() {
	const r = run("pnpm --version");
	if (r.ok) {
		console.log(`  ${LOG_OK} pnpm v${r.output}`);
		return true;
	}
	console.log(`${LOG_WARN}  pnpm no encontrado. Instalando...${RESET}`);
	const install = run("npm install -g pnpm", { timeout: 120000 });
	if (install.ok) {
		console.log(`  ${LOG_OK} pnpm instalado`);
		return true;
	}
	console.log(`${LOG_FAIL} Error instalando pnpm: ${install.output}`);
	console.log(`${LOG_GRAY}  Ejecuta manualmente: npm install -g pnpm${RESET}`);
	return false;
}

function checkPython() {
	let py = run("python --version");
	if (!py.ok) py = run("python3 --version");
	if (py.ok) {
		console.log(`  ${LOG_OK} ${py.output}`);
		return true;
	}
	return false;
}

function installPython() {
	if (isWin) {
		console.log(`${LOG_INFO}  Instalando Python via winget...${RESET}`);
		const r = run(
			"winget install Python.Python.3.12 --accept-package-agreements --accept-source-agreements",
			{ timeout: 300000 },
		);
		if (
			r.ok ||
			r.output.includes("Already installed") ||
			r.output.includes("instalado")
		) {
			console.log(`  ${LOG_OK} Python instalado`);
			return true;
		}
		console.log(`${LOG_FAIL} Error: ${r.output}`);
		return false;
	}
	if (getPlatform() === "darwin") {
		console.log(`${LOG_INFO}  Instalando Python via brew...${RESET}`);
		const r = run("brew install python3", { timeout: 300000 });
		if (r.ok) {
			console.log(`  ${LOG_OK} Python instalado`);
			return true;
		}
		return false;
	}
	console.log(`${LOG_INFO}  Instalando python3 via apt...${RESET}`);
	const r = run("sudo apt-get update -qq && sudo apt-get install -y python3", {
		timeout: 300000,
	});
	if (r.ok) {
		console.log(`  ${LOG_OK} Python instalado`);
		return true;
	}
	return false;
}

function checkDocker() {
	const docker = run("docker --version");
	const compose = run("docker compose version");
	if (docker.ok && compose.ok) {
		console.log(`  ${LOG_OK} ${docker.output}; ${compose.output}`);
		return true;
	}
	return false;
}

function installDocker() {
	if (isWin) {
		console.log(`${LOG_INFO}  Instalando Docker Desktop via winget...${RESET}`);
		const r = run(
			"winget install Docker.DockerDesktop --accept-package-agreements --accept-source-agreements",
			{ timeout: 600000 },
		);
		if (
			r.ok ||
			r.output.includes("Already installed") ||
			r.output.includes("instalado")
		) {
			console.log(`  ${LOG_OK} Docker Desktop instalado`);
			return true;
		}
		console.log(`${LOG_FAIL} Error instalando Docker: ${r.output}`);
		return false;
	}
	if (getPlatform() === "darwin") {
		console.log(`${LOG_INFO}  Instalando Docker Desktop via brew...${RESET}`);
		const r = run("brew install --cask docker", { timeout: 600000 });
		if (r.ok) {
			console.log(`  ${LOG_OK} Docker instalado`);
			return true;
		}
		console.log(`${LOG_FAIL} Error instalando Docker: ${r.output}`);
		return false;
	}
	console.log(
		`${LOG_INFO}  Instalando Docker Engine y Compose plugin...${RESET}`,
	);
	const r = run(
		"sudo apt-get update -qq && sudo apt-get install -y docker.io docker-compose-plugin",
		{ timeout: 600000 },
	);
	if (r.ok) {
		console.log(`  ${LOG_OK} Docker instalado`);
		return true;
	}
	console.log(`${LOG_FAIL} Error instalando Docker: ${r.output}`);
	return false;
}

function checkBuildTools() {
	if (isWin) {
		const vswhere =
			'"C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe"';
		const check = run(`${vswhere} -latest -property installationPath`);
		if (check.ok && check.output.length > 0) {
			console.log(`  ${LOG_OK} Visual Studio Build Tools detectado`);
			return true;
		}
		const hasCl = run("where cl.exe 2>nul");
		if (hasCl.ok) {
			console.log(`  ${LOG_OK} Compilador MSVC detectado`);
			return true;
		}
		return false;
	}
	const cc =
		run("cc --version 2>/dev/null") || run("gcc --version 2>/dev/null");
	if (cc.ok) {
		console.log(
			`  ${LOG_OK} ${cc.output.split("\n")[0] ?? "Compilador detectado"}`,
		);
		return true;
	}
	return false;
}

function installBuildTools() {
	if (isWin) {
		console.log(
			`${LOG_INFO}  Instalando Visual Studio Build Tools 2022 via winget...${RESET}`,
		);
		console.log(
			`${LOG_DIM}  Esto puede tardar varios minutos (descarga ~2GB)...${RESET}`,
		);
		const cmd =
			'winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive --wait" --accept-package-agreements --accept-source-agreements';
		const r = run(cmd, { timeout: 600000 });
		if (r.ok || !r.output.toLowerCase().includes("error")) {
			console.log(`  ${LOG_OK} Visual Studio Build Tools instalado`);
			return true;
		}
		console.log(`${LOG_FAIL} Error: ${r.output}`);
		console.log(
			`${LOG_GRAY}  Instalacion manual: https://visualstudio.microsoft.com/visual-cpp-build-tools/${RESET}`,
		);
		console.log(
			`${LOG_GRAY}  Selecciona workload: 'Desktop development with C++'${RESET}`,
		);
		return false;
	}
	if (getPlatform() === "darwin") {
		console.log(`${LOG_INFO}  Instalando Xcode Command Line Tools...${RESET}`);
		run("xcode-select --install");
		console.log(
			`${LOG_WARN}  Sigue las instrucciones en pantalla. Luego re-ejecuta este instalador.${RESET}`,
		);
		return false;
	}
	console.log(`${LOG_INFO}  Instalando build-essential...${RESET}`);
	const r = run(
		"sudo apt-get update -qq && sudo apt-get install -y build-essential",
		{ timeout: 300000 },
	);
	if (r.ok) {
		console.log(`  ${LOG_OK} Build tools instalado`);
		return true;
	}
	console.log(
		`${LOG_FAIL} Error. Instala manualmente: sudo apt install build-essential${RESET}`,
	);
	return false;
}

function installDeps() {
	console.log(
		`\n${LOG_INFO}  Instalando dependencias (pnpm install)...${RESET}`,
	);
	const r = run("pnpm install --frozen-lockfile", { timeout: 300000 });
	if (!r.ok) {
		console.log(`${LOG_FAIL} Error: ${r.output}`);
		return false;
	}
	console.log(`  ${LOG_OK} Dependencias instaladas`);
	return true;
}

function checkDocumentRuntime() {
	return run(`"${process.execPath}" "${DOCUMENT_RUNTIME_INSTALLER}" --check`, {
		timeout: 60000,
	});
}

function installDocumentRuntime() {
	console.log(`${LOG_INFO}  Instalando LibreOffice desde el gestor oficial del sistema...${RESET}`);
	const result = run(`"${process.execPath}" "${DOCUMENT_RUNTIME_INSTALLER}"`, {
		timeout: 20 * 60_000,
	});
	if (!result.ok) {
		console.log(`${LOG_FAIL} Error instalando runtime documental: ${result.output}`);
		return false;
	}
	console.log(`  ${LOG_OK} ${result.output || "Runtime documental instalado"}`);
	return true;
}

function prepareOfflineOcr() {
	const command = `"${process.execPath}" -e "import('./packages/core/dist/index.js').then(m=>{const s=m.getOfflineOcrLanguageStatus();if(!s.every(x=>x.present&&x.size>0))process.exit(1);console.log(s.map(x=>x.code+':'+x.size).join(', '))})"`;
	const result = run(command, { timeout: 60000 });
	if (!result.ok) {
		console.log(`${LOG_FAIL} No se pudieron preparar los modelos OCR offline: ${result.output}`);
		return false;
	}
	console.log(`  ${LOG_OK} OCR offline listo (${result.output})`);
	return true;
}

function buildProject() {
	console.log(`${LOG_INFO}  Compilando proyecto (pnpm build)...${RESET}`);
	const r = run("pnpm build", { timeout: 120000 });
	if (!r.ok) {
		console.log(`${LOG_FAIL} Error: ${r.output}`);
		return false;
	}
	console.log(`  ${LOG_OK} Proyecto compilado`);
	return true;
}

async function setupWizard() {
	console.log(`\n${LOG_INFO}${LOG_BOLD}  Configuracion inicial${RESET}\n`);
	let rl;
	const envValue = (...names) => {
		for (const name of names) {
			const value = process.env[name];
			if (value?.trim()) return value.trim();
		}
		return "";
	};

	let zhipuKey = envValue("ZHIPU_API_KEY", "ZAI_API_KEY");
	let anthropicKey = envValue("ANTHROPIC_API_KEY");
	let openaiKey = envValue("OPENAI_API_KEY");
	let googleKey = envValue("GOOGLE_API_KEY", "GEMINI_API_KEY");
	let deepseekKey = envValue("DEEPSEEK_API_KEY");

	if (INTERACTIVE) {
		rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		const askKey = async (label, current = "") => {
			const hint = current
				? "detectada en entorno; Enter para conservar"
				: "Enter para saltar";
			const value = await ask(rl, `${LOG_WARN}  ${label} (${hint}): ${RESET}`);
			return value || current;
		};
		zhipuKey = await askKey("Z.ai / ZhipuAI API Key", zhipuKey);
		anthropicKey = await askKey("Anthropic API Key", anthropicKey);
		openaiKey = await askKey("OpenAI API Key", openaiKey);
		googleKey = await askKey("Google AI API Key", googleKey);
		deepseekKey = await askKey("DeepSeek API Key", deepseekKey);
	} else {
		console.log(
			`${LOG_DIM}  Modo automatico: usando API keys desde variables de entorno si existen. Podras configurar proveedor despues desde la interfaz web.${RESET}`,
		);
	}

	console.log(`\n${LOG_INFO}  Creando estructura de directorios...${RESET}`);
	const octopusDir = path.join(homedir(), ".octopus");
	for (const dir of ["data", "skills", "plugins", "workspace"].map((d) =>
		path.join(octopusDir, d),
	)) {
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	}
	console.log(`  ${LOG_OK} Directorios creados`);

	console.log(`${LOG_INFO}  Guardando configuracion...${RESET}`);
	const configPath = path.join(octopusDir, "config.json");

	const config = {
		version: 1,
		server: { port: 18789, host: "127.0.0.1", transport: "auto" },
		ai: {
			default: "zhipu/glm-5.1",
			fallback: "openai/gpt-4.1",
			providers: {
				anthropic: {
					apiKey: anthropicKey || "",
					models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
				},
				openai: {
					apiKey: openaiKey || "",
					models: ["gpt-4.1", "gpt-4o", "gpt-4o-mini", "o3", "o4-mini"],
				},
				google: {
					apiKey: googleKey || "",
					models: ["gemini-2.5-pro", "gemini-2.5-flash"],
				},
				zhipu: {
					apiKey: zhipuKey || "",
					mode: "coding-plan",
					models: [
						"glm-5.2",
						"glm-5.1",
						"glm-5",
						"glm-5-turbo",
						"glm-5v-turbo",
						"glm-4.6",
						"glm-4.6v",
					],
				},
				openrouter: { apiKey: "" },
				deepseek: {
					apiKey: deepseekKey || "",
					models: ["deepseek-chat", "deepseek-reasoner"],
				},
				mistral: {
					apiKey: "",
					models: ["mistral-large-3", "mistral-small-4", "codestral-25-08"],
				},
				xai: {
					apiKey: "",
					models: ["grok-4.20-0309-reasoning", "grok-4-1-fast-reasoning"],
				},
				cohere: {
					apiKey: "",
					models: ["command-a-03-2025", "command-a-vision-07-2025"],
				},
				local: {
					baseUrl: "http://localhost:11434",
					models: ["llama3.1", "codellama", "mistral", "qwen2.5"],
				},
			},
			thinking: "medium",
			maxTokens: 16384,
		},
		channels: {
			whatsapp: { enabled: false },
			telegram: { enabled: false },
			discord: { enabled: false },
			slack: { enabled: false },
			teams: { enabled: false },
			signal: { enabled: false },
			wechat: { enabled: false },
			webchat: { enabled: true },
		},
		connection: {
			autoProxy: true,
			retryMaxAttempts: 5,
			retryBaseDelay: 1000,
			circuitBreakerThreshold: 5,
			healthCheckInterval: 30000,
			offlineQueueSize: 1000,
			preferIPv4: true,
		},
		memory: {
			enabled: true,
			shortTerm: { maxTokens: 8192, scratchPadSize: 2048, autoEviction: true },
			longTerm: {
				backend: "sqlite-vss",
				importanceThreshold: 0.5,
				maxItems: 100000,
				episodic: { decayRate: 0.003, compressionAfter: "30d", maxAge: "365d" },
				semantic: { decayRate: 0.0001, contradictionCheck: true },
				associative: { enabled: true, cascadeDepth: 2, cascadeThreshold: 0.8 },
			},
			consolidation: {
				trigger: "task-complete",
				idleInterval: "30m",
				batchSize: 50,
				extractFacts: true,
				extractEvents: true,
				extractProcedures: true,
				buildAssociations: true,
				compressAndDecay: true,
			},
			retrieval: {
				maxResults: 10,
				maxTokens: 2000,
				minRelevance: 0.6,
				weights: { relevance: 0.5, recency: 0.3, frequency: 0.2 },
			},
		},
		skills: {
			enabled: true,
			autoCreate: true,
			autoImprove: true,
			forge: {
				complexityThreshold: 0.6,
				selfCritique: true,
				minQualityScore: 7,
				includeExamples: true,
				includeTemplates: true,
				includeAntiPatterns: true,
			},
			improvement: {
				triggerOnSuccessRate: 0.7,
				triggerOnRating: 3.5,
				reviewEveryNUses: 10,
				abTestMajorChanges: true,
				abTestSampleSize: 20,
			},
			loading: {
				maxTokenBudget: 3000,
				progressiveLevels: true,
				autoUnload: true,
				searchThreshold: 0.7,
			},
			registry: {
				path: "~/.octopus/skills",
				builtinSkills: [
					"general-reasoning",
					"code-generation",
					"writing",
					"research",
				],
			},
		},
		plugins: {
			directories: ["~/.octopus/plugins"],
			builtin: ["productivity", "coding"],
		},
		storage: { backend: "sqlite", path: "~/.octopus/data/octopus.db" },
		security: {
			encryptionKey: "",
			allowedPaths: ["~/Documents", "~/Desktop"],
			sandboxCommands: true,
		},
	};

	fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
	console.log(`  ${LOG_OK} Configuracion guardada en ~/.octopus/config.json`);

	rl?.close();
}

function octopusDirPath(...segments) {
	return path.join(homedir(), ".octopus", ...segments);
}

function quoteShell(value) {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function ensureUserBinOnPath(binDir) {
	const currentPath = process.env.PATH ?? "";
	const parts = currentPath.split(path.delimiter).map((p) => path.resolve(p));
	if (parts.includes(path.resolve(binDir))) return true;

	if (isWin) {
		const nextPath = `${currentPath}${path.delimiter}${binDir}`;
		const r = run(`setx PATH "${nextPath}"`, { timeout: 60000 });
		if (!r.ok) {
			console.log(
				`${LOG_WARN}  No se pudo actualizar PATH automaticamente: ${r.output}${RESET}`,
			);
			console.log(`${LOG_GRAY}  Agrega manualmente a PATH: ${binDir}${RESET}`);
			return false;
		}
		process.env.PATH = nextPath;
		return true;
	}

	const profilePath = path.join(homedir(), ".profile");
	const marker = "# Octopus AI CLI";
	const line = `export PATH=\"${binDir}:$PATH\"`;
	const existing = fs.existsSync(profilePath)
		? fs.readFileSync(profilePath, "utf8")
		: "";
	if (!existing.includes(binDir)) {
		fs.appendFileSync(profilePath, `\n${marker}\n${line}\n`, "utf8");
	}
	process.env.PATH = `${binDir}${path.delimiter}${currentPath}`;
	return true;
}

function installCliShims() {
	const binDir = octopusDirPath("bin");
	if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

	if (isWin) {
		const shim = (name) =>
			[
				"@echo off",
				`cd /d "${PROJECT_ROOT}"`,
				`"${process.execPath}" "${CLI_ENTRY}" %*`,
				"",
			].join("\r\n");
		fs.writeFileSync(path.join(binDir, "octopus.cmd"), shim("octopus"), "utf8");
		fs.writeFileSync(
			path.join(binDir, "octopus-ai.cmd"),
			shim("octopus-ai"),
			"utf8",
		);
	} else {
		const shim = [
			"#!/usr/bin/env sh",
			`cd ${quoteShell(PROJECT_ROOT)} || exit 1`,
			`exec ${quoteShell(process.execPath)} ${quoteShell(CLI_ENTRY)} "$@"`,
			"",
		].join("\n");
		for (const name of ["octopus", "octopus-ai"]) {
			const fp = path.join(binDir, name);
			fs.writeFileSync(fp, shim, "utf8");
			fs.chmodSync(fp, 0o755);
		}
	}

	ensureUserBinOnPath(binDir);
	console.log(`  ${LOG_OK} Comando global instalado en ${binDir}`);
	const check = run(
		isWin
			? "octopus --help"
			: `${quoteShell(path.join(binDir, "octopus"))} --help`,
		{ timeout: 60000 },
	);
	if (check.ok) console.log(`  ${LOG_OK} octopus --help verificado`);
	else
		console.log(
			`${LOG_WARN}  octopus se instaló, abre una terminal nueva si PATH aun no lo detecta.${RESET}`,
		);
	return true;
}

function ensureLogsDir() {
	const logsDir = octopusDirPath("logs");
	if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
	return logsDir;
}

function openUrl(url) {
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

function startDetachedServer() {
	const logsDir = ensureLogsDir();
	const out = fs.openSync(path.join(logsDir, "server.log"), "a");
	const err = fs.openSync(path.join(logsDir, "server.err.log"), "a");
	const child = spawn(
		process.execPath,
		[CLI_ENTRY, "start", "--no-open", "--no-choice"],
		{
			cwd: PROJECT_ROOT,
			detached: true,
			stdio: ["ignore", out, err],
			windowsHide: true,
		},
	);
	child.unref();
	console.log(`  ${LOG_OK} Octopus iniciado en segundo plano`);
}

async function waitForWeb(url, timeoutMs = 20000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
			if (response.ok) return true;
		} catch {
			/* retry */
		}
		await new Promise((resolve) => setTimeout(resolve, 750));
	}
	return false;
}

function installWindowsAutostart() {
	const logsDir = ensureLogsDir();
	const launcherPath = octopusDirPath("octopus-server.cmd");
	const logPath = path.join(logsDir, "server.log");
	const launcher = [
		"@echo off",
		`cd /d "${PROJECT_ROOT}"`,
		`"${process.execPath}" "${CLI_ENTRY}" start --no-open --no-choice >> "${logPath}" 2>&1`,
		"",
	].join("\r\n");
	fs.writeFileSync(launcherPath, launcher, "utf8");

	const create = run(
		`schtasks /Create /TN "${SERVICE_NAME}" /SC ONLOGON /F /TR "${launcherPath}"`,
		{ timeout: 60000 },
	);
	if (!create.ok) {
		console.log(
			`${LOG_FAIL} No se pudo crear la tarea de inicio: ${create.output}`,
		);
		return false;
	}

	const runNow = run(`schtasks /Run /TN "${SERVICE_NAME}"`, { timeout: 60000 });
	if (!runNow.ok) {
		console.log(
			`${LOG_WARN}  Tarea creada, pero no se pudo iniciar ahora: ${runNow.output}${RESET}`,
		);
		return true;
	}

	console.log(`  ${LOG_OK} Octopus quedo activo y se iniciara con tu sesion`);
	return true;
}

function installPersistentBackground() {
	if (isWin) return installWindowsAutostart();
	startDetachedServer();
	console.log(
		`${LOG_WARN}  Inicio automatico permanente aun no se configura en ${getPlatform()}. Octopus queda activo en segundo plano para esta sesion.${RESET}`,
	);
	return true;
}

function runCliForeground(args) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
			cwd: PROJECT_ROOT,
			stdio: "inherit",
			windowsHide: false,
		});
		child.on("close", () => resolve());
	});
}

async function postInstallActions() {
	if (!INTERACTIVE) {
		if (!SKIP_START) {
			startDetachedServer();
			const ready = await waitForWeb(WEB_URL);
			if (ready) {
				console.log(`  ${LOG_OK} Octopus listo en ${WEB_URL}`);
				if (!SKIP_OPEN) openUrl(WEB_URL);
			} else {
				console.log(
					`${LOG_WARN}  Octopus se inicio, pero la web aun no responde. Revisa ~/.octopus/logs/server.log o ejecuta: pnpm start${RESET}`,
				);
			}
		} else {
			console.log(
				`${LOG_INFO}  Arranque omitido por --no-start. Ejecuta pnpm start para iniciar.${RESET}`,
			);
		}
		return;
	}

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		console.log(
			`${LOG_INFO}${LOG_BOLD}  Activacion posterior a la instalacion${RESET}`,
		);
		const keepActive = await ask(
			rl,
			`  ${LOG_WARN}Dejar Octopus activo en segundo plano aunque cierres la consola? (S/n): ${RESET}`,
		);
		let backgroundStarted = false;
		if (keepActive.toLowerCase() !== "n") {
			backgroundStarted = installPersistentBackground();
		}

		console.log();
		console.log("  Como quieres entrar ahora?");
		console.log(`${LOG_INFO}    1) Abrir interfaz web${RESET}`);
		console.log(`${LOG_INFO}    2) Quedarme en consola/chat${RESET}`);
		console.log(`${LOG_INFO}    3) Solo dejarlo en segundo plano${RESET}`);
		console.log(`${LOG_INFO}    4) Salir${RESET}`);
		const mode = await ask(rl, `  ${LOG_WARN}Seleccion [1]: ${RESET}`);

		if ((mode === "" || mode === "1") && !backgroundStarted) {
			startDetachedServer();
			backgroundStarted = true;
		}
		if (mode === "" || mode === "1") {
			await new Promise((resolve) => setTimeout(resolve, 2500));
			openUrl(WEB_URL);
			console.log(`  ${LOG_OK} Interfaz web abierta: ${WEB_URL}`);
			return;
		}

		if (mode === "2") {
			if (!backgroundStarted) startDetachedServer();
			console.log(
				`${LOG_DIM}  Abriendo chat. Usa /exit para cerrar la consola; el servidor seguira activo.${RESET}`,
			);
			rl.close();
			await runCliForeground(["--console"]);
			return;
		}

		if (mode === "3") {
			if (!backgroundStarted) startDetachedServer();
			console.log(`  ${LOG_OK} Octopus queda ejecutandose en segundo plano`);
			return;
		}
	} finally {
		if (!rl.closed) rl.close();
	}
}

async function main() {
	banner();

	console.log(`${LOG_INFO}${LOG_BOLD}  Paso 1/8: Verificando Node.js${RESET}`);
	if (!checkNode()) process.exit(1);

	console.log(`\n${LOG_INFO}${LOG_BOLD}  Paso 2/8: Verificando pnpm${RESET}`);
	if (!ensurePnpm()) process.exit(1);

	console.log(`\n${LOG_INFO}${LOG_BOLD}  Paso 3/8: Verificando Python${RESET}`);
	let pythonOk = checkPython();
	if (!pythonOk) {
		console.log(`${LOG_WARN}  Python no encontrado.${RESET}`);
		if (
			await confirmInstall("Instalar Python automaticamente?", true, {
				systemDependency: true,
			})
		) {
			pythonOk = installPython();
		}
		if (!pythonOk) {
			console.log(
				`${LOG_WARN}  Sin Python, las tools/scripts Python pueden no estar disponibles.${RESET}`,
			);
		}
	}

	console.log(
		`\n${LOG_INFO}${LOG_BOLD}  Paso 4/8: Verificando Build Tools (C++)${RESET}`,
	);
	let btOk = checkBuildTools();
	if (!btOk) {
		console.log(`${LOG_WARN}  Build Tools no detectado.${RESET}`);
		console.log(
			`${LOG_DIM}  Requerido para dependencias nativas y soporte completo.${RESET}`,
		);
		if (
			await confirmInstall("Instalar Build Tools automaticamente?", true, {
				systemDependency: true,
			})
		) {
			btOk = installBuildTools();
		}
		if (!btOk) {
			console.log(
				`${LOG_WARN}  Sin Build Tools, solo fallaran dependencias nativas opcionales.${RESET}`,
			);
			if (!(await confirmInstall("Continuar de todas formas?", false)))
				process.exit(1);
		}
	}

	console.log(
		`\n${LOG_INFO}${LOG_BOLD}  Paso 4b/8: Verificando Docker${RESET}`,
	);
	let dockerOk = checkDocker();
	if (!dockerOk) {
		console.log(`${LOG_WARN}  Docker no encontrado.${RESET}`);
		if (
			await confirmInstall("Instalar Docker automaticamente?", false, {
				systemDependency: true,
			})
		) {
			dockerOk = installDocker();
		}
		if (!dockerOk) {
			console.log(
				`${LOG_WARN}  Docker queda omitido. Solo es necesario para despliegue/instalacion Docker.${RESET}`,
			);
		}
	}

	console.log(
		`\n${LOG_INFO}${LOG_BOLD}  Paso 5/8: Runtime documental${RESET}`,
	);
	if (SKIP_SYSTEM_DEPS) {
		console.log(`${LOG_WARN}  Runtime documental omitido por --no-system-deps.${RESET}`);
	} else {
		const documentRuntime = checkDocumentRuntime();
		if (documentRuntime.ok) {
			console.log(`  ${LOG_OK} ${documentRuntime.output}`);
		} else {
			console.log(`${LOG_WARN}  LibreOffice no encontrado (~700 MB-1 GB instalado).${RESET}`);
			const install = await confirmInstall(
				"Instalar LibreOffice para conversion, formatos legacy y QA visual?",
				true,
				{ systemDependency: true },
			);
			if (!install || !installDocumentRuntime()) {
				console.log(`${LOG_FAIL} Runtime documental requerido no disponible.`);
				console.log(`${LOG_GRAY}  Usa --no-system-deps solo si aceptas perder conversion Office/QA visual.${RESET}`);
				process.exit(1);
			}
		}
	}

	console.log(
		`\n${LOG_INFO}${LOG_BOLD}  Paso 6/8: Instalando dependencias Node${RESET}`,
	);
	let depsOk = installDeps();
	if (!depsOk && !btOk && !SKIP_SYSTEM_DEPS) {
		console.log(
			`${LOG_WARN}  pnpm install fallo y no hay Build Tools. Instalando Build Tools y reintentando...${RESET}`,
		);
		btOk = installBuildTools();
		if (btOk) depsOk = installDeps();
	}
	if (!depsOk) process.exit(1);

	console.log(
		`\n${LOG_INFO}${LOG_BOLD}  Paso 7/8: Compilando proyecto${RESET}`,
	);
	if (!buildProject()) process.exit(1);
	if (!prepareOfflineOcr()) process.exit(1);
	console.log(`${LOG_INFO}  Instalando comando global octopus...${RESET}`);
	installCliShims();

	console.log(
		`\n${LOG_INFO}${LOG_BOLD}  Paso 8/8: Configuracion inicial${RESET}`,
	);
	await setupWizard();

	console.log();
	console.log(
		`${LOG_GREEN_BOLD}  \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557${RESET}`,
	);
	console.log(
		`${LOG_GREEN_BOLD}  \u2551     Octopus AI instalado exitosamente     \u2551${RESET}`,
	);
	console.log(
		`${LOG_GREEN_BOLD}  \u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d${RESET}`,
	);
	console.log();
	console.log("  Comandos disponibles:");
	console.log(
		`${LOG_INFO}    octopus                         ${LOG_GRAY}Iniciar servidor y abrir consola TUI${RESET}`,
	);
	console.log(
		`${LOG_INFO}    octopus --web                   ${LOG_GRAY}Iniciar y abrir interfaz web${RESET}`,
	);
	console.log(
		`${LOG_INFO}    octopus --console               ${LOG_GRAY}Consola TUI sin duplicar runtime${RESET}`,
	);
	console.log(
		`${LOG_INFO}    octopus agent -m \"hola\"         ${LOG_GRAY}Enviar mensaje${RESET}`,
	);
	console.log(
		`${LOG_INFO}    octopus doctor                  ${LOG_GRAY}Diagnosticar${RESET}`,
	);
	console.log();
	await postInstallActions();
}

main().catch((err) => {
	console.error(
		`${LOG_RED}  Error fatal: ${err.message ?? String(err)}${RESET}`,
	);
	process.exit(1);
});
