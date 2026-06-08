import { readFileSync, statSync } from "node:fs";
import type { LLMRouter } from "../ai/router.js";
import type { LLMRouterConfig } from "../ai/types.js";
import type {
	ExtractedKnowledgeChunk,
	KnowledgeFileExtractionInput,
	KnowledgeFileExtractor,
} from "./knowledge-manager.js";

const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

export interface GoogleKnowledgeExtractorOptions {
	model?: string;
	maxBytes?: number;
}

export interface OpenAIKnowledgeExtractorOptions {
	model?: string;
	maxBytes?: number;
}

export function createGoogleKnowledgeExtractor(
	router: LLMRouter,
	aiConfig: LLMRouterConfig,
	options: GoogleKnowledgeExtractorOptions = {},
): KnowledgeFileExtractor {
	const model = options.model ?? selectGoogleVisionModel(aiConfig);
	return createImageKnowledgeExtractor(router, {
		model,
		maxBytes: options.maxBytes,
		generatedFrom: "google_vertex_image_extraction",
	});
}

export function createOpenAIKnowledgeExtractor(
	router: LLMRouter,
	aiConfig: LLMRouterConfig,
	options: OpenAIKnowledgeExtractorOptions = {},
): KnowledgeFileExtractor {
	const model = options.model ?? selectOpenAIVisionModel(aiConfig);
	return createImageKnowledgeExtractor(router, {
		model,
		maxBytes: options.maxBytes,
		generatedFrom: "openai_image_extraction",
	});
}

export function createConfiguredKnowledgeExtractor(
	router: LLMRouter,
	aiConfig: LLMRouterConfig,
): KnowledgeFileExtractor {
	const candidates = selectExtractorCandidates(aiConfig).map((provider) =>
		provider === "openai"
			? createOpenAIKnowledgeExtractor(router, aiConfig)
			: createGoogleKnowledgeExtractor(router, aiConfig),
	);

	return async (input) => {
		for (const candidate of candidates) {
			try {
				const chunks = await candidate(input);
				if (chunks.length > 0) return chunks;
			} catch {
				/* Try the next configured extractor. */
			}
		}
		return [];
	};
}

function createImageKnowledgeExtractor(
	router: LLMRouter,
	options: { model: string; maxBytes?: number; generatedFrom: string },
): KnowledgeFileExtractor {
	const model = options.model;
	const maxBytes = options.maxBytes ?? MAX_INLINE_IMAGE_BYTES;

	return async (
		input: KnowledgeFileExtractionInput,
	): Promise<ExtractedKnowledgeChunk[]> => {
		if (input.modality !== "image") return [];
		if (!input.mimeType.startsWith("image/")) return [];
		const stat = statSync(input.filePath);
		if (stat.size > maxBytes) return [];

		const data = readFileSync(input.filePath).toString("base64");
		const response = await router.chat({
			model,
			messages: [
				{
					role: "system",
					content: [
						"Extrae conocimiento verificable de imagenes para una base de conocimiento multimodal.",
						"Incluye texto visible/OCR, objetos relevantes, layout/estructura, relaciones espaciales y cualquier detalle util para recuperacion semantica.",
						"No inventes texto que no sea visible. Si no hay texto, dilo explicitamente.",
						"Responde en español, compacto, en bullets claros.",
					].join("\n"),
				},
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "Analiza esta imagen para indexarla en Knowledge Base.",
						},
						{
							type: "image_url",
							image_url: {
								url: `data:${input.mimeType};base64,${data}`,
							},
						},
					],
				},
			],
			maxTokens: 1200,
			temperature: 0.1,
		});

		const content = response.content.trim();
		if (!content) return [];
		return [
			{
				content,
				modality: "image",
				metadata: {
					generatedFrom: options.generatedFrom,
					model,
					mimeType: input.mimeType,
					fileSize: stat.size,
				},
			},
		];
	};
}

function selectOpenAIVisionModel(aiConfig: LLMRouterConfig): string {
	const models = aiConfig.providers.openai?.models ?? [];
	const configured =
		models.find((model) => /gpt-4o|gpt-4\.1|vision/i.test(model)) ??
		models[0];
	if (!configured) return "openai/gpt-4o-mini";
	return configured.startsWith("openai/") ? configured : `openai/${configured}`;
}

function selectGoogleVisionModel(aiConfig: LLMRouterConfig): string {
	const configured = aiConfig.providers.google?.models?.[0];
	if (!configured) return "google/gemini-2.5-flash";
	return configured.startsWith("google/") ? configured : `google/${configured}`;
}

function selectExtractorCandidates(aiConfig: LLMRouterConfig): Array<"openai" | "google"> {
	const preferred = [
		providerFromModel(aiConfig.default),
		providerFromModel(aiConfig.fallback),
	].filter(
		(provider): provider is "openai" | "google" =>
			provider === "openai" || provider === "google",
	);
	const configured = [
		hasOpenAICredentials(aiConfig) ? "openai" : null,
		hasGoogleCredentials(aiConfig) ? "google" : null,
	].filter((provider): provider is "openai" | "google" => Boolean(provider));
	return [...new Set([...preferred, ...configured, "openai", "google"])] as Array<
		"openai" | "google"
	>;
}

function providerFromModel(model?: string): "openai" | "google" | null {
	if (!model) return null;
	if (model.startsWith("openai/")) return "openai";
	if (model.startsWith("google/")) return "google";
	return null;
}

function hasOpenAICredentials(aiConfig: LLMRouterConfig): boolean {
	const openai = aiConfig.providers.openai;
	return Boolean(
		openai?.apiKey ||
			readConfiguredEnv(openai?.apiKeyEnv) ||
			openai?.accessToken ||
			readConfiguredEnv(openai?.accessTokenEnv) ||
			openai?.oauthAccessToken ||
			process.env.OPENAI_API_KEY ||
			process.env.CODEX_API_KEY,
	);
}

function hasGoogleCredentials(aiConfig: LLMRouterConfig): boolean {
	const google = aiConfig.providers.google;
	return Boolean(
		google?.apiKey ||
			readConfiguredEnv(google?.apiKeyEnv) ||
			google?.accessToken ||
			readConfiguredEnv(google?.accessTokenEnv) ||
			google?.credentialsJson ||
			google?.credentialsFile ||
			google?.oauthAccessToken ||
			process.env.GEMINI_API_KEY ||
			process.env.GOOGLE_API_KEY ||
			process.env.GOOGLE_VERTEX_ACCESS_TOKEN ||
			process.env.GOOGLE_APPLICATION_CREDENTIALS,
	);
}

function readConfiguredEnv(name?: string): string {
	return name ? process.env[name]?.trim() || "" : "";
}
