/**
 * Google Cloud connection via `gcloud` Application Default Credentials (ADC).
 *
 * The user runs `gcloud auth application-default login` once (or we spawn it for
 * them); gcloud writes a well-known ADC file containing an `authorized_user`
 * refresh credential whose client_id/client_secret belong to gcloud itself — so
 * we never ask the user for an OAuth Client ID. We exchange that refresh token
 * for a short-lived `cloud-platform` access token and feed it to
 * `prepareVertexProject`, which mints a self-contained service-account key.
 *
 * gcloud/ADC is therefore needed ONLY at setup time. After the SA key is
 * written, the vertex provider authenticates via SA JWT (see
 * ai/providers/google.ts) and gcloud is never needed again.
 */
import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { refreshAccessToken } from "./oauth.js";

const ADC_FILENAME = "application_default_credentials.json";
const GCLOUD_LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface AdcCredentials {
	type: "authorized_user";
	client_id: string;
	client_secret: string;
	refresh_token: string;
	account?: string;
	quota_project_id?: string;
}

export interface AdcAccessToken {
	accessToken: string;
	expiresAt: number;
}

export type GcloudLoginStatus = "idle" | "running" | "ready" | "error";

export interface GcloudLoginSnapshot {
	status: GcloudLoginStatus;
	startedAt?: number;
	account?: string;
	error?: string;
}

interface GcloudLoginSession {
	status: "running" | "ready" | "error";
	startedAt: number;
	account?: string;
	error?: string;
	child?: ReturnType<typeof spawn>;
	staleTimer?: ReturnType<typeof setTimeout>;
}

let active: GcloudLoginSession | null = null;

/**
 * Locate the gcloud binary across platforms. Mirrors the resolution strategy of
 * `findBrowserExecutable` (auth/browser-session.ts): Windows resolves candidates
 * via `cmd /c for %I in (...) do @echo %~fI` with an existsSync fallback; Unix
 * uses `command -v`. The Windows binary is `gcloud.cmd` (a batch wrapper), so
 * callers MUST spawn it with `shell: true`.
 */
export function findGcloudBinary(): string | undefined {
	const envPath = process.env.GCLOUD_PATH;
	if (envPath && existsSync(envPath)) return envPath;

	if (process.platform === "win32") {
		const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
		const programFilesX86 =
			process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
		const localAppData =
			process.env.LOCALAPPDATA ?? win32.join(homedir(), "AppData", "Local");
		const candidates = [
			"gcloud.cmd",
			win32.join(
				localAppData,
				"Google",
				"Cloud SDK",
				"google-cloud-sdk",
				"bin",
				"gcloud.cmd",
			),
			win32.join(
				localAppData,
				"google-cloud-cli",
				"google-cloud-sdk",
				"bin",
				"gcloud.cmd",
			),
			win32.join(
				programFiles,
				"Google",
				"Cloud SDK",
				"google-cloud-sdk",
				"bin",
				"gcloud.cmd",
			),
			win32.join(
				programFilesX86,
				"Google",
				"Cloud SDK",
				"google-cloud-sdk",
				"bin",
				"gcloud.cmd",
			),
		];
		for (const candidate of candidates) {
			const resolved = resolveWindowsCandidate(candidate);
			if (resolved) return resolved;
		}
		return undefined;
	}

	// Unix (darwin / linux).
	const onPath = tryExecSync("command -v gcloud");
	if (onPath && existsSync(onPath)) return onPath;
	const unixCandidates = [
		"/usr/lib/google-cloud-sdk/bin/gcloud",
		"/usr/local/bin/gcloud",
		posix.join(homedir(), "google-cloud-sdk", "bin", "gcloud"),
		"/opt/google-cloud-sdk/bin/gcloud",
		"/usr/bin/gcloud",
	];
	for (const candidate of unixCandidates) {
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** Resolve a Windows candidate (PATH name or absolute) to an existing path. */
function resolveWindowsCandidate(candidate: string): string | undefined {
	// `for %I in (...) do @echo %~fI` resolves a PATH name or absolute path to
	// its full path (handles spaces). tryExecSync swallows failures (returns
	// undefined), so fall back to a direct existsSync check on the candidate.
	const out = tryExecSync(`for %I in ("${candidate}") do @echo %~fI`);
	if (out) {
		for (const line of out.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (trimmed && existsSync(trimmed)) return trimmed;
		}
	}
	return existsSync(candidate) ? candidate : undefined;
}

function tryExecSync(cmd: string): string | undefined {
	try {
		// spawnSync avoids execSync's shell-quoting pitfalls; shell:true lets us
		// run `command -v` / `for` which are shell builtins.
		const res = spawnSync(cmd, {
			shell: true,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (res.status !== 0 || !res.stdout) return undefined;
		const trimmed = res.stdout.trim();
		return trimmed || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Well-known ADC file path. Honors `CLOUDSDK_CONFIG` first (power users / CI),
 * then the OS-default gcloud config directory.
 */
export function getAdcFilePath(): string {
	const configEnv = process.env.CLOUDSDK_CONFIG;
	if (configEnv?.trim()) {
		return (process.platform === "win32" ? win32 : posix).join(
			configEnv,
			ADC_FILENAME,
		);
	}
	if (process.platform === "win32") {
		const appdata =
			process.env.APPDATA ?? win32.join(homedir(), "AppData", "Roaming");
		return win32.join(appdata, "gcloud", ADC_FILENAME);
	}
	return posix.join(homedir(), ".config", "gcloud", ADC_FILENAME);
}

/** Read + validate the ADC file. Returns null (never throws) when absent/invalid. */
export function readAdcCredentials(): AdcCredentials | null {
	let raw: string;
	try {
		raw = readFileSync(getAdcFilePath(), "utf8");
	} catch {
		return null;
	}
	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (!obj || obj.type !== "authorized_user") return null;
	const client_id = str(obj.client_id);
	const client_secret = str(obj.client_secret);
	const refresh_token = str(obj.refresh_token);
	if (!client_id || !client_secret || !refresh_token) return null;
	return {
		type: "authorized_user",
		client_id,
		client_secret,
		refresh_token,
		account: str(obj.account) || undefined,
		quota_project_id: str(obj.quota_project_id) || undefined,
	};
}

function str(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** Exchange the ADC refresh token for a short-lived access token. */
export async function exchangeAdcForAccessToken(
	creds: AdcCredentials,
): Promise<AdcAccessToken> {
	const tokens = await refreshAccessToken(
		"google",
		creds.refresh_token,
		creds.client_id,
		creds.client_secret,
	);
	return {
		accessToken: tokens.access_token,
		expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
	};
}

/**
 * Run a gcloud subcommand synchronously and return its output. Uses shell:true
 * on Windows so the `gcloud.cmd` batch wrapper is invoked correctly.
 */
function runGcloud(args: string[]): {
	ok: boolean;
	stdout: string;
	stderr: string;
} {
	const binary = findGcloudBinary();
	if (!binary) {
		return { ok: false, stdout: "", stderr: "gcloud binary not found" };
	}
	const res = runGcloudSync(binary, args);
	return {
		ok: res.status === 0 && !!res.stdout,
		stdout: (res.stdout ?? "").trim(),
		stderr: (res.stderr ?? "").trim(),
	};
}

/** The currently-active gcloud account (the one print-access-token uses). */
export function getActiveGcloudAccount(): string | undefined {
	return runGcloud(["config", "get-value", "account"]).stdout || undefined;
}

/**
 * Spawn gcloud with a PATH that includes its bin dir. gcloud.cmd typically lives
 * in a path with spaces (e.g. "Google\Cloud SDK\..."); cmd.exe mangles a spaced
 * path passed as the command, so on Windows we prepend the bin dir to PATH and
 * run the bare "gcloud.cmd" — cmd resolves it via PATH and the .bat handles its
 * own spaced %~dp0 internally.
 */
function runGcloudSync(
	binary: string,
	args: string[],
): SpawnSyncReturns<string> {
	const isWin = process.platform === "win32";
	const prevPath = process.env.PATH;
	try {
		if (isWin) {
			const binDir = win32.dirname(binary);
			process.env.PATH = `${binDir};${prevPath ?? ""}`;
			return spawnSync("gcloud.cmd", args, {
				shell: true,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
		}
		return spawnSync(binary, args, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	} finally {
		process.env.PATH = prevPath;
	}
}

/**
 * Get a fresh `cloud-platform` access token by invoking
 * `gcloud auth print-access-token`. This is the RELIABLE source: Google blocks
 * third-party refresh of ADC user tokens ("access_denied / Account Restricted"),
 * but gcloud refreshes its own account credentials internally and Google
 * permits that. Requires gcloud + an active account (`gcloud auth login`).
 */
export function getGcloudAccessTokenViaCli(): string {
	const res = runGcloud(["auth", "print-access-token"]);
	if (!res.ok || !res.stdout) {
		throw new Error(
			`gcloud auth print-access-token falló${res.stderr ? `: ${res.stderr}` : ""}`,
		);
	}
	return res.stdout;
}

/**
 * Resolve a usable access token, preferring the gcloud CLI (reliable) and
 * falling back to a manual ADC refresh (blocked by Google for some accounts,
 * but kept as a fallback). Throws if neither works.
 */
export async function resolveGcloudAccessToken(): Promise<{
	accessToken: string;
	source: "gcloud-cli" | "adc";
}> {
	if (findGcloudBinary()) {
		try {
			const token = getGcloudAccessTokenViaCli();
			if (token) return { accessToken: token, source: "gcloud-cli" };
		} catch {
			// Fall through to ADC refresh.
		}
	}
	const creds = readAdcCredentials();
	if (creds) {
		const tokens = await exchangeAdcForAccessToken(creds);
		return { accessToken: tokens.accessToken, source: "adc" };
	}
	throw new Error(
		"No hay credenciales de Google disponibles. Ejecuta `gcloud auth login`.",
	);
}

/**
 * Spawn `gcloud auth application-default login` detached (non-blocking) and
 * track its progress in the module-level `active` session. Returns immediately;
 * poll {@link getGcloudLoginStatus}.
 *
 * Idempotent: if ADC already exists, jumps straight to "ready" without spawning;
 * if a login is already running, returns ok without a second spawn.
 */
export function spawnGcloudLogin(): { ok: boolean; error?: string } {
	const binary = findGcloudBinary();
	if (!binary) return { ok: false, error: "gcloud-not-found" };

	// Always open the browser so the user can choose/confirm their Google
	// account (matches the "connect / reconnect with another account" UX). We
	// deliberately do NOT short-circuit when ADC already exists.
	if (active && active.status === "running") {
		return { ok: true };
	}

	// `gcloud auth login` (not application-default) so the chosen account becomes
	// the gcloud ACTIVE account — we later use `gcloud auth print-access-token`,
	// which reads the active account, not the ADC file. This lets the user pick
	// the Google account that actually has billing (e.g. a Workspace account)
	// instead of whatever was previously active.
	const args = ["auth", "login"];
	let child: ReturnType<typeof spawn>;
	try {
		if (process.platform === "win32") {
			// gcloud.cmd lives in a path with spaces ("Cloud SDK"); cmd.exe mangles
			// a spaced command, so prepend the bin dir to PATH and spawn the bare
			// "gcloud.cmd" (shell:true required for .cmd per CVE-2024-27980).
			const binDir = win32.dirname(binary);
			const prevPath = process.env.PATH;
			process.env.PATH = `${binDir};${prevPath ?? ""}`;
			try {
				child = spawn("gcloud.cmd", args, {
					detached: true,
					stdio: "ignore",
					shell: true,
					windowsHide: true,
				});
			} finally {
				process.env.PATH = prevPath;
			}
		} else {
			child = spawn(binary, args, { detached: true, stdio: "ignore" });
		}
		child.unref();
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}

	const session: GcloudLoginSession = {
		status: "running",
		startedAt: Date.now(),
		child,
	};
	session.staleTimer = setTimeout(() => {
		if (active === session && active.status === "running") {
			active.status = "error";
			active.error =
				"Timeout: no se completó el login de gcloud a tiempo (5 min).";
			try {
				session.child?.kill();
			} catch {
				// Best-effort.
			}
		}
	}, GCLOUD_LOGIN_TIMEOUT_MS);
	active = session;

	child.on("exit", (code, signal) => {
		if (active !== session || active.status !== "running") return;
		if (session.staleTimer) clearTimeout(session.staleTimer);
		if (code === 0) {
			// `gcloud auth login` updates the ACTIVE account, not (necessarily) the
			// ADC file. Read the active account to confirm + surface it in the UI.
			const account = runGcloud(["config", "get-value", "account"]).stdout;
			if (account) {
				active.status = "ready";
				active.account = account;
			} else {
				active.status = "error";
				active.error =
					"Login no completado (sin cuenta activa). ¿Cancelaste en el navegador?";
			}
		} else {
			active.status = "error";
			active.error = `gcloud salió con código ${code ?? signal}`;
		}
	});
	child.on("error", (err) => {
		if (active !== session || active.status !== "running") return;
		if (session.staleTimer) clearTimeout(session.staleTimer);
		active.status = "error";
		active.error = err.message;
	});

	return { ok: true };
}

export function getGcloudLoginStatus(): GcloudLoginSnapshot {
	if (!active) return { status: "idle" };
	return {
		status: active.status,
		startedAt: active.startedAt,
		account: active.account,
		error: active.error,
	};
}

/** Reset the login session (kill any running child). Used by tests + reconnect. */
export function resetGcloudLoginSession(): void {
	if (active) {
		if (active.staleTimer) clearTimeout(active.staleTimer);
		if (active.status === "running") {
			try {
				active.child?.kill();
			} catch {
				// Best-effort.
			}
		}
	}
	active = null;
}
