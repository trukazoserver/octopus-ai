import type {
	GeneratedMediaOutput,
	MediaPersistence,
	ResolvedMediaInput,
	VideoGenerationRequest,
} from "../types.js";

export async function buildVeoRequestBody(
	request: VideoGenerationRequest,
	media: MediaPersistence,
	mode: "gemini" | "vertex",
): Promise<Record<string, unknown>> {
	validateVideoRequest(request, mode);
	const instance: Record<string, unknown> = { prompt: request.prompt ?? "" };
	if (request.imageUrl) {
		instance.image = imagePayload(await resolveMedia(request.imageUrl, media), mode);
	}
	if (request.lastFrameUrl) {
		instance.lastFrame = imagePayload(
			await resolveMedia(request.lastFrameUrl, media),
			mode,
		);
	}
	if (request.referenceImages?.length) {
		instance.referenceImages = await Promise.all(
			request.referenceImages.map(async (url) => ({
				image: imagePayload(await resolveMedia(url, media), mode),
				referenceType: "asset",
			})),
		);
	}
	if (request.videoUrl) {
		instance.video = videoPayload(await resolveMedia(request.videoUrl, media), mode);
	}

	const parameters: Record<string, unknown> = {
		sampleCount: request.numberOfVideos ?? 1,
		aspectRatio: request.aspectRatio ?? "16:9",
		durationSeconds: request.durationSeconds ?? 8,
		resolution: request.resolution ?? "720p",
		personGeneration: request.personGeneration ?? "allow_adult",
	};
	if (request.negativePrompt) parameters.negativePrompt = request.negativePrompt;
	if (mode === "vertex") {
		parameters.generateAudio = request.generateAudio ?? true;
		if (request.seed !== undefined) parameters.seed = request.seed;
		if (request.outputGcsUri) parameters.storageUri = request.outputGcsUri;
	}
	return { instances: [instance], parameters };
}

export function extractVeoOutputs(
	payload: Record<string, unknown>,
): GeneratedMediaOutput[] {
	const response = recordValue(payload.response) ?? recordValue(payload.result) ?? payload;
	const generation = recordValue(response.generateVideoResponse);
	const candidates = [
		response.videos,
		response.generatedVideos,
		generation?.generatedSamples,
		generation?.generatedVideos,
		payload.generatedVideos,
	];
	for (const candidate of candidates) {
		if (!Array.isArray(candidate) || candidate.length === 0) continue;
		return candidate.flatMap((item) => {
			const itemRecord = recordValue(item);
			if (!itemRecord) return [];
			const video = recordValue(itemRecord.video) ?? itemRecord;
			const bytes = stringValue(
				video.bytesBase64Encoded ??
					video.bytesBase64 ??
					video.videoBytes ??
					video.encodedVideo ??
					itemRecord.bytesBase64Encoded,
			);
			const uri = stringValue(
				video.uri ?? video.gcsUri ?? itemRecord.uri ?? itemRecord.gcsUri,
			);
			if (!bytes && !uri) return [];
			return [
				{
					buffer: bytes ? Buffer.from(bytes, "base64") : undefined,
					uri,
					mimeType: stringValue(video.mimeType ?? itemRecord.mimeType) ?? "video/mp4",
				},
			];
		});
	}
	return [];
}

export function googleStorageDownloadUrl(uri: string): string {
	const value = uri.replace(/^gs:\/\//, "");
	const slash = value.indexOf("/");
	if (slash < 1) throw new Error(`Invalid Google Cloud Storage URI: ${uri}`);
	const bucket = value.slice(0, slash);
	const object = value.slice(slash + 1);
	return `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`;
}

export function assertGoogleMediaDownloadUrl(rawUrl: string): {
	url: URL;
	credentialMode: "public" | "gemini-key" | "vertex-oauth";
} {
	const url = new URL(rawUrl);
	if (url.protocol !== "https:") {
		throw new Error("Google media download URL must use HTTPS");
	}
	if (url.username || url.password) {
		throw new Error("Google media download URL must not contain credentials");
	}
	const host = url.hostname.toLowerCase();
	if (host.endsWith(".googleusercontent.com")) {
		return { url, credentialMode: "public" };
	}
	const storagePath = /^\/(?:storage\/v1|download\/storage\/v1)\/b\//.test(
		url.pathname,
	);
	const generativePath = /^\/v1(?:beta)?\/files\//.test(url.pathname);
	const vertexPath = /^\/v1\/projects\//.test(url.pathname);
	if (host === "generativelanguage.googleapis.com" && generativePath) {
		return { url, credentialMode: "gemini-key" };
	}
	if (
		(host === "storage.googleapis.com" && storagePath) ||
		(/^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/.test(host) && vertexPath)
	) {
		return { url, credentialMode: "vertex-oauth" };
	}
	throw new Error(
		`Untrusted Google media download target: ${url.origin}${url.pathname}`,
	);
}

function validateVideoRequest(
	request: VideoGenerationRequest,
	mode: "gemini" | "vertex",
): void {
	if (
		request.numberOfVideos !== undefined &&
		(!Number.isInteger(request.numberOfVideos) ||
			request.numberOfVideos < 1 ||
			request.numberOfVideos > 4)
	) {
		throw new Error("numberOfVideos must be an integer from 1 to 4");
	}
	if (!request.prompt && request.action !== "extend_video") {
		throw new Error("prompt is required for video generation");
	}
	if (request.action === "image_to_video" && !request.imageUrl) {
		throw new Error("imageUrl is required for image_to_video");
	}
	if (
		request.action === "first_last_frame" &&
		(!request.imageUrl || !request.lastFrameUrl)
	) {
		throw new Error(
			"imageUrl and lastFrameUrl are required for first_last_frame",
		);
	}
	if (
		request.action === "reference_images" &&
		(!request.referenceImages || request.referenceImages.length === 0)
	) {
		throw new Error("referenceImages are required for reference_images");
	}
	if (request.referenceImages && request.referenceImages.length > 3) {
		throw new Error("Veo accepts at most 3 reference images");
	}
	const duration = request.durationSeconds ?? 8;
	if (request.action === "extend_video") {
		if (!request.videoUrl) throw new Error("videoUrl is required for video extension");
		if (duration !== 7) throw new Error("Video extension requires durationSeconds=7");
	} else if (![4, 6, 8].includes(duration)) {
		throw new Error("durationSeconds must be 4, 6, or 8");
	}
	if (request.referenceImages?.length && duration !== 8) {
		throw new Error("Reference-image generation requires durationSeconds=8");
	}
	if (mode === "gemini" && request.outputGcsUri) {
		throw new Error("outputGcsUri is only supported by Google Agent Platform");
	}
	if (mode === "gemini" && request.generateAudio === true) {
		throw new Error("generateAudio is not supported by the Gemini Developer API Veo route");
	}
	if (mode === "gemini" && request.seed !== undefined) {
		throw new Error("seed is not supported by the Gemini Developer API Veo route");
	}
}

async function resolveMedia(
	value: string,
	media: MediaPersistence,
): Promise<ResolvedMediaInput> {
	if (value.startsWith("gs://") || /^https?:\/\//i.test(value)) {
		return {
			uri: value,
			mimeType: inferMime(value),
		};
	}
	const resolved = await media.resolve(value);
	return { buffer: resolved.buffer, mimeType: resolved.mimeType };
}

function imagePayload(
	input: ResolvedMediaInput,
	mode: "gemini" | "vertex",
): Record<string, unknown> {
	if (input.buffer) {
		return {
			bytesBase64Encoded: input.buffer.toString("base64"),
			mimeType: input.mimeType,
		};
	}
	if (mode === "gemini") {
		throw new Error("Gemini Developer API image inputs must resolve to local bytes");
	}
	return { gcsUri: input.uri, mimeType: input.mimeType };
}

function videoPayload(
	input: ResolvedMediaInput,
	mode: "gemini" | "vertex",
): Record<string, unknown> {
	if (input.buffer) {
		return mode === "gemini"
			? { encodedVideo: input.buffer.toString("base64"), encoding: input.mimeType }
			: {
					bytesBase64Encoded: input.buffer.toString("base64"),
					mimeType: input.mimeType,
				};
	}
	return mode === "gemini"
		? { uri: input.uri, encoding: input.mimeType }
		: { gcsUri: input.uri, mimeType: input.mimeType };
}

function inferMime(value: string): string {
	const clean = value.split(/[?#]/)[0]?.toLowerCase() ?? "";
	if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
	if (clean.endsWith(".webp")) return "image/webp";
	if (clean.endsWith(".mp4")) return "video/mp4";
	if (clean.endsWith(".webm")) return "video/webm";
	return "image/png";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
