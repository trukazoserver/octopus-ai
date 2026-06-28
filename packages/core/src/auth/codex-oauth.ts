/**
 * Codex / ChatGPT account login — mirrors the official Codex CLI OAuth flow
 * (openai/codex, codex-rs/login) so the user signs in with their OpenAI account
 * in their own default browser and we obtain a usable API key.
 *
 * Flow:
 *  1. Open the user's default browser at {issuer}/oauth/authorize with PKCE and
 *     the Codex CLI's exact parameters (originator, codex_cli_simplified_flow,
 *     id_token_add_organizations, the connectors scope).
 *  2. Loopback HTTP server on localhost:1455 (fallback 1457) receives the
 *     redirect, validates state, exchanges the code for tokens.
 *  3. Token-exchange grant (obtain_api_key): exchanges the id_token for an
 *     OpenAI API key — this is the credential we store and use (the raw OAuth
 *     access_token does NOT work against api.openai.com/v1).
 *
 * Constants verified against the Codex CLI source (github.com/openai/codex).
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { renderOAuthCallbackPage } from "./oauth.js";

/** Public Codex CLI OAuth client id (codex-rs/login/src/auth/manager.rs). */
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_ISSUER = "https://auth.openai.com";
const CODEX_AUTH_ENDPOINT = `${CODEX_ISSUER}/oauth/authorize`;
const CODEX_TOKEN_ENDPOINT = `${CODEX_ISSUER}/oauth/token`;
/** Exact scope the Codex CLI requests. */
const CODEX_SCOPES =
	"openid profile email offline_access api.connectors.read api.connectors.invoke";
const CODEX_ORIGINATOR = "codex_cli_rs";
const PREFERRED_PORT = 1455;
const FALLBACK_PORT = 1457;
const REDIRECT_PATH = "/auth/callback";
const LOGIN_TIMEOUT_MS = 5 * 60_000;

/** RFC 7636 PKCE (matches oauth.ts helpers, inlined to stay self-contained). */
function base64UrlEncode(buffer: Buffer): string {
	return buffer
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}
function generateCodeVerifier(): string {
	return base64UrlEncode(randomBytes(32));
}
function generateCodeChallenge(verifier: string): string {
	return base64UrlEncode(createHash("sha256").update(verifier).digest());
}

interface PkceCodes {
	verifier: string;
	challenge: string;
}

interface TokenResponse {
	access_token: string;
	id_token?: string;
	refresh_token?: string;
}

type CodexLoginStatus = "waiting" | "captured" | "error";

interface CodexLoginState {
	status: CodexLoginStatus;
	pkce: PkceCodes;
	state: string;
	apiKey?: string;
	accessToken?: string;
	refreshToken?: string;
	accountId?: string;
	error?: string;
	server?: Server;
	timeout?: ReturnType<typeof setTimeout>;
}

/**
 * Decode the OpenAI id_token JWT and extract the chatgpt_account_id needed for
 * Codex backend calls. The claim location varies; we check the common spots and
 * log the payload for validation if not found.
 */
function decodeAccountIdFromIdToken(idToken: string): string | undefined {
	try {
		const parts = idToken.split(".");
		if (parts.length < 2) return undefined;
		const payload = JSON.parse(
			Buffer.from(parts[1], "base64").toString("utf8"),
		) as Record<string, unknown>;
		if (typeof payload.chatgpt_account_id === "string") {
			return payload.chatgpt_account_id;
		}
		const auth = payload["https://api.openai.com/auth"] as
			| Record<string, unknown>
			| undefined;
		if (auth) {
			if (typeof auth.chatgpt_account_id === "string") {
				return auth.chatgpt_account_id;
			}
			if (typeof auth.organization_id === "string") {
				return auth.organization_id;
			}
		}
		if (typeof payload.organization_id === "string") {
			return payload.organization_id;
		}
		console.log(
			`[codex-oauth] account_id not found in id_token; claims: ${JSON.stringify(payload).slice(0, 600)}`,
		);
		return undefined;
	} catch {
		return undefined;
	}
}

let active: CodexLoginState | null = null;

function openDefaultBrowser(url: string): void {
	try {
		if (process.platform === "win32") {
			// Quote the URL so cmd.exe does not split on '&' in the query string
			// (otherwise the browser opens a truncated URL missing client_id /
			// redirect_uri / scope, and OpenAI returns missing_required_parameter).
			const child = spawn(`start "" "${url}"`, {
				detached: true,
				stdio: "ignore",
				shell: true,
			});
			child.unref();
		} else {
			const cmd = process.platform === "darwin" ? "open" : "xdg-open";
			const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
			child.unref();
		}
	} catch {
		// Best-effort.
	}
}

function buildAuthorizeUrl(
	redirectUri: string,
	pkce: PkceCodes,
	state: string,
): string {
	// Encode each value with encodeURIComponent (space -> %20), matching the
	// Codex CLI's urlencoding::encode. URLSearchParams would use '+' for spaces,
	// which OpenAI's auth does not accept in the scope parameter.
	const params: Array<[string, string]> = [
		["response_type", "code"],
		["client_id", CODEX_CLIENT_ID],
		["redirect_uri", redirectUri],
		["scope", CODEX_SCOPES],
		["code_challenge", pkce.challenge],
		["code_challenge_method", "S256"],
		["id_token_add_organizations", "true"],
		["codex_cli_simplified_flow", "true"],
		["state", state],
		["originator", CODEX_ORIGINATOR],
	];
	const qs = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
	return `${CODEX_AUTH_ENDPOINT}?${qs}`;
}

async function exchangeCodeForTokens(
	code: string,
	redirectUri: string,
	pkce: PkceCodes,
): Promise<TokenResponse> {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		client_id: CODEX_CLIENT_ID,
		code_verifier: pkce.verifier,
	});
	const response = await fetch(CODEX_TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => response.statusText);
		throw new Error(`Token exchange failed (${response.status}): ${text}`);
	}
	return (await response.json()) as TokenResponse;
}

/**
 * Token-exchange grant: trade the id_token for an OpenAI API key (the credential
 * that actually works against api.openai.com/v1). Mirrors Codex CLI
 * `obtain_api_key`.
 */
async function obtainApiKey(idToken: string): Promise<string> {
	const body = new URLSearchParams({
		grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
		client_id: CODEX_CLIENT_ID,
		requested_token: "openai-api-key",
		subject_token: idToken,
		subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
	});
	const response = await fetch(CODEX_TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => response.statusText);
		throw new Error(`API key exchange failed (${response.status}): ${text}`);
	}
	const data = (await response.json()) as { access_token: string };
	return data.access_token;
}

export interface CodexRefreshedToken {
	accessToken: string;
	/** Rotated refresh token, if the issuer returns a new one. */
	refreshToken?: string;
	/** Epoch ms when the new access token expires, if reported. */
	expiresAt?: number;
}

/**
 * Refresh the Codex (ChatGPT-account) OAuth access_token using the stored
 * refresh_token. Hits the SAME token endpoint + client_id as the login flow
 * (grant_type=refresh_token), so the refreshed access_token works directly
 * against the Codex backend (Responses API) — no obtain_api_key re-exchange
 * needed. Used by CodexProvider's reactive 401 refresh so an expired token
 * mid-task no longer kills the run.
 */
export async function refreshCodexToken(
	refreshToken: string,
): Promise<CodexRefreshedToken> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: CODEX_CLIENT_ID,
	});
	const response = await fetch(CODEX_TOKEN_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
		signal: AbortSignal.timeout(15000),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => response.statusText);
		throw new Error(
			`Codex token refresh failed (${response.status}): ${text.slice(0, 300)}`,
		);
	}
	const data = (await response.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
	};
	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt: data.expires_in
			? Date.now() + data.expires_in * 1000
			: undefined,
	};
}

function fail(message: string): void {
	if (!active) return;
	active.status = "error";
	active.error = message;
	if (active.timeout) clearTimeout(active.timeout);
}

async function closeServer(): Promise<void> {
	const current = active;
	if (!current?.server) return;
	await new Promise<void>((resolve) => {
		current.server?.close(() => resolve());
	});
}

function handleCallback(
	req: IncomingMessage,
	res: ServerResponse,
	pkce: PkceCodes,
	state: string,
	redirectUri: string,
): void {
	const url = new URL(req.url ?? "/", "http://localhost");
	if (url.pathname !== REDIRECT_PATH) {
		res.statusCode = 404;
		res.end();
		return;
	}
	const code = url.searchParams.get("code");
	const returnedState = url.searchParams.get("state");
	const errorParam = url.searchParams.get("error");
	if (errorParam) {
		renderOAuthCallbackPage(res, false, errorParam);
		fail(`OpenAI rechazó el login: ${errorParam}`);
		void closeServer();
		return;
	}
	if (!code || returnedState !== state) {
		renderOAuthCallbackPage(res, false, "Respuesta de OAuth inválida.");
		fail("Respuesta de OAuth inválida (state o code faltantes).");
		void closeServer();
		return;
	}
	exchangeCodeForTokens(code, redirectUri, pkce)
		.then(async (tokens) => {
			// Best-effort API-key exchange (matches Codex CLI `.ok()`): for
			// accounts without an organization it fails with "missing
			// organization_id"; in that case we fall back to the OAuth
			// access_token (used as the provider credential).
			let apiKey: string | undefined;
			if (tokens.id_token) {
				try {
					apiKey = await obtainApiKey(tokens.id_token);
				} catch {
					apiKey = undefined;
				}
			}
			if (active) {
				active.apiKey = apiKey;
				active.accessToken = apiKey ? undefined : tokens.access_token;
				active.refreshToken = tokens.refresh_token;
				active.accountId = tokens.id_token
					? decodeAccountIdFromIdToken(tokens.id_token)
					: undefined;
				active.status = "captured";
				if (active.timeout) clearTimeout(active.timeout);
			}
			console.log(
				`[codex-oauth] captured: apiKey=${apiKey ? "yes" : "no"} accessToken=${tokens.access_token ? "yes" : "no"} accountId=${active?.accountId ?? "none"}`,
			);
			renderOAuthCallbackPage(
				res,
				true,
				"Autenticación con OpenAI correcta. Ya puedes cerrar esta ventana y volver a Octopus AI.",
			);
		})
		.catch((err) => {
			renderOAuthCallbackPage(res, false, err.message);
			fail(err instanceof Error ? err.message : String(err));
		})
		.finally(() => {
			void closeServer();
		});
}

/**
 * Start the Codex account login: open the user's default browser and wait for
 * the OAuth redirect on a loopback server. Returns immediately once the browser
 * is opened; poll `getCodexStatus()`.
 */
export function startCodexLogin(): Promise<{ ok: boolean; error?: string }> {
	if (active && active.status === "waiting")
		return Promise.resolve({ ok: true });

	const verifier = generateCodeVerifier();
	const pkce: PkceCodes = {
		verifier,
		challenge: generateCodeChallenge(verifier),
	};
	const state = randomBytes(32).toString("hex");

	const state0: CodexLoginState = { status: "waiting", pkce, state };
	active = state0;

	const server = createServer(
		(req, res) => handleCallback(req, res, pkce, state, ""), // redirectUri filled after bind
	);
	state0.server = server;

	return new Promise((resolve) => {
		const tryBind = (port: number, isFallback: boolean): void => {
			server.removeAllListeners("error");
			server.on("error", (err: NodeJS.ErrnoException) => {
				if (
					!isFallback &&
					(err.code === "EADDRINUSE" || err.code === "EACCES")
				) {
					tryBind(FALLBACK_PORT, true);
					return;
				}
				fail(err.message);
				resolve({
					ok: false,
					error: `No se pudo iniciar el login (puerto ${port}): ${err.message}`,
				});
			});
			server.listen(port, "127.0.0.1", () => {
				const redirectUri = `http://localhost:${port}${REDIRECT_PATH}`;
				// Rebind the handler with the real redirectUri.
				server.removeAllListeners("request");
				server.on("request", (req, res) =>
					handleCallback(req, res, pkce, state, redirectUri),
				);
				state0.timeout = setTimeout(() => {
					if (active && active.status === "waiting") {
						fail("Timeout: no se completó el login a tiempo.");
						void closeServer();
					}
				}, LOGIN_TIMEOUT_MS);
				const authUrl = buildAuthorizeUrl(redirectUri, pkce, state);
				openDefaultBrowser(authUrl);
				resolve({ ok: true });
			});
		};
		tryBind(PREFERRED_PORT, false);
	});
}

export function getCodexStatus(): { status: string; error?: string } {
	if (!active) return { status: "idle" };
	return { status: active.status, error: active.error };
}

export function getCodexResult(): {
	apiKey?: string;
	accessToken?: string;
	refreshToken?: string;
	accountId?: string;
} | null {
	if (!active || active.status !== "captured") {
		return null;
	}
	if (!active.apiKey && !active.accessToken) {
		return null;
	}
	return {
		apiKey: active.apiKey,
		accessToken: active.accessToken,
		refreshToken: active.refreshToken,
		accountId: active.accountId,
	};
}
