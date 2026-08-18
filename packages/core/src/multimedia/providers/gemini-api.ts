import type { OctopusConfig } from "../../config/schema.js";
import type { MediaRoute } from "../catalog.js";
import { VideoSubmissionError } from "../types.js";
import type {
	GeneratedMediaOutput,
	MediaPersistence,
	VideoGenerationRequest,
	VideoOperationPollResult,
	VideoProviderAdapter,
} from "../types.js";
import { resolveGeminiApiKey } from "./google-auth.js";
import {
	assertGoogleMediaDownloadUrl,
	buildVeoRequestBody,
	extractVeoOutputs,
} from "./veo-shared.js";

type GeminiConfig = OctopusConfig["ai"]["providers"]["gemini"];

export class GeminiApiVideoAdapter implements VideoProviderAdapter {
	readonly provider = "gemini" as const;
	readonly transport = "video-lro" as const;

	constructor(
		private config: GeminiConfig,
		private readonly media: MediaPersistence,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	updateConfig(config: GeminiConfig): void {
		this.config = config;
	}

	async submit(
		route: MediaRoute,
		request: VideoGenerationRequest,
		signal?: AbortSignal,
	): Promise<{ operationName: string }> {
		this.assertRoute(route);
		const endpoint = `${this.baseUrl()}/v1beta/models/${encodeURIComponent(route.model)}:predictLongRunning?key=${encodeURIComponent(this.apiKey())}`;
		const response = await this.fetchImpl(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json; charset=utf-8" },
			body: JSON.stringify(await buildVeoRequestBody(request, this.media, "gemini")),
			signal,
		});
		const payload = await readSubmissionResponse(response, route.model);
		const operationName = stringValue(payload.name);
		if (!operationName) {
			throw new VideoSubmissionError(
				`${route.model} returned success without an operation name; acceptance is ambiguous`,
				false,
			);
		}
		return { operationName };
	}

	async poll(
		route: MediaRoute,
		operationName: string,
		_request: VideoGenerationRequest,
		signal?: AbortSignal,
	): Promise<VideoOperationPollResult> {
		this.assertRoute(route);
		assertOperationName(operationName);
		const endpoint = `${this.baseUrl()}/v1beta/${operationName}?key=${encodeURIComponent(this.apiKey())}`;
		const response = await this.fetchImpl(endpoint, { signal });
		const payload = await readJsonResponse(response, route.model, "poll");
		if (payload.error) {
			throw new Error(`${route.model} operation failed: ${JSON.stringify(payload.error)}`);
		}
		if (payload.done !== true) return { done: false };
		const outputs = extractVeoOutputs(payload);
		if (outputs.length === 0) {
			throw new Error(`${route.model} completed without generated videos`);
		}
		return { done: true, progress: 1, outputs, result: payload };
	}

	async download(
		output: GeneratedMediaOutput,
		signal?: AbortSignal,
	): Promise<{ buffer: Buffer; mimeType: string }> {
		if (output.buffer) return { buffer: output.buffer, mimeType: output.mimeType };
		if (!output.uri) throw new Error("Generated video has no bytes or URI");
		const target = assertGoogleMediaDownloadUrl(output.uri);
		if (target.credentialMode === "vertex-oauth") {
			throw new Error("Gemini API cannot send an API key to a Vertex or GCS media endpoint");
		}
		if (
			target.credentialMode === "gemini-key" &&
			!target.url.searchParams.has("key")
		) {
			target.url.searchParams.set("key", this.apiKey());
		}
		const response = await this.fetchImpl(target.url, {
			signal,
			redirect: "error",
		});
		if (!response.ok) {
			throw new Error(`Video download failed: ${response.status} ${await response.text()}`);
		}
		return {
			buffer: Buffer.from(await response.arrayBuffer()),
			mimeType: response.headers.get("content-type") || output.mimeType,
		};
	}

	private assertRoute(route: MediaRoute): void {
		if (route.provider !== this.provider || route.transport !== this.transport) {
			throw new Error(`Unsupported Gemini API route: ${route.provider}/${route.transport}`);
		}
		if (!/^veo-[a-z0-9.-]+$/i.test(route.model)) {
			throw new Error(`Gemini API video-lro requires a Veo model, received ${route.model}`);
		}
	}

	private apiKey(): string {
		const key = resolveGeminiApiKey(this.config);
		if (!key) throw new Error("Gemini API key is required for video generation");
		return key;
	}

	private baseUrl(): string {
		return (this.config.baseUrl?.trim() || "https://generativelanguage.googleapis.com")
			.replace(/\/+$/, "")
			.replace(/\/v1beta$/, "");
	}
}

async function readJsonResponse(
	response: Response,
	model: string,
	action: string,
): Promise<Record<string, unknown>> {
	if (!response.ok) {
		throw new Error(
			`${model} ${action} failed: ${response.status} ${(await response.text()).slice(0, 1000)}`,
		);
	}
	return (await response.json()) as Record<string, unknown>;
}

async function readSubmissionResponse(
	response: Response,
	model: string,
): Promise<Record<string, unknown>> {
	if (!response.ok) {
		const message = `${model} submit failed: ${response.status} ${(await response.text()).slice(0, 1000)}`;
		throw new VideoSubmissionError(
			message,
			response.status < 500 && response.status !== 408,
		);
	}
	try {
		return (await response.json()) as Record<string, unknown>;
	} catch {
		throw new VideoSubmissionError(
			`${model} returned an unreadable submit response; acceptance is ambiguous`,
			false,
		);
	}
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function assertOperationName(value: string): void {
	if (!value || value.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(value)) {
		throw new Error("Invalid Google operation name");
	}
}
