import type { MediaRoute } from "./catalog.js";

export type VideoGenerationAction =
	| "text_to_video"
	| "image_to_video"
	| "first_last_frame"
	| "reference_images"
	| "extend_video";

export interface VideoGenerationRequest {
	action: VideoGenerationAction;
	prompt?: string;
	imageUrl?: string;
	lastFrameUrl?: string;
	referenceImages?: string[];
	videoUrl?: string;
	resolution?: "720p" | "1080p" | "4k";
	aspectRatio?: "16:9" | "9:16";
	durationSeconds?: number;
	generateAudio?: boolean;
	personGeneration?: "allow_adult" | "dont_allow";
	numberOfVideos?: number;
	negativePrompt?: string;
	seed?: number;
	outputGcsUri?: string;
	routes?: MediaRoute[];
}

export interface ResolvedMediaInput {
	buffer?: Buffer;
	uri?: string;
	mimeType: string;
}

export interface GeneratedMediaOutput {
	buffer?: Buffer;
	uri?: string;
	mimeType: string;
}

export interface VideoOperationPollResult {
	done: boolean;
	progress?: number;
	outputs?: GeneratedMediaOutput[];
	result?: Record<string, unknown>;
}

export interface VideoProviderAdapter {
	readonly provider: MediaRoute["provider"];
	readonly transport: MediaRoute["transport"];
	submit(
		route: MediaRoute,
		request: VideoGenerationRequest,
		signal?: AbortSignal,
	): Promise<{ operationName: string }>;
	poll(
		route: MediaRoute,
		operationName: string,
		request: VideoGenerationRequest,
		signal?: AbortSignal,
	): Promise<VideoOperationPollResult>;
	download(
		output: GeneratedMediaOutput,
		signal?: AbortSignal,
	): Promise<{ buffer: Buffer; mimeType: string }>;
	cancel?(
		route: MediaRoute,
		operationName: string,
		signal?: AbortSignal,
	): Promise<boolean>;
}

export class VideoSubmissionError extends Error {
	constructor(
		message: string,
		readonly safeToFallback: boolean,
	) {
		super(message);
		this.name = "VideoSubmissionError";
	}
}

export interface MediaPersistence {
	save(
		buffer: Buffer,
		mimeType: string,
		description?: string,
		metadata?: Record<string, unknown>,
	): Promise<{
		id: string;
		url: string;
		filename: string;
		size: number;
		mimetype: string;
		metadata?: Record<string, unknown>;
	}>;
	resolve(url: string): Promise<{ buffer: Buffer; mimeType: string }>;
}

export function normalizeVideoGenerationRequest(
	input: Record<string, unknown>,
): VideoGenerationRequest {
	const imageUrl = stringValue(input.imageUrl ?? input.image_url ?? input.firstFrameUrl ?? input.first_frame_url);
	const actionValue = stringValue(input.action);
	if (actionValue && !isVideoAction(actionValue)) {
		throw new Error(`Unsupported video generation action: ${actionValue}`);
	}
	const action: VideoGenerationAction = isVideoAction(actionValue)
		? actionValue
		: imageUrl
			? "image_to_video"
			: "text_to_video";
	const numberOfVideos = numberValue(input.numberOfVideos ?? input.number_of_videos);
	if (
		numberOfVideos !== undefined &&
		(!Number.isInteger(numberOfVideos) || numberOfVideos < 1 || numberOfVideos > 4)
	) {
		throw new Error("numberOfVideos must be an integer from 1 to 4");
	}
	const request: VideoGenerationRequest = {
		action,
		prompt: stringValue(input.prompt),
		imageUrl,
		lastFrameUrl: stringValue(input.lastFrameUrl ?? input.last_frame_url),
		referenceImages: stringArray(input.referenceImages ?? input.reference_images),
		videoUrl: stringValue(input.videoUrl ?? input.video_url),
		resolution: enumValue(input.resolution, ["720p", "1080p", "4k"]),
		aspectRatio: enumValue(input.aspectRatio ?? input.aspect_ratio, ["16:9", "9:16"]),
		durationSeconds: numberValue(input.durationSeconds ?? input.duration_seconds),
		generateAudio: booleanValue(input.generateAudio ?? input.generate_audio),
		personGeneration: enumValue(input.personGeneration ?? input.person_generation, [
			"allow_adult",
			"dont_allow",
		]),
		numberOfVideos,
		negativePrompt: stringValue(input.negativePrompt ?? input.negative_prompt),
		seed: numberValue(input.seed),
		outputGcsUri: stringValue(input.outputGcsUri ?? input.output_gcs_uri),
	};
	return request;
}

function isVideoAction(value: string | undefined): value is VideoGenerationAction {
	return (
		value === "text_to_video" ||
		value === "image_to_video" ||
		value === "first_last_frame" ||
		value === "reference_images" ||
		value === "extend_video"
	);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const result = value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
	return result.length > 0 ? result : undefined;
}

function numberValue(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) ? number : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T | undefined {
	return typeof value === "string" && values.includes(value as T)
		? (value as T)
		: undefined;
}
