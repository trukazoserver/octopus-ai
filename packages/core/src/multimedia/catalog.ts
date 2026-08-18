import type { OctopusConfig } from "../config/schema.js";
import {
	loadVertexCredentials,
	resolveGeminiApiKey,
	resolveVertexProjectId,
} from "./providers/google-auth.js";

export type MediaProvider = "openai" | "gemini" | "vertex";
export type MediaTransport = "openai-images" | "generate-content" | "interactions" | "video-lro";

export interface MediaRoute {
	provider: MediaProvider;
	model: string;
	transport: MediaTransport;
}

export interface MediaCatalogEntry extends MediaRoute {
	label: string;
	mediaType: "image" | "video";
	available: boolean;
	capabilities: string[];
	endpointFamily: "openai" | "gemini-api" | "google-agent-platform";
}

export function getMultimediaCatalog(config: OctopusConfig): { routes: MediaCatalogEntry[] } {
	const openAIEnv = config.ai.providers.openai.apiKeyEnv?.trim();
	const openAITokenEnv = config.ai.providers.openai.accessTokenEnv?.trim();
	const hasOpenAIKey = Boolean(
		config.ai.providers.openai.apiKey?.trim() ||
		(openAIEnv ? process.env[openAIEnv]?.trim() : "") ||
		process.env.OPENAI_API_KEY?.trim(),
	);
	const hasCodexToken = Boolean(
		config.ai.providers.openai.accessToken?.trim() ||
		(openAITokenEnv ? process.env[openAITokenEnv]?.trim() : "") ||
		process.env.CODEX_ACCESS_TOKEN?.trim(),
	);
	const imageAuthMode = config.multimedia?.image.openaiAuthMode ?? "inherit";
	const hasOpenAI =
		imageAuthMode === "codex" ||
		(imageAuthMode === "inherit" &&
			(config.ai.providers.openai.authMode === "codex" ||
				(!hasOpenAIKey && hasCodexToken)))
			? hasCodexToken
			: hasOpenAIKey;
	const hasGemini = Boolean(resolveGeminiApiKey(config.ai.providers.gemini));
	let vertexCredentials: ReturnType<typeof loadVertexCredentials> = null;
	let vertexProjectId: string | undefined;
	try {
		vertexCredentials = loadVertexCredentials(config.ai.providers.vertex);
		vertexProjectId = resolveVertexProjectId(config.ai.providers.vertex);
	} catch {
		vertexCredentials = null;
		vertexProjectId = undefined;
	}
	const vertexTokenEnv = config.ai.providers.vertex.accessTokenEnv?.trim();
	const hasVertexAuth = Boolean(
		config.ai.providers.vertex.accessToken?.trim() ||
		config.ai.providers.vertex.oauthAccessToken?.trim() ||
		(vertexTokenEnv ? process.env[vertexTokenEnv]?.trim() : "") ||
		process.env.GOOGLE_VERTEX_ACCESS_TOKEN?.trim() ||
		(vertexCredentials?.client_email?.trim() &&
			vertexCredentials.private_key?.trim()),
	);
	const hasVertex = Boolean(vertexProjectId && hasVertexAuth);
	return {
		routes: [
			{
				provider: "openai",
				model: "gpt-image-2",
				transport: "openai-images",
				label: "OpenAI Images",
				mediaType: "image",
				available: hasOpenAI,
				capabilities: ["text-to-image", "edit-image", "transparent-background"],
				endpointFamily: "openai",
			},
			{
				provider: "vertex",
				model: "gemini-3.1-flash-image",
				transport: "generate-content",
				label: "Google Agent Platform image",
				mediaType: "image",
				available: hasVertex,
				capabilities: ["text-to-image", "image-to-image"],
				endpointFamily: "google-agent-platform",
			},
			{
				provider: "gemini",
				model: "gemini-3.1-flash-image",
				transport: "generate-content",
				label: "Gemini API image",
				mediaType: "image",
				available: hasGemini,
				capabilities: ["text-to-image", "image-to-image"],
				endpointFamily: "gemini-api",
			},
			...[
				"veo-3.1-generate-001",
				"veo-3.1-fast-generate-001",
				"veo-3.1-lite-generate-001",
			].map((model) => ({
				provider: "vertex" as const,
				model,
				transport: "video-lro" as const,
				label: `Google Agent Platform ${model}`,
				mediaType: "video" as const,
				available: hasVertex,
				capabilities: ["text-to-video", "image-to-video", "first-last-frame", "references", "extend"],
				endpointFamily: "google-agent-platform" as const,
			})),
			{
				provider: "gemini",
				model: "gemini-omni-flash-preview",
				transport: "interactions",
				label: "Gemini Omni Flash Preview",
				mediaType: "video",
				available: hasGemini,
				capabilities: ["text-to-video", "text-output"],
				endpointFamily: "gemini-api",
			},
			...[
				"veo-3.1-generate-preview",
				"veo-3.1-fast-generate-preview",
				"veo-3.1-lite-generate-preview",
				"veo-3.0-generate-001",
				"veo-3.0-fast-generate-001",
				"veo-2.0-generate-001",
			].map((model) => ({
				provider: "gemini" as const,
				model,
				transport: "video-lro" as const,
				label: `Gemini API ${model}`,
				mediaType: "video" as const,
				available: hasGemini,
				capabilities: ["text-to-video", "image-to-video"],
				endpointFamily: "gemini-api" as const,
			})),
		],
	};
}
