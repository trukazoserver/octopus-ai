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
import {
	resolveVertexAccessToken,
	resolveVertexProjectId,
} from "./google-auth.js";
import {
	assertGoogleMediaDownloadUrl,
	buildVeoRequestBody,
	extractVeoOutputs,
	googleStorageDownloadUrl,
} from "./veo-shared.js";

type VertexConfig = OctopusConfig["ai"]["providers"]["vertex"];

export class AgentPlatformVideoAdapter implements VideoProviderAdapter {
	readonly provider = "vertex" as const;
	readonly transport = "video-lro" as const;
	private tokenCache?: { value: string; expiresAt: number };

	constructor(
		private config: VertexConfig,
		private readonly media: MediaPersistence,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	updateConfig(config: VertexConfig): void {
		this.config = config;
		this.tokenCache = undefined;
	}

	async submit(
		route: MediaRoute,
		request: VideoGenerationRequest,
		signal?: AbortSignal,
	): Promise<{ operationName: string }> {
		this.assertRoute(route);
		const projectId = this.projectId();
		const location = this.location();
		const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(route.model)}:predictLongRunning`;
		const response = await this.fetchImpl(endpoint, {
			method: "POST",
			headers: await this.headers(),
			body: JSON.stringify(await buildVeoRequestBody(request, this.media, "vertex")),
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
		const projectId = this.projectId();
		const location = this.location();
		const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(route.model)}:fetchPredictOperation`;
		const response = await this.fetchImpl(endpoint, {
			method: "POST",
			headers: await this.headers(),
			body: JSON.stringify({ operationName }),
			signal,
		});
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
		const rawUrl = output.uri.startsWith("gs://")
			? googleStorageDownloadUrl(output.uri)
			: output.uri;
		const target = assertGoogleMediaDownloadUrl(rawUrl);
		if (target.credentialMode === "gemini-key") {
			throw new Error("Agent Platform cannot send Vertex credentials to a Gemini media endpoint");
		}
		const headers = target.credentialMode === "vertex-oauth"
			? { Authorization: `Bearer ${await this.accessToken()}` }
			: undefined;
		const response = await this.fetchImpl(target.url, {
			headers,
			redirect: "error",
			signal,
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
			throw new Error(`Unsupported Agent Platform route: ${route.provider}/${route.transport}`);
		}
		if (!/^veo-[a-z0-9.-]+$/i.test(route.model)) {
			throw new Error(`Agent Platform video-lro requires a Veo model, received ${route.model}`);
		}
	}

	private projectId(): string {
		const projectId = resolveVertexProjectId(this.config);
		if (!projectId) throw new Error("Google Agent Platform projectId is required");
		return projectId;
	}

	private location(): string {
		const configured = this.config.location?.trim();
		return configured && configured !== "global"
			? configured
			: process.env.VEO_CLOUD_LOCATION?.trim() || "us-central1";
	}

	private async accessToken(): Promise<string> {
		if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) {
			return this.tokenCache.value;
		}
		const value = await resolveVertexAccessToken(this.config, this.fetchImpl);
		this.tokenCache = { value, expiresAt: Date.now() + 50 * 60_000 };
		return value;
	}

	private async headers(): Promise<Record<string, string>> {
		return {
			Authorization: `Bearer ${await this.accessToken()}`,
			"Content-Type": "application/json; charset=utf-8",
		};
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
