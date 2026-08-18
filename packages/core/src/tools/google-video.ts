import type { MediaGenerationManager } from "../multimedia/manager.js";
import { normalizeVideoGenerationRequest } from "../multimedia/types.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./registry.js";

const VIDEO_PARAMETERS: ToolDefinition["parameters"] = {
	action: {
		type: "string",
		description:
			"Generation mode: text_to_video, image_to_video, first_last_frame, reference_images, or extend_video.",
		required: true,
		schema: {
			enum: [
				"text_to_video",
				"image_to_video",
				"first_last_frame",
				"reference_images",
				"extend_video",
			],
		},
	},
	prompt: {
		type: "string",
		description: "Detailed prompt describing the requested video.",
	},
	image_url: {
		type: "string",
		description: "Media URL or GCS URI for the initial frame.",
	},
	last_frame_url: {
		type: "string",
		description: "Media URL or GCS URI for the final interpolation frame.",
	},
	reference_images: {
		type: "array",
		description: "Up to three Media URLs or GCS URIs used as asset references.",
		schema: { items: { type: "string" }, maxItems: 3 },
	},
	video_url: {
		type: "string",
		description: "Media URL or GCS URI of a video to extend.",
	},
	resolution: {
		type: "string",
		description: "Output resolution.",
		schema: { enum: ["720p", "1080p", "4k"] },
	},
	aspect_ratio: {
		type: "string",
		description: "Output aspect ratio.",
		schema: { enum: ["16:9", "9:16"] },
	},
	duration_seconds: {
		type: "number",
		description: "Video duration. Veo generation supports 4, 6, or 8 seconds; extension uses 7.",
	},
	generate_audio: {
		type: "boolean",
		description: "Generate synchronized audio when the selected route supports it.",
	},
	person_generation: {
		type: "string",
		description: "Person generation policy.",
		schema: { enum: ["allow_adult", "dont_allow"] },
	},
	number_of_videos: {
		type: "number",
		description: "Number of videos to generate, from 1 to 4.",
	},
	negative_prompt: {
		type: "string",
		description: "Optional negative prompt.",
	},
	seed: {
		type: "number",
		description: "Optional seed for routes that support reproducibility.",
	},
	output_gcs_uri: {
		type: "string",
		description: "Optional Google Cloud Storage output prefix for Agent Platform routes.",
	},
};

export function createVideoGenerationTools(
	manager: MediaGenerationManager,
): ToolDefinition[] {
	const handler = async (
		params: Record<string, unknown>,
		context: ToolContext,
	): Promise<ToolResult> => {
		try {
			const request = normalizeVideoGenerationRequest(params);
			const job = await manager.createVideoJob(request, {
				idempotencyKey: context.agent?.idempotencyKey,
				toolName: "generate_video",
				agentId: context.agent?.agentId,
				channelId: context.agent?.channelId,
				conversationId:
					context.agent?.conversationId ?? context.agent?.channelId,
				runId: context.agent?.runId,
				workerId: context.agent?.workerId,
				taskId: context.agent?.taskId,
			});
			const completed = await manager.waitForJob(job.id, {
				signal: context.agent?.abortSignal,
				onProgress: context.onProgress,
			});
			if (completed.status === "failed") {
				return {
					success: false,
					output: "",
					error: completed.error ?? `Video job ${completed.id} failed`,
					metadata: { jobId: completed.id, status: completed.status },
				};
			}
			if (completed.status === "cancelled") {
				return {
					success: false,
					output: "",
					error: `Video job ${completed.id} was cancelled`,
					metadata: { jobId: completed.id, status: completed.status },
				};
			}
			if (completed.status !== "succeeded") {
				return {
					success: true,
					output: `Video job ${completed.id} continues in the background with status ${completed.status}. Retrieve it from Ajustes > Multimedia or GET /api/multimedia/jobs/${completed.id}.`,
					metadata: { jobId: completed.id, status: completed.status },
				};
			}
			const listing = completed.mediaUrls
				.map((url, index) => `${index + 1}. ${url}`)
				.join("\n");
			return {
				success: true,
				output: `Video job ${completed.id} completed with ${completed.mediaUrls.length} video(s).\n${listing}\n\nUse each /api/media/file/ URL above verbatim in your reply as markdown. Do not prepend a host or invent a replacement URL.`,
				metadata: {
					jobId: completed.id,
					status: completed.status,
					provider: completed.provider,
					model: completed.model,
					mediaUrls: completed.mediaUrls,
				},
			};
		} catch (error) {
			return {
				success: false,
				output: "",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	};

	return [
		{
			name: "generate_video",
			description:
				"Generate a real video through the configured Gemini API or Google Agent Platform route. The durable job survives client disconnects and process restarts, and successful output is saved to the Octopus Media library.",
			longRunning: true,
			parameters: VIDEO_PARAMETERS,
			handler,
		},
		{
			name: "veo-video-generator",
			description: "Compatibility alias for generate_video.",
			longRunning: true,
			metadata: { hiddenFromModel: true, compatibilityAliasFor: "generate_video" },
			parameters: VIDEO_PARAMETERS,
			handler,
		},
	];
}
