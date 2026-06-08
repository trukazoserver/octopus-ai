import * as crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface OAuthProviderConfig {
	authorizationEndpoint: string;
	tokenEndpoint: string;
	scopes: string[];
	grantType?: string;
	clientId?: string;
	clientSecret?: string;
	usePKCE?: boolean;
	extraParams?: Record<string, string>;
	tokenBodyTransform?: (body: Record<string, string>) => Record<string, string>;
}

export interface OAuthTokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	token_type: string;
	scope?: string;
}

export interface OAuthState {
	codeVerifier: string;
	codeChallenge: string;
	redirectUri: string;
	provider: string;
	state: string;
	createdAt: number;
	clientId: string;
	clientSecret?: string;
}

const OAUTH_PROVIDERS: Record<string, () => OAuthProviderConfig> = {
	google: () => ({
		authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
		tokenEndpoint: "https://oauth2.googleapis.com/token",
		scopes: [
			"https://www.googleapis.com/auth/cloud-platform",
			"https://www.googleapis.com/auth/userinfo.email",
		],
		usePKCE: true,
		extraParams: { prompt: "consent", access_type: "offline" },
	}),
	openai: () => ({
		authorizationEndpoint: "https://auth.openai.com/authorize",
		tokenEndpoint: "https://auth.openai.com/oauth/token",
		scopes: ["openid", "profile", "email"],
		usePKCE: true,
	}),
	anthropic: () => ({
		authorizationEndpoint: "https://console.anthropic.com/oauth/authorize",
		tokenEndpoint: "https://console.anthropic.com/oauth/token",
		scopes: ["openid", "profile", "email"],
		usePKCE: true,
	}),
};

const pendingStates = new Map<string, OAuthState>();

function base64UrlEncode(buffer: Buffer): string {
	return buffer
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

export function generateCodeVerifier(): string {
	const bytes = crypto.randomBytes(32);
	return base64UrlEncode(bytes);
}

export function generateCodeChallenge(verifier: string): string {
	return base64UrlEncode(crypto.createHash("sha256").update(verifier).digest());
}

export function getOAuthProvider(provider: string): OAuthProviderConfig | null {
	const factory = OAUTH_PROVIDERS[provider];
	return factory ? factory() : null;
}

export function getAvailableOAuthProviders(): string[] {
	return Object.keys(OAUTH_PROVIDERS);
}

export function createAuthorizationUrl(
	provider: string,
	redirectUri: string,
	clientId: string,
	clientSecret?: string,
): { url: string; state: string } {
	const config = getOAuthProvider(provider);
	if (!config) throw new Error(`OAuth not supported for provider: ${provider}`);

	const state = crypto.randomBytes(16).toString("hex");
	const codeVerifier = generateCodeVerifier();
	const codeChallenge = generateCodeChallenge(codeVerifier);

	pendingStates.set(state, {
		codeVerifier,
		codeChallenge,
		redirectUri,
		provider,
		state,
		clientId,
		clientSecret,
		createdAt: Date.now(),
	});

	cleanupExpiredStates();

	const params = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: redirectUri,
		scope: config.scopes.join(" "),
		state,
		...(config.usePKCE
			? { code_challenge: codeChallenge, code_challenge_method: "S256" }
			: {}),
		...(config.extraParams ?? {}),
	});

	if (clientSecret) {
		params.set("client_secret", clientSecret);
	}

	return {
		url: `${config.authorizationEndpoint}?${params.toString()}`,
		state,
	};
}

export async function exchangeCodeForToken(
	provider: string,
	code: string,
	stateParam: string,
): Promise<OAuthTokenResponse> {
	const pending = pendingStates.get(stateParam);
	if (!pending) throw new Error("Invalid or expired OAuth state");
	if (pending.provider !== provider) {
		throw new Error("State does not match provider");
	}
	pendingStates.delete(stateParam);

	const config = getOAuthProvider(provider);
	if (!config) throw new Error(`OAuth not supported for provider: ${provider}`);

	const tokenBody: Record<string, string> = {
		grant_type: config.grantType ?? "authorization_code",
		code,
		redirect_uri: pending.redirectUri,
		client_id: pending.clientId ?? "",
	};

	if (pending.clientSecret) {
		tokenBody.client_secret = pending.clientSecret;
	}

	if (config.usePKCE) {
		tokenBody.code_verifier = pending.codeVerifier;
	}

	const finalBody = config.tokenBodyTransform
		? config.tokenBodyTransform(tokenBody)
		: tokenBody;

	const response = await fetch(config.tokenEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(finalBody).toString(),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Token exchange failed (${response.status}): ${errorText}`);
	}

	return (await response.json()) as OAuthTokenResponse;
}

export async function refreshAccessToken(
	provider: string,
	refreshToken: string,
	clientId: string,
	clientSecret?: string,
): Promise<OAuthTokenResponse> {
	const config = getOAuthProvider(provider);
	if (!config) throw new Error(`OAuth not supported for provider: ${provider}`);

	const body: Record<string, string> = {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: clientId,
	};

	if (clientSecret) {
		body.client_secret = clientSecret;
	}

	const response = await fetch(config.tokenEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body).toString(),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
	}

	return (await response.json()) as OAuthTokenResponse;
}

function cleanupExpiredStates(): void {
	const now = Date.now();
	const maxAge = 10 * 60 * 1000;
	for (const [key, value] of pendingStates) {
		if (now - value.createdAt > maxAge) {
			pendingStates.delete(key);
		}
	}
}

export function renderOAuthCallbackPage(
	res: ServerResponse,
	success: boolean,
	message?: string,
): void {
	const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>OAuth ${success ? "Exitoso" : "Error"}</title>
<style>
body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}
.box{text-align:center;padding:48px;border-radius:16px;background:#1e293b;max-width:420px;width:90%}
.icon{font-size:48px;margin-bottom:16px}
h2{margin:0 0 8px;font-size:1.4rem}
p{margin:0;color:#94a3b8;font-size:0.9rem;line-height:1.5}
</style></head><body>
<div class="box">
<div class="icon">${success ? "&#10003;" : "&#10007;"}</div>
<h2>${success ? "Autenticacion exitosa" : "Error de autenticacion"}</h2>
<p>${message ?? (success ? "Puedes cerrar esta ventana y volver a Octopus AI." : "No se pudo completar la autenticacion. Intenta de nuevo.")}</p>
</div>
<script>window.close();</script>
</body></html>`;
	res.writeHead(success ? 200 : 400, {
		"Content-Type": "text/html; charset=utf-8",
	});
	res.end(html);
}

export function handleOAuthCallback(
	req: IncomingMessage,
	res: ServerResponse,
): Promise<{ provider: string; tokens: OAuthTokenResponse } | null> {
	return new Promise((resolve) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		const pathParts = url.pathname.split("/").filter(Boolean);

		if (
			pathParts.length < 4 ||
			pathParts[0] !== "api" ||
			pathParts[1] !== "auth"
		) {
			resolve(null);
			return;
		}

		const provider = pathParts[2];
		const action = pathParts[3];

		if (action === "callback") {
			const code = url.searchParams.get("code");
			const stateParam = url.searchParams.get("state");
			const error = url.searchParams.get("error");

			if (error) {
				renderOAuthCallbackPage(
					res,
					false,
					url.searchParams.get("error_description") ?? error,
				);
				resolve(null);
				return;
			}

			if (!code || !stateParam) {
				renderOAuthCallbackPage(res, false, "Missing code or state parameter");
				resolve(null);
				return;
			}

			exchangeCodeForToken(provider, code, stateParam)
				.then((tokens) => {
					renderOAuthCallbackPage(res, true);
					resolve({ provider, tokens });
				})
				.catch((err) => {
					renderOAuthCallbackPage(res, false, err.message);
					resolve(null);
				});
		} else {
			resolve(null);
		}
	});
}
