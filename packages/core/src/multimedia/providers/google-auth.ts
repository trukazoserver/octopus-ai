import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { OctopusConfig } from "../../config/schema.js";

type VertexConfig = OctopusConfig["ai"]["providers"]["vertex"];
type GeminiConfig = OctopusConfig["ai"]["providers"]["gemini"];

export interface GoogleServiceAccountCredentials {
	client_email?: string;
	private_key?: string;
	token_uri?: string;
	project_id?: string;
}

export function resolveGeminiApiKey(config: GeminiConfig): string {
	const envName = config.apiKeyEnv?.trim();
	return (
		config.apiKey?.trim() ||
		(envName ? process.env[envName]?.trim() : "") ||
		process.env.GEMINI_API_KEY?.trim() ||
		process.env.GOOGLE_API_KEY?.trim() ||
		""
	);
}

export function loadVertexCredentials(
	config: VertexConfig,
): GoogleServiceAccountCredentials | null {
	const inline = config.credentialsJson?.trim();
	if (inline) {
		return JSON.parse(inline) as GoogleServiceAccountCredentials;
	}
	const configuredFile = config.credentialsFile?.trim();
	const envCredential = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
	if (envCredential?.startsWith("{")) {
		return JSON.parse(envCredential) as GoogleServiceAccountCredentials;
	}
	const file = configuredFile || envCredential;
	if (!file || !existsSync(file)) return null;
	return JSON.parse(readFileSync(file, "utf8")) as GoogleServiceAccountCredentials;
}

export function resolveVertexProjectId(config: VertexConfig): string {
	return (
		config.projectId?.trim() ||
		loadVertexCredentials(config)?.project_id?.trim() ||
		process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
		process.env.GCLOUD_PROJECT?.trim() ||
		""
	);
}

export async function resolveVertexAccessToken(
	config: VertexConfig,
	fetchImpl: typeof fetch,
): Promise<string> {
	const envName = config.accessTokenEnv?.trim();
	const configured =
		config.accessToken?.trim() ||
		config.oauthAccessToken?.trim() ||
		(envName ? process.env[envName]?.trim() : "") ||
		process.env.GOOGLE_VERTEX_ACCESS_TOKEN?.trim();
	if (configured) return configured;

	const credentials = loadVertexCredentials(config);
	if (!credentials?.client_email || !credentials.private_key) {
		throw new Error(
			"Google Agent Platform requires an access token or service-account credentials",
		);
	}
	const tokenUri = credentials.token_uri ?? "https://oauth2.googleapis.com/token";
	const now = Math.floor(Date.now() / 1000);
	const assertion = signJwt(
		{
			iss: credentials.client_email,
			scope: "https://www.googleapis.com/auth/cloud-platform",
			aud: tokenUri,
			iat: now,
			exp: now + 3600,
		},
		credentials.private_key,
	);
	const response = await fetchImpl(tokenUri, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion,
		}),
	});
	if (!response.ok) {
		throw new Error(
			`Google access token request failed: ${response.status} ${await response.text()}`,
		);
	}
	const payload = (await response.json()) as { access_token?: string };
	if (!payload.access_token) throw new Error("Google access token response is incomplete");
	return payload.access_token;
}

function signJwt(payload: Record<string, unknown>, privateKey: string): string {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value))
			.toString("base64url");
	const header = encode({ alg: "RS256", typ: "JWT" });
	const body = encode(payload);
	const input = `${header}.${body}`;
	const signature = createSign("RSA-SHA256").update(input).sign(privateKey);
	return `${input}.${signature.toString("base64url")}`;
}
