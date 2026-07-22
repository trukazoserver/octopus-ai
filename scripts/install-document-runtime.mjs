#!/usr/bin/env node
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has("--check");
const DRY_RUN = args.has("--dry-run");
const JSON_OUTPUT = args.has("--json");
const WITH_POPPLER = args.has("--with-poppler");

function commandExists(command) {
	const result = spawnSync(
		platform() === "win32" ? "where.exe" : "sh",
		platform() === "win32" ? [command] : ["-lc", `command -v ${command}`],
		{ encoding: "utf8", windowsHide: true },
	);
	return result.status === 0;
}

function findLibreOffice() {
	const explicit = process.env.OCTOPUS_SOFFICE_PATH?.trim();
	const names = platform() === "win32" ? ["soffice.com", "soffice.exe"] : ["soffice", "libreoffice"];
	const candidates = [
		explicit,
		...names.flatMap((name) =>
			(process.env.PATH ?? "")
				.split(delimiter)
				.filter(Boolean)
				.map((directory) => join(directory.replace(/^"|"$/g, ""), name)),
		),
		platform() === "win32" ? "C:\\Program Files\\LibreOffice\\program\\soffice.com" : undefined,
		platform() === "win32" ? "C:\\Program Files\\LibreOffice\\program\\soffice.exe" : undefined,
		platform() === "win32" ? "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe" : undefined,
		process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "LibreOffice", "program", "soffice.com") : undefined,
		process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "LibreOffice", "program", "soffice.exe") : undefined,
		platform() === "darwin" ? "/Applications/LibreOffice.app/Contents/MacOS/soffice" : undefined,
		platform() === "linux" ? "/usr/bin/soffice" : undefined,
		platform() === "linux" ? "/usr/bin/libreoffice" : undefined,
	].filter(Boolean);
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function versionOf(executable) {
	if (!executable) return "";
	const result = spawnSync(executable, ["--headless", "--version"], {
		encoding: "utf8",
		timeout: 30_000,
		windowsHide: true,
	});
	return result.status === 0 ? `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() : "";
}

function installPlan() {
	if (platform() === "win32") {
		if (!commandExists("winget")) throw new Error("WinGet is required. Install App Installer from Microsoft Store.");
		const commands = [["winget", ["install", "--exact", "--id", "TheDocumentFoundation.LibreOffice", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements", "--silent"]]];
		if (WITH_POPPLER) commands.push(["winget", ["install", "--exact", "--id", "oschwartz10612.Poppler", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements", "--silent"]]);
		return commands;
	}
	if (platform() === "darwin") {
		if (!commandExists("brew")) throw new Error("Homebrew is required to install LibreOffice automatically on macOS.");
		const commands = [["brew", ["install", "--cask", "libreoffice"]]];
		if (WITH_POPPLER) commands.push(["brew", ["install", "poppler"]]);
		return commands;
	}
	if (commandExists("apt-get")) {
		const packages = ["libreoffice-writer", "libreoffice-calc", "libreoffice-impress", "fonts-dejavu-core", "fonts-liberation"];
		if (WITH_POPPLER) packages.push("poppler-utils");
		return privilegedPlans(["apt-get", "update"], ["apt-get", "install", "-y", "--no-install-recommends", ...packages]);
	}
	if (commandExists("dnf")) {
		const packages = ["libreoffice-core", "libreoffice-writer", "libreoffice-calc", "libreoffice-impress"];
		if (WITH_POPPLER) packages.push("poppler-utils");
		return privilegedPlans(["dnf", "install", "-y", ...packages]);
	}
	if (commandExists("pacman")) {
		const packages = ["libreoffice-fresh"];
		if (WITH_POPPLER) packages.push("poppler");
		return privilegedPlans(["pacman", "-S", "--needed", "--noconfirm", ...packages]);
	}
	throw new Error(`No supported system package manager found for ${platform()}.`);
}

function privilegedPlans(...commands) {
	const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
	if (!isRoot && !commandExists("sudo")) throw new Error("Administrator privileges are required, but sudo was not found.");
	return commands.map(([command, ...commandArgs]) =>
		isRoot ? [command, commandArgs] : ["sudo", [command, ...commandArgs]],
	);
}

function runPlan(plan) {
	for (const [command, commandArgs] of plan) {
		const printable = [command, ...commandArgs].join(" ");
		if (DRY_RUN) {
			console.log(printable);
			continue;
		}
		console.log(`Running: ${printable}`);
		const result = spawnSync(command, commandArgs, {
			stdio: "inherit",
			timeout: 20 * 60_000,
			windowsHide: false,
		});
		if (result.status !== 0) throw new Error(`Command failed (${result.status}): ${printable}`);
	}
}

function status() {
	const executable = findLibreOffice();
	return {
		platform: platform(),
		libreOffice: {
			available: Boolean(executable && versionOf(executable)),
			executable,
			version: versionOf(executable),
		},
		poppler: {
			requested: WITH_POPPLER,
			available: commandExists(platform() === "win32" ? "pdfinfo.exe" : "pdfinfo"),
		},
	};
}

async function main() {
	const before = status();
	if (CHECK_ONLY || before.libreOffice.available) {
		if (JSON_OUTPUT) console.log(JSON.stringify(before, null, 2));
		else console.log(before.libreOffice.available ? `LibreOffice ready: ${before.libreOffice.version}` : "LibreOffice not found");
		process.exitCode = before.libreOffice.available ? 0 : 1;
		return;
	}
	const plan = installPlan();
	runPlan(plan);
	if (DRY_RUN) return;
	const after = status();
	if (!after.libreOffice.available) throw new Error("LibreOffice installation completed but soffice could not be verified. Open a new terminal or set OCTOPUS_SOFFICE_PATH.");
	console.log(`LibreOffice ready: ${after.libreOffice.version}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
