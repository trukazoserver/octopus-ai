import { GoogleGenAI } from "@google/genai";
import type { OctopusConfig } from "../../config/schema.js";
import type { MediaRoute } from "../catalog.js";
import { VideoSubmissionError } from "../types.js";
import type {
	GeneratedMediaOutput,
	VideoGenerationRequest,
	VideoOperationPollResult,
	VideoProviderAdapter,
} from "../types.js";
import {
	loadVertexCredentials,
	resolveGeminiApiKey,
	resolveVertexAccessToken,
	resolveVertexProjectId,
} from "./google-auth.js";
import {
	assertGoogleMediaDownloadUrl,
	googleStorageDownloadUrl,
} from "./veo-shared.js";

interface InteractionSnapshot {
	id: string;
	status: "in_progress" | "requires_action" | "completed" | "failed" | "cancelled" | "incomplete";
	steps?: Array<Record<string, unknown>>;
}

interface InteractionsClient {
	create(input: Record<string, unknown>): Promise<InteractionSnapshot>;
	get(id: string): Promise<InteractionSnapshot>;
	cancel(id: string): Promise<InteractionSnapshot>;
}

type ClientFactory = (provider: "gemini" | "vertex") => InteractionsClient;

export class InteractionsVideoAdapter implements VideoProviderAdapter {
	readonly transport = "interactions" as const;
	private clients = new Map<"gemini" | "vertex", InteractionsClient>();

	constructor(
		readonly provider: "gemini" | "vertex",
		private config: OctopusConfig,
		private readonly fetchImpl: typeof fetch = fetch,
		private readonly clientFactory?: ClientFactory,
	) {}

	updateConfig(config: OctopusConfig): void {
		this.config = config;
		this.clients.clear();
	}

	async submit(
		route: MediaRoute,
		request: VideoGenerationRequest,
		signal?: AbortSignal,
	): Promise<{ operationName: string }> {
		this.assertRoute(route);
		if (request.action !== "text_to_video") {
			throw new Error(
				`${route.model} Interactions currently supports text_to_video only`,
			);
		}
		if ((request.numberOfVideos ?? 1) !== 1) {
			throw new Error(
				`${route.model} Interactions does not support multiple video samples`,
			);
		}
		if (!request.prompt) throw new Error("prompt is required for Omni video generation");
		let interaction: InteractionSnapshot;
		try {
			interaction = await withAbortDeadline(this.client().create({
				model: route.model,
				input: request.prompt,
				background: true,
				store: true,
				response_modalities: ["video"],
				response_format: {
					type: "video",
					aspectRatio: request.aspectRatio ?? "16:9",
					duration: `${request.durationSeconds ?? 8}s`,
					delivery: request.outputGcsUri ? "uri" : "inline",
					...(request.outputGcsUri ? { gcsUri: request.outputGcsUri } : {}),
				},
			}), signal, 600_000, "Interactions submit");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const status = Number(message.match(/\b([45]\d\d)\b/)?.[1]);
			throw new VideoSubmissionError(
				message,
				Number.isFinite(status) && status < 500 && status !== 408,
			);
		}
		if (!interaction.id) {
			throw new VideoSubmissionError(
				`${route.model} returned success without an interaction id; acceptance is ambiguous`,
				false,
			);
		}
		return { operationName: interaction.id };
	}

	async poll(
		route: MediaRoute,
		operationName: string,
		_request: VideoGenerationRequest,
		signal?: AbortSignal,
	): Promise<VideoOperationPollResult> {
		this.assertRoute(route);
		assertInteractionId(operationName);
		const interaction = await withAbortDeadline(
			this.client().get(operationName),
			signal,
			60_000,
			"Interactions poll",
		);
		if (interaction.status === "failed" || interaction.status === "incomplete") {
			throw new Error(`${route.model} interaction ${interaction.status}`);
		}
		if (interaction.status === "cancelled") {
			throw new Error(`${route.model} interaction was cancelled`);
		}
		if (interaction.status !== "completed") return { done: false };
		const outputs = extractInteractionVideos(interaction.steps ?? []);
		if (outputs.length === 0) {
			throw new Error(`${route.model} completed without generated video content`);
		}
		return {
			done: true,
			progress: 1,
			outputs,
			result: interaction as unknown as Record<string, unknown>,
		};
	}

	async download(
		output: GeneratedMediaOutput,
		signal?: AbortSignal,
	): Promise<{ buffer: Buffer; mimeType: string }> {
		if (output.buffer) return { buffer: output.buffer, mimeType: output.mimeType };
		if (!output.uri) throw new Error("Generated interaction video has no data or URI");
		const rawUrl = output.uri.startsWith("gs://")
			? googleStorageDownloadUrl(output.uri)
			: output.uri;
		const target = assertGoogleMediaDownloadUrl(rawUrl);
		const headers: Record<string, string> = {};
		if (this.provider === "gemini") {
			const parsed = target.url;
			if (target.credentialMode === "vertex-oauth") {
				throw new Error("Gemini Interactions cannot send an API key to a Vertex or GCS media endpoint");
			}
			if (
				target.credentialMode === "gemini-key" &&
				!parsed.searchParams.has("key")
			) {
				parsed.searchParams.set("key", resolveGeminiApiKey(this.config.ai.providers.gemini));
			}
			const response = await this.fetchImpl(parsed, {
				signal,
				redirect: "error",
			});
			return readVideoResponse(response, output.mimeType);
		}
		if (target.credentialMode === "gemini-key") {
			throw new Error("Vertex Interactions cannot send OAuth credentials to a Gemini media endpoint");
		}
		if (target.credentialMode === "vertex-oauth") {
			headers.Authorization = `Bearer ${await resolveVertexAccessToken(
				this.config.ai.providers.vertex,
				this.fetchImpl,
			)}`;
		}
		const response = await this.fetchImpl(target.url, {
			headers,
			signal,
			redirect: "error",
		});
		return readVideoResponse(response, output.mimeType);
	}

	async cancel(
		route: MediaRoute,
		operationName: string,
		signal?: AbortSignal,
	): Promise<boolean> {
		this.assertRoute(route);
		assertInteractionId(operationName);
		const result = await withAbortDeadline(
			this.client().cancel(operationName),
			signal,
			30_000,
			"Interactions cancel",
		);
		return result.status === "cancelled";
	}

	private client(): InteractionsClient {
		const existing = this.clients.get(this.provider);
		if (existing) return existing;
		const client = this.clientFactory
			? this.clientFactory(this.provider)
			: this.createDefaultClient();
		this.clients.set(this.provider, client);
		return client;
	}

	private createDefaultClient(): InteractionsClient {
		const ai =
			this.provider === "gemini"
				? new GoogleGenAI({ apiKey: requiredGeminiKey(this.config) })
				: new GoogleGenAI({
						enterprise: true,
						project: requiredVertexProject(this.config),
						location: "global",
						googleAuthOptions: vertexGoogleAuthOptions(this.config),
					});
		return {
			create: (input) => ai.interactions.create(input as never) as unknown as Promise<InteractionSnapshot>,
			get: (id) => ai.interactions.get(id) as unknown as Promise<InteractionSnapshot>,
			cancel: (id) => ai.interactions.cancel(id) as unknown as Promise<InteractionSnapshot>,
		};
	}

	private assertRoute(route: MediaRoute): void {
		if (route.provider !== this.provider || route.transport !== this.transport) {
			throw new Error(`Unsupported Interactions route: ${route.provider}/${route.transport}`);
		}
	}
}

function extractInteractionVideos(
	steps: Array<Record<string, unknown>>,
): GeneratedMediaOutput[] {
	const outputs: GeneratedMediaOutput[] = [];
	for (const step of steps) {
		if (step.type !== "model_output" || !Array.isArray(step.content)) continue;
		for (const content of step.content) {
			if (!content || typeof content !== "object") continue;
			const value = content as Record<string, unknown>;
			if (value.type !== "video") continue;
			const data = typeof value.data === "string" ? value.data : undefined;
			const uri = typeof value.uri === "string" ? value.uri : undefined;
			if (!data && !uri) continue;
			outputs.push({
				buffer: data ? Buffer.from(data, "base64") : undefined,
				uri,
				mimeType: typeof value.mime_type === "string" ? value.mime_type : "video/mp4",
			});
		}
	}
	return outputs;
}

function requiredGeminiKey(config: OctopusConfig): string {
	const key = resolveGeminiApiKey(config.ai.providers.gemini);
	if (!key) throw new Error("Gemini API key is required for Omni video generation");
	return key;
}

function requiredVertexProject(config: OctopusConfig): string {
	const project = resolveVertexProjectId(config.ai.providers.vertex);
	if (!project) throw new Error("Google Agent Platform projectId is required for Omni video generation");
	return project;
}

function vertexGoogleAuthOptions(config: OctopusConfig): Record<string, unknown> | undefined {
	const credentials = loadVertexCredentials(config.ai.providers.vertex);
	if (credentials) return { credentials };
	const accessToken = config.ai.providers.vertex.accessToken?.trim();
	return accessToken ? { credentials: { access_token: accessToken } } : undefined;
}

async function readVideoResponse(
	response: Response,
	fallbackMime: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
	if (!response.ok) {
		throw new Error(`Video download failed: ${response.status} ${await response.text()}`);
	}
	return {
		buffer: Buffer.from(await response.arrayBuffer()),
		mimeType: response.headers.get("content-type") || fallbackMime,
	};
}

function assertInteractionId(value: string): void {
	if (!value || value.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(value)) {
		throw new Error("Invalid interaction id");
	}
}

async function withAbortDeadline<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	label: string,
): Promise<T> {
	if (signal?.aborted) throw signal.reason ?? new Error(`${label} aborted`);
	let timeout: NodeJS.Timeout | undefined;
	let abortHandler: (() => void) | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
		if (signal) {
			abortHandler = () => reject(signal.reason ?? new Error(`${label} aborted`));
			signal.addEventListener("abort", abortHandler, { once: true });
		}
	});
	try {
		return await Promise.race([promise, deadline]);
	} finally {
		if (timeout) clearTimeout(timeout);
		if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
	}
}
