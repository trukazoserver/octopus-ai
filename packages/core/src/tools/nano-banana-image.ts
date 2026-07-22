import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { ConfigLoader } from "../config/loader.js";
import {
	ensureTransparentImage,
	isTransparentImageRequested,
	prepareTransparentImagePrompt,
	type ChromaKey,
} from "./codex-image.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./registry.js";

type NanoProvider = "gemini-api" | "vertex";

type NanoConnection = {
	provider: NanoProvider;
	model: string;
	url: string;
	headers: Record<string, string>;
};

type ServiceAccount = {
	client_email?: string;
	private_key?: string;
	token_uri?: string;
	project_id?: string;
};

const VALID_ASPECT_RATIOS = [
	"auto",
	"1:1",
	"1:4",
	"1:8",
	"2:3",
	"3:2",
	"3:4",
	"4:1",
	"4:3",
	"4:5",
	"5:4",
	"8:1",
	"9:16",
	"16:9",
	"21:9",
] as const;
const VALID_RESOLUTIONS = ["512", "1K", "2K", "4K"] as const;
const WORKSPACE_DIR = join(homedir(), ".octopus", "workspace");
let vertexTokenCache: { token: string; expiresAt: number } | undefined;

function firstConfigured(...values: Array<string | undefined>): string | undefined {
	return values.find((value) => Boolean(value?.trim()))?.trim();
}

function normalizeNanoModel(model: string): string {
	return model.replace(/-preview$/, "");
}

function base64Url(value: string | Buffer): string {
	return Buffer.from(value)
		.toString("base64")
		.replace(/=/g, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
}

function signJwt(credentials: ServiceAccount): string {
	if (!credentials.client_email || !credentials.private_key) {
		throw new Error("Google service account credentials are incomplete.");
	}
	const now = Math.floor(Date.now() / 1000);
	const tokenUri =
		credentials.token_uri || "https://oauth2.googleapis.com/token";
	const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = base64Url(
		JSON.stringify({
			iss: credentials.client_email,
			scope: "https://www.googleapis.com/auth/cloud-platform",
			aud: tokenUri,
			iat: now,
			exp: now + 3600,
		}),
	);
	const signer = createSign("RSA-SHA256");
	signer.update(`${header}.${payload}`);
	return `${header}.${payload}.${base64Url(signer.sign(credentials.private_key.replace(/\\n/g, "\n")))}`;
}

function loadServiceAccount(config: {
	credentialsJson?: string;
	credentialsFile?: string;
}): ServiceAccount | undefined {
	if (config.credentialsJson?.trim()) {
		return JSON.parse(config.credentialsJson) as ServiceAccount;
	}
	const file =
		config.credentialsFile || process.env.GOOGLE_APPLICATION_CREDENTIALS;
	if (!file || !existsSync(file)) return undefined;
	return JSON.parse(readFileSync(file, "utf8")) as ServiceAccount;
}

async function getVertexAccessToken(config: {
	accessToken?: string;
	accessTokenEnv?: string;
	oauthAccessToken?: string;
	credentialsJson?: string;
	credentialsFile?: string;
}): Promise<string> {
	const configured = firstConfigured(
		config.accessToken,
		config.accessTokenEnv ? process.env[config.accessTokenEnv] : undefined,
		config.oauthAccessToken,
		process.env.GOOGLE_VERTEX_ACCESS_TOKEN,
	);
	if (configured) return configured;
	if (vertexTokenCache && vertexTokenCache.expiresAt > Date.now() + 60_000) {
		return vertexTokenCache.token;
	}
	const credentials = loadServiceAccount(config);
	if (!credentials) {
		throw new Error(
			"Vertex AI requires an access token or Google service account credentials.",
		);
	}
	const tokenUri =
		credentials.token_uri || "https://oauth2.googleapis.com/token";
	const response = await fetch(tokenUri, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion: signJwt(credentials),
		}),
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		throw new Error(
			`Vertex token request failed (${response.status}): ${(await response.text()).slice(0, 300)}`,
		);
	}
	const payload = (await response.json()) as {
		access_token?: string;
		expires_in?: number;
	};
	if (!payload.access_token)
		throw new Error("Vertex token response is missing access_token.");
	vertexTokenCache = {
		token: payload.access_token,
		expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
	};
	return payload.access_token;
}

async function loadNanoConnection(): Promise<NanoConnection> {
	const config = new ConfigLoader().load();
	const settings = config.tools.imageGeneration.nanoBanana;
	const configuredModel = settings.model || "gemini-3.1-flash-image";
	if (settings.provider === "gemini-api") {
		const model = normalizeNanoModel(configuredModel);
		const gemini = config.ai.providers.gemini;
		const apiKey = firstConfigured(
			gemini.apiKey,
			gemini.apiKeyEnv ? process.env[gemini.apiKeyEnv] : undefined,
			process.env.GEMINI_API_KEY,
			process.env.GOOGLE_API_KEY,
		);
		if (!apiKey) {
			throw new Error(
				"Gemini API key is required for the selected Nano Banana provider.",
			);
		}
		const baseUrl = (
			gemini.baseUrl || "https://generativelanguage.googleapis.com/v1"
		)
			.replace(/\/openai\/?$/, "")
			.replace(/\/+$/, "");
		return {
			provider: "gemini-api",
			model,
			url: `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
			headers: {
				"content-type": "application/json",
				"x-goog-api-key": apiKey,
			},
		};
	}

	const vertex = config.ai.providers.vertex;
	const model = normalizeNanoModel(configuredModel);
	const credentials = loadServiceAccount(vertex);
	const projectId =
		vertex.projectId ??
		credentials?.project_id ??
		process.env.GOOGLE_CLOUD_PROJECT ??
		process.env.GCLOUD_PROJECT;
	if (!projectId?.trim()) throw new Error("Vertex AI projectId is required.");
	const location =
		vertex.location ??
		process.env.GOOGLE_CLOUD_LOCATION ??
		process.env.GOOGLE_CLOUD_REGION ??
		"global";
	const token = await getVertexAccessToken(vertex);
	const vertexHost =
		location === "global"
			? "aiplatform.googleapis.com"
			: `${location}-aiplatform.googleapis.com`;
	const baseUrl = `https://${vertexHost}/v1`;
	return {
		provider: "vertex",
		model,
		url: `${baseUrl}/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`,
		headers: {
			"content-type": "application/json",
			Authorization: `Bearer ${token}`,
		},
	};
}

async function resolveReferenceImage(
	input: string,
	context: ToolContext,
): Promise<{ data: string; mimeType: string }> {
	if (input.startsWith("data:")) {
		throw new Error("Pass media URLs or file paths, not base64 data URLs.");
	}
	if (input.startsWith("/api/media/file/")) {
		const resolved = await context.media.resolve(input);
		return {
			data: resolved.buffer.toString("base64"),
			mimeType: resolved.mimeType,
		};
	}
	if (/^https?:\/\//i.test(input)) {
		const response = await fetch(input, {
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok)
			throw new Error(`Reference image fetch failed (${response.status}).`);
		return {
			data: Buffer.from(await response.arrayBuffer()).toString("base64"),
			mimeType: response.headers.get("content-type") || "image/jpeg",
		};
	}
	const absolute = isAbsolute(input) ? input : resolve(WORKSPACE_DIR, input);
	const rel = relative(WORKSPACE_DIR, absolute);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(
			"Reference image path must stay inside the Octopus workspace.",
		);
	}
	if (!existsSync(absolute))
		throw new Error(`Reference image not found: ${input}`);
	const ext = extname(absolute).toLowerCase();
	const mimeType =
		ext === ".png"
			? "image/png"
			: ext === ".webp"
				? "image/webp"
				: "image/jpeg";
	return { data: readFileSync(absolute).toString("base64"), mimeType };
}

function extractImageParts(
	payload: unknown,
): Array<{ data: string; mimeType: string }> {
	const root = payload as {
		candidates?: Array<{
			content?: { parts?: Array<Record<string, unknown>> };
		}>;
	};
	const images: Array<{ data: string; mimeType: string }> = [];
	for (const candidate of root.candidates ?? []) {
		for (const part of candidate.content?.parts ?? []) {
			const inline = (part.inlineData ?? part.inline_data) as
				| { data?: string; mimeType?: string; mime_type?: string }
				| undefined;
			if (inline?.data) {
				images.push({
					data: inline.data,
					mimeType: inline.mimeType || inline.mime_type || "image/png",
				});
			}
		}
	}
	return images;
}

export function createNanoBananaImageTools(): ToolDefinition[] {
	return [
		{
			name: "nano-banana-generate",
			description:
				"Generate or edit images with Nano Banana using the provider selected in Settings: Gemini API or Vertex AI. Supports 512/1K/2K/4K, aspect ratios, up to 14 references, Google Search grounding, and real transparent PNG output via dynamic chroma key.",
			uiIcon: "image",
			longRunning: true,
			parameters: {
				prompt: {
					type: "string",
					description: "Image generation or editing prompt.",
					required: true,
				},
				reference_images: {
					type: "array",
					description:
						"Optional media URLs, HTTP URLs, or workspace paths (max 14).",
					required: false,
				},
				aspect_ratio: {
					type: "string",
					description: `Output aspect ratio: ${VALID_ASPECT_RATIOS.join(", ")}.`,
					required: false,
				},
				resolution: {
					type: "string",
					description: "Output resolution: 512, 1K, 2K, or 4K.",
					required: false,
				},
				background: {
					type: "string",
					description: "auto | opaque | transparent.",
					required: false,
				},
				negative_prompt: {
					type: "string",
					description: "Elements to avoid.",
					required: false,
				},
				style: {
					type: "string",
					description: "Visual style guidance.",
					required: false,
				},
				system_instruction: {
					type: "string",
					description: "Optional system instruction.",
					required: false,
				},
				temperature: {
					type: "number",
					description: "Sampling temperature (0-2).",
					required: false,
				},
				topP: {
					type: "number",
					description: "Nucleus sampling threshold (0-1).",
					required: false,
				},
				enable_grounding: {
					type: "boolean",
					description: "Enable Google Search grounding.",
					required: false,
				},
			},
			handler: async (
				params: Record<string, unknown>,
				context,
			): Promise<ToolResult> => {
				const prompt = String(params.prompt ?? "").trim();
				if (!prompt)
					return { success: false, output: "", error: "Missing 'prompt'." };
				const aspectRatio = String(params.aspect_ratio ?? "auto");
				const resolution = String(params.resolution ?? "1K");
				const background = String(params.background ?? "auto").toLowerCase();
				if (
					!VALID_ASPECT_RATIOS.includes(
						aspectRatio as (typeof VALID_ASPECT_RATIOS)[number],
					)
				) {
					return {
						success: false,
						output: "",
						error: `Invalid aspect_ratio: ${aspectRatio}.`,
					};
				}
				if (
					!VALID_RESOLUTIONS.includes(
						resolution as (typeof VALID_RESOLUTIONS)[number],
					)
				) {
					return {
						success: false,
						output: "",
						error: `Invalid resolution: ${resolution}.`,
					};
				}
				if (!["auto", "opaque", "transparent"].includes(background)) {
					return {
						success: false,
						output: "",
						error: `Invalid background: ${background}.`,
					};
				}
				const references = Array.isArray(params.reference_images)
					? params.reference_images.map(String).filter(Boolean)
					: [];
				if (references.length > 14) {
					return {
						success: false,
						output: "",
						error: "Nano Banana accepts at most 14 reference images.",
					};
				}

				try {
					const connection = await loadNanoConnection();
					let fullPrompt = prompt;
					if (params.style)
						fullPrompt += `. Visual style: ${String(params.style)}`;
					if (params.negative_prompt) {
						fullPrompt += `. IMPORTANT - Avoid/do NOT include: ${String(params.negative_prompt)}`;
					}
					const transparencyRequested = isTransparentImageRequested(
						fullPrompt,
						background,
					);
					const transparency = transparencyRequested
						? prepareTransparentImagePrompt(fullPrompt)
						: undefined;
					if (transparency) fullPrompt = transparency.prompt;

					const parts: Array<Record<string, unknown>> = [{ text: fullPrompt }];
					for (const input of references) {
						const ref = await resolveReferenceImage(input, context);
						parts.push({
							inlineData: { mimeType: ref.mimeType, data: ref.data },
						});
					}
					const imageSettings =
						aspectRatio === "auto"
							? { imageSize: resolution }
							: { aspectRatio, imageSize: resolution };
					const generationConfig: Record<string, unknown> = {
						responseModalities: ["TEXT", "IMAGE"],
						imageConfig: imageSettings,
						...(params.temperature !== undefined
							? { temperature: Number(params.temperature) }
							: {}),
						...(params.topP !== undefined ? { topP: Number(params.topP) } : {}),
					};
					const body: Record<string, unknown> = {
						contents: [{ role: "user", parts }],
						generationConfig,
						...(params.system_instruction
							? {
									systemInstruction: {
										parts: [{ text: String(params.system_instruction) }],
									},
								}
							: {}),
						...(params.enable_grounding
							? {
									tools: [
										connection.provider === "gemini-api"
											? { google_search: {} }
											: { googleSearch: {} },
									],
								}
							: {}),
					};
					const response = await fetch(connection.url, {
						method: "POST",
						headers: connection.headers,
						body: JSON.stringify(body),
						signal: AbortSignal.timeout(600_000),
					});
					if (!response.ok) {
						return {
							success: false,
							output: "",
							error: `${connection.provider} image API error (${response.status}): ${(await response.text()).slice(0, 500)}`,
						};
					}
					const images = extractImageParts(await response.json());
					if (images.length === 0) {
						return {
							success: false,
							output: "",
							error: `${connection.provider} returned no image data.`,
						};
					}
					const urls: string[] = [];
					let alphaPostProcessed = false;
					for (const image of images) {
						let buffer = Buffer.from(image.data, "base64");
						let mimeType = image.mimeType;
						if (transparencyRequested) {
							const processed = await ensureTransparentImage(
								buffer,
								transparency?.chromaKey as ChromaKey,
							);
							buffer = Buffer.from(processed.buffer);
							mimeType = "image/png";
							alphaPostProcessed ||= processed.alphaPostProcessed;
						}
						const saved = await context.media.save(buffer, mimeType, prompt, {
							provider: connection.provider,
							model: connection.model,
							resolution,
							aspectRatio,
							background: transparencyRequested ? "transparent" : background,
							chromaKey: transparency?.chromaKey.hex,
							alphaPostProcessed,
							referenceImagesUsed: references.length,
						});
						urls.push(saved.url);
					}
					return {
						success: true,
						output: urls
							.map((url, index) => `Image ${index + 1}: ${url}`)
							.join("\n"),
						metadata: {
							urls,
							provider: connection.provider,
							model: connection.model,
							resolution,
							aspectRatio,
							background: transparencyRequested ? "transparent" : background,
							chromaKey: transparency?.chromaKey.hex,
							alphaPostProcessed,
						},
					};
				} catch (error) {
					return {
						success: false,
						output: "",
						error: error instanceof Error ? error.message : String(error),
					};
				}
			},
		},
	];
}
