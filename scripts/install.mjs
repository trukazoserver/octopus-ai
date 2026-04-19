#!/usr/bin/env node
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { platform as getPlatform, homedir } from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

const isWin = getPlatform() === "win32";
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
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
	console.log();
}

function checkNode() {
	const major = Number.parseInt(
		process.version.slice(1).split(".")[0] ?? "0",
		10,
	);
	if (major < 22) {
		console.log(`${LOG_FAIL} Node.js ${process.version} - se requiere >= 22`);
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
	if (platform() === "darwin") {
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
	if (platform() === "darwin") {
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
	const r = run("pnpm install", { timeout: 300000 });
	if (!r.ok) {
		console.log(`${LOG_FAIL} Error: ${r.output}`);
		return false;
	}
	console.log(`  ${LOG_OK} Dependencias instaladas`);
	return true;
}

function rebuildSqlite() {
	console.log(`${LOG_INFO}  Recompilando better-sqlite3...${RESET}`);
	const r = run("pnpm rebuild better-sqlite3", { timeout: 120000 });
	if (!r.ok) {
		console.log(`${LOG_FAIL} Error: ${r.output}`);
		console.log(
			`${LOG_GRAY}  Verifica que Build Tools (C++) este instalado.${RESET}`,
		);
		return false;
	}
	console.log(`  ${LOG_OK} better-sqlite3 compilado`);
	return true;
}

function checkBindings() {
	const bs3Path = path.join(PROJECT_ROOT, "node_modules", "better-sqlite3");
	if (!fs.existsSync(bs3Path)) return false;
	try {
		return fs.readdirSync(path.join(bs3Path, "prebuilds")).length > 0;
	} catch {
		return fs.existsSync(
			path.join(bs3Path, "build", "Release", "better_sqlite3.node"),
		);
	}
}

function buildProject() {
	console.log(`${LOG_INFO}  Compilando proyecto (pnpm build)...${RESET}`);
	const r = run("pnpm build", { timeout: 120000 });
	if (!r.ok) {
		console.log(`${LOG_FAIL} Error: ${r.output}`);
		return false;
	}
	console.log(`  ${LOG_OK} Proyecto compilado (11 paquetes)`);
	return true;
}

async function setupWizard() {
	console.log(`\n${LOG_INFO}${LOG_BOLD}  Configuracion inicial${RESET}\n`);
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	const zhipuKey = await ask(
		rl,
		`${LOG_WARN}  Z.ai / ZhipuAI API Key (proveedor por defecto, Enter para saltar): ${RESET}`,
	);
	const anthropicKey = await ask(
		rl,
		`${LOG_WARN}  Anthropic API Key (Enter para saltar): ${RESET}`,
	);
	const openaiKey = await ask(
		rl,
		`${LOG_WARN}  OpenAI API Key (Enter para saltar): ${RESET}`,
	);
	const googleKey = await ask(
		rl,
		`${LOG_WARN}  Google AI API Key (Enter para saltar): ${RESET}`,
	);
	const deepseekKey = await ask(
		rl,
		`${LOG_WARN}  DeepSeek API Key (Enter para saltar): ${RESET}`,
	);

	console.log(`\n${LOG_INFO}  Creando estructura de directorios...${RESET}`);
	const octopusDir = path.join(homedir(), ".octopus");
	for (const dir of ["data", "skills", "plugins"].map((d) =>
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
						"glm-5.1",
						"glm-5",
						"glm-5-turbo",
						"glm-5v-turbo",
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

	rl.close();
}

async function main() {
	banner();

	console.log(`${LOG_INFO}${LOG_BOLD}  Paso 1/7: Verificando Node.js${RESET}`);
	if (!checkNode()) process.exit(1);

	console.log(`\n${LOG_INFO}${LOG_BOLD}  Paso 2/7: Verificando pnpm${RESET}`);
	if (!ensurePnpm()) process.exit(1);

	console.log(`\n${LOG_INFO}${LOG_BOLD}  Paso 3/7: Verificando Python${RESET}`);
	let pythonOk = checkPython();
	if (!pythonOk) {
		console.log(`${LOG_WARN}  Python no encontrado.${RESET}`);
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		const ans = await ask(
			rl,
			`  ${LOG_WARN}Instalar Python automaticamente? (S/n): ${RESET}`,
		);
		rl.close();
		if (ans.toLowerCase() !== "n") {
			pythonOk = installPython();
		}
		if (!pythonOk) {
			console.log(
				`${LOG_WARN}  Sin Python, algunos modulos nativos pueden fallar.${RESET}`,
			);
		}
	}

	console.log(
		`\n${LOG_INFO}${LOG_BOLD}  Paso 4/7: Verificando Build Tools (C++)${RESET}`,
	);
	let btOk = checkBuildTools();
	if (!btOk) {
		console.log(`${LOG_WARN}  Build Tools no detectado.${RESET}`);
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		const ans = await ask(
			rl,
			`  ${LOG_WARN}Instalar Build Tools automaticamente? (S/n): ${RESET}`,
		);
		rl.close();
		if (ans.toLowerCase() !== "n") {
			btOk = installBuildTools();
		}
		if (!btOk) {
			console.log(
				`${LOG_RED}  Sin Build Tools, better-sqlite3 no podra compilarse.${RESET}`,
			);
			const rl2 = readline.createInterface({
				input: process.stdin,
				output: process.stdout,
			});
			const cont = await ask(
				rl2,
				`  ${LOG_WARN}Continuar de todas formas? (s/N): ${RESET}`,
			);
			rl2.close();
			if (cont.toLowerCase() !== "s") process.exit(1);
		}
	}

	console.log(
		`\n${LOG_INFO}${LOG_BOLD}  Paso 5/7: Instalando dependencias${RESET}`,
	);
	if (!installDeps()) process.exit(1);

	if (btOk && !checkBindings()) {
		console.log(
			`\n${LOG_INFO}${LOG_BOLD}  Paso 5b: Compilando better-sqlite3${RESET}`,
		);
		if (!rebuildSqlite()) {
			console.log(
				`${LOG_WARN}  better-sqlite3 no se pudo compilar. BD y memoria no disponibles.${RESET}`,
			);
		}
	} else if (checkBindings()) {
		console.log(`  ${LOG_OK} better-sqlite3 bindings OK`);
	}

	console.log(
		`\n${LOG_INFO}${LOG_BOLD}  Paso 6/7: Compilando proyecto${RESET}`,
	);
	if (!buildProject()) process.exit(1);

	console.log(
		`\n${LOG_INFO}${LOG_BOLD}  Paso 7/7: Configuracion inicial${RESET}`,
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
		`${LOG_INFO}    node packages/cli/dist/index.js start          ${LOG_GRAY}Iniciar servidor${RESET}`,
	);
	console.log(
		`${LOG_INFO}    node packages/cli/dist/index.js chat            ${LOG_GRAY}Chat interactivo${RESET}`,
	);
	console.log(
		`${LOG_INFO}    node packages/cli/dist/index.js agent -m \"hola\"${LOG_GRAY}Enviar mensaje${RESET}`,
	);
	console.log(
		`${LOG_INFO}    node packages/cli/dist/index.js doctor          ${LOG_GRAY}Diagnosticar${RESET}`,
	);
	console.log();
}

main().catch((err) => {
	console.error(
		`${LOG_RED}  Error fatal: ${err.message ?? String(err)}${RESET}`,
	);
	process.exit(1);
});
