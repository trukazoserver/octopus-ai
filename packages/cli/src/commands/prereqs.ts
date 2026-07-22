import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { platform } from "node:os";
import * as path from "node:path";
import {
	findLibreOfficeExecutable,
	getOfflineOcrLanguageStatus,
} from "@octopus-ai/core";
import chalk from "chalk";

export interface PrereqResult {
	name: string;
	passed: boolean;
	message: string;
	fixHint?: string;
	autoInstall?: () => Promise<boolean>;
}

function run(cmd: string, opts?: { timeout?: number }): string {
	try {
		return execSync(cmd, {
			encoding: "utf-8",
			timeout: opts?.timeout ?? 15000,
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return "";
	}
}

function runShell(
	cmd: string,
	opts?: { cwd?: string },
): { ok: boolean; output: string } {
	const shell = platform() === "win32" ? process.env.COMSPEC || "cmd.exe" : "/bin/sh";
	const shellArgs = platform() === "win32" ? ["/c", cmd] : ["-lc", cmd];
	const result = spawnSync(shell, shellArgs, {
		encoding: "utf-8",
		timeout: 300000,
		cwd: opts?.cwd,
		stdio: "pipe",
	});
	return {
		ok: result.status === 0,
		output: (result.stdout ?? "") + (result.stderr ?? ""),
	};
}

function findProjectRoot(): string | null {
	let current = process.cwd();
	while (current) {
		if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return null;
}

export function checkPrerequisites(): PrereqResult[] {
	const results: PrereqResult[] = [];
	const isWin = platform() === "win32";

	const nodeVersion = process.version;
	const [major = 0, minor = 0] = nodeVersion.slice(1).split(".").map(Number);
	const nodeOk = major > 22 || (major === 22 && minor >= 13);
	results.push({
		name: "Node.js",
		passed: nodeOk,
		message:
			nodeOk
				? `${nodeVersion} (>= 22.13)`
				: `${nodeVersion} (se requiere >= 22.13)`,
		fixHint: "Instala Node.js 22.13+ desde https://nodejs.org",
	});

	const libreOfficePath = findLibreOfficeExecutable();
	const libreOfficeVersion = libreOfficePath
		? run(`${platform() === "win32" ? `"${libreOfficePath}"` : `'${libreOfficePath.replace(/'/g, "'\\''")}'`} --headless --version`)
		: "";
	const projectRoot = findProjectRoot();
	const documentInstaller = projectRoot
		? path.join(projectRoot, "scripts", "install-document-runtime.mjs")
		: null;
	results.push({
		name: "LibreOffice",
		passed: Boolean(libreOfficePath && libreOfficeVersion),
		message: libreOfficeVersion || "No encontrado; conversión Office, legacy y QA visual no disponibles",
		fixHint: "Ejecuta: pnpm install:documents",
		autoInstall: documentInstaller
			? async () => {
					console.log(chalk.cyan("    Instalando LibreOffice desde el gestor oficial..."));
					const command = `"${process.execPath}" "${documentInstaller}"`;
					const result = runShell(command, { cwd: projectRoot ?? undefined });
					if (result.ok) return true;
					console.log(chalk.red(`    Error: ${result.output}`));
					return false;
				}
			: undefined,
	});

	try {
		const languages = getOfflineOcrLanguageStatus();
		const ready = languages.length >= 2 && languages.every((language) => language.present && language.size > 0);
		results.push({
			name: "OCR offline (eng+spa)",
			passed: ready,
			message: ready
				? languages.map((language) => `${language.code} ${(language.size / 1024 / 1024).toFixed(1)} MB`).join(", ")
				: "Modelos OCR offline incompletos",
			fixHint: "Ejecuta pnpm install --frozen-lockfile y pnpm build",
		});
	} catch (error) {
		results.push({
			name: "OCR offline (eng+spa)",
			passed: false,
			message: error instanceof Error ? error.message : String(error),
			fixHint: "Ejecuta pnpm install --frozen-lockfile",
		});
	}

	const pnpmVersion = run("pnpm --version");
	results.push({
		name: "pnpm",
		passed: !!pnpmVersion,
		message: pnpmVersion ? `v${pnpmVersion}` : "No encontrado",
		fixHint: "Se instalará automáticamente via npm",
		autoInstall: async () => {
			console.log(chalk.cyan("    Instalando pnpm globalmente..."));
			const r = runShell("npm install -g pnpm");
			if (r.ok) {
				console.log(chalk.green("    pnpm instalado correctamente"));
				return true;
			}
			console.log(chalk.red(`    Error: ${r.output}`));
			return false;
		},
	});

	const pythonVersion = run("python --version") || run("python3 --version");
	results.push({
		name: "Python (opcional)",
		passed: true,
		message:
			pythonVersion ||
			"No encontrado; solo requerido para scripts o tools Python",
		fixHint: isWin
			? "Se intentará instalar via winget"
			: "Ejecuta: sudo apt install python3 (Debian/Ubuntu) o brew install python3 (macOS)",
		autoInstall: isWin
			? async () => {
					console.log(chalk.cyan("    Instalando Python via winget..."));
					const r = runShell(
						"winget install Python.Python.3.12 --accept-package-agreements --accept-source-agreements",
					);
					if (
						r.ok ||
						r.output.includes("Already installed") ||
						r.output.includes("Ya se encuentra instalado")
					) {
						console.log(chalk.green("    Python instalado correctamente"));
						return true;
					}
					console.log(chalk.red(`    Error: ${r.output}`));
					return false;
				}
			: undefined,
	});

	let buildToolsOk = false;
	if (isWin) {
		buildToolsOk = checkWindowsBuildTools();
		results.push({
			name: "Build Tools (C++, opcional)",
			passed: true,
			message: buildToolsOk
				? "Visual Studio Build Tools detectado"
				: "No detectado; solo requerido para dependencias nativas opcionales",
			fixHint: "Se intentará instalar Visual Studio Build Tools via winget",
			autoInstall: async () => {
				console.log(
					chalk.cyan(
						"    Instalando Visual Studio Build Tools 2022 via winget...",
					),
				);
				console.log(
					chalk.gray("    Esto puede tardar varios minutos (descarga ~2GB)..."),
				);

				const cmd =
					'winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive --wait" --accept-package-agreements --accept-source-agreements';
				const r = runShell(cmd, { cwd: "C:\\" });

				if (
					r.ok ||
					r.output.includes("Successfully installed") ||
					r.output.includes("Already installed") ||
					!r.output.includes("error")
				) {
					console.log(
						chalk.green(
							"    Visual Studio Build Tools instalado correctamente",
						),
					);
					return true;
				}
				console.log(chalk.red(`    Error: ${r.output}`));
				return false;
			},
		});
	} else {
		const ccVersion = run("cc --version") || run("gcc --version");
		buildToolsOk = !!ccVersion;
		results.push({
			name: "Build Tools (C/C++, opcional)",
			passed: true,
			message: buildToolsOk
				? "Compilador detectado"
				: "No detectado; solo requerido para dependencias nativas opcionales",
			fixHint:
				"Ejecuta: sudo apt install build-essential (Debian/Ubuntu) o xcode-select --install (macOS)",
			autoInstall:
				platform() === "darwin"
					? async () => {
							console.log(chalk.cyan("    Instalando Command Line Tools..."));
							const r = runShell("xcode-select --install");
							console.log(
								chalk.yellow(
									"    Sigue las instrucciones en pantalla para completar la instalación",
								),
							);
							return true;
						}
					: undefined,
		});
	}

	return results;
}

export function checkNativeBindings(): PrereqResult {
	const projectRoot = findProjectRoot();
	let sqlJsOk = false;
	const [nodeMajor = 0, nodeMinor = 0] = process.versions.node
		.split(".")
		.map(Number);
	const nativeSqliteOk = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13);

	if (projectRoot) {
		const rootPath = path.join(projectRoot, "node_modules", "sql.js");
		const corePath = path.join(
			projectRoot,
			"packages",
			"core",
			"node_modules",
			"sql.js",
		);
		sqlJsOk = fs.existsSync(rootPath) || fs.existsSync(corePath);
	}

	return {
		name: "SQLite",
		passed: nativeSqliteOk || sqlJsOk,
		message: nativeSqliteOk
			? `SQLite nativo disponible en Node ${process.versions.node}`
			: sqlJsOk
				? "SQLite WASM disponible como fallback"
				: "SQLite nativo requiere Node 22.13+ y no se encontró SQL.js",
		fixHint: "Actualiza Node a 22.13 o superior",
		autoInstall: async () => {
			const root = projectRoot ?? process.cwd();
			console.log(chalk.cyan("    Instalando dependencias..."));
			const r = runShell("pnpm install", { cwd: root });
			if (r.ok) {
				console.log(chalk.green("    Dependencias instaladas correctamente"));
				return true;
			}
			console.log(chalk.red(`    Error: ${r.output}`));
			return false;
		},
	};
}

function checkWindowsBuildTools(): boolean {
	try {
		const vswhere =
			'"C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe"';
		const output = execSync(
			`${vswhere} -latest -property installationPath 2>nul`,
			{ encoding: "utf-8", timeout: 10000 },
		).trim();
		if (output.length > 0) return true;
	} catch {
		// vswhere not found
	}

	const vsPaths = [
		"C:\\Program Files\\Microsoft Visual Studio",
		"C:\\Program Files (x86)\\Microsoft Visual Studio",
	];
	for (const vsPath of vsPaths) {
		if (fs.existsSync(vsPath)) {
			try {
				const years = fs.readdirSync(vsPath);
				for (const year of years) {
					const editions = fs.readdirSync(path.join(vsPath, year));
					for (const edition of editions) {
						const msBuild = path.join(
							vsPath,
							year,
							edition,
							"MS",
							"Current",
							"Bin",
							"MSBuild.exe",
						);
						if (fs.existsSync(msBuild)) return true;
					}
				}
			} catch {}
		}
	}

	const clPath = run("where cl.exe 2>nul");
	if (clPath) return true;

	return false;
}

export function printPrereqResults(results: PrereqResult[]): boolean {
	let allPassed = true;
	for (const result of results) {
		const icon = result.passed ? chalk.green("✓") : chalk.red("✗");
		const label = chalk.white(`${result.name}:`.padEnd(22));
		const detail = result.passed
			? chalk.gray(result.message)
			: chalk.yellow(result.message);
		console.log(`  ${icon} ${label} ${detail}`);
		if (!result.passed) allPassed = false;
	}
	return allPassed;
}

export async function autoInstallMissing(
	results: PrereqResult[],
): Promise<boolean> {
	const missing = results.filter((r) => !r.passed && r.autoInstall);
	if (missing.length === 0) return true;

	console.log(
		chalk.cyan.bold(
			`\n  Instalando ${missing.length} requisito(s) faltante(s)...\n`,
		),
	);

	let allOk = true;
	for (const item of missing) {
		console.log(chalk.white(`  Instalando ${item.name}...`));
		const ok = await item.autoInstall?.();
		if (!ok) {
			console.log(chalk.red(`  Falló la instalación de ${item.name}`));
			if (item.fixHint) {
				console.log(chalk.gray(`  Alternativa manual: ${item.fixHint}`));
			}
			allOk = false;
		}
	}

	return allOk;
}
