import { randomUUID } from "node:crypto";
import type {
	MediaUsageEvent,
	MediaUsageSink,
} from "../ai/usage-store.js";
import type { OctopusConfig } from "../config/schema.js";
import {
	getMultimediaCatalog,
	type MediaRoute,
} from "../multimedia/catalog.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./registry.js";

interface ImageGenerationImplementations {
	openaiGenerate: ToolDefinition;
	openaiEdit: ToolDefinition;
	google: ToolDefinition;
}

const IMAGE_PARAMETERS: ToolDefinition["parameters"] = {
	action: {
		type: "string",
		description:
			"generate or edit. Edit is inferred automatically when reference_images are provided.",
		schema: { enum: ["generate", "edit"] },
	},
	prompt: {
		type: "string",
		description: "Detailed description of the image or requested edit.",
		required: true,
	},
	reference_images: {
		type: "array",
		description:
			"Optional Octopus Media URLs, HTTP URLs, or workspace paths used for editing or composition.",
		schema: { items: { type: "string" }, maxItems: 14 },
	},
	aspect_ratio: {
		type: "string",
		description: "Desired aspect ratio, such as 1:1, 3:2, 2:3, 16:9, or 9:16.",
	},
	resolution: {
		type: "string",
		description: "Google image resolution: 512, 1K, 2K, or 4K.",
		schema: { enum: ["512", "1K", "2K", "4K"] },
	},
	size: {
		type: "string",
		description: "OpenAI image size, such as 1024x1024, 1024x1536, or 1536x1024.",
	},
	n: {
		type: "number",
		description: "Number of images, from 1 to 4. Google routes currently support one.",
	},
	quality: {
		type: "string",
		description: "OpenAI quality: auto, low, medium, or high.",
		schema: { enum: ["auto", "low", "medium", "high"] },
	},
	background: {
		type: "string",
		description: "auto, opaque, or transparent.",
		schema: { enum: ["auto", "opaque", "transparent"] },
	},
	path: {
		type: "string",
		description:
			"Optional workspace-relative output path. Only OpenAI routes support direct workspace output.",
	},
	negative_prompt: {
		type: "string",
		description: "Elements to avoid in the generated image.",
	},
	style: {
		type: "string",
		description: "Visual style guidance.",
	},
	system_instruction: {
		type: "string",
		description: "Optional system instruction for Google image routes.",
	},
	temperature: {
		type: "number",
		description: "Sampling temperature for Google image routes.",
		schema: { minimum: 0, maximum: 2 },
	},
	topP: {
		type: "number",
		description: "Nucleus sampling threshold for Google image routes.",
		schema: { minimum: 0, maximum: 1 },
	},
	enable_grounding: {
		type: "boolean",
		description: "Enable Google Search grounding on Google image routes.",
	},
};

export function createImageGenerationTools(options: {
	getConfig: () => OctopusConfig;
	implementations: ImageGenerationImplementations;
	usage?: MediaUsageSink;
}): ToolDefinition[] {
	const canonical: ToolDefinition = {
		name: "generate_image",
		description:
			"Generate or edit real images through the primary and fallback routes configured in Ajustes > Multimedia. Supports OpenAI Images, Gemini API, and Google Agent Platform, and saves results to the Octopus Media library unless an OpenAI workspace path is requested.",
		uiIcon: "image",
		longRunning: true,
		managesOwnPathPolicy: true,
		parameters: IMAGE_PARAMETERS,
		handler: (params, context) => routeImageRequest(options, params, context),
	};
	const compatibilityAlias = (
		implementation: ToolDefinition,
		mapParams: (params: Record<string, unknown>) => Record<string, unknown>,
	): ToolDefinition => ({
		...implementation,
		metadata: {
			...implementation.metadata,
			hiddenFromModel: true,
			compatibilityAliasFor: "generate_image",
		},
		handler: (params, context) => canonical.handler(mapParams(params), context),
	});
	return [
		canonical,
		compatibilityAlias(options.implementations.openaiGenerate, (params) => params),
		compatibilityAlias(options.implementations.openaiEdit, (params) => ({
			...params,
			action: "edit",
			reference_images: [
				params.image ? String(params.image) : "",
				...(Array.isArray(params.images) ? params.images.map(String) : []),
			].filter(Boolean),
		})),
		compatibilityAlias(options.implementations.google, (params) => params),
	];
}

async function routeImageRequest(
	options: {
		getConfig: () => OctopusConfig;
		implementations: ImageGenerationImplementations;
		usage?: MediaUsageSink;
	},
	params: Record<string, unknown>,
	context: ToolContext,
): Promise<ToolResult> {
	const config = options.getConfig();
	if (config.tools.disabled.includes("generate_image")) {
		return {
			success: false,
			output: "",
			error: "Image generation is disabled by the tools policy.",
		};
	}
	const imageConfig = config.multimedia?.image;
	if (!imageConfig || imageConfig.enabled === false) {
		return {
			success: false,
			output: "",
			error: "Image generation is disabled in Ajustes > Multimedia.",
		};
	}
	const prompt = String(params.prompt ?? "").trim();
	if (!prompt) return { success: false, output: "", error: "Missing 'prompt'." };
	const references = Array.isArray(params.reference_images)
		? params.reference_images.map(String).map((value) => value.trim()).filter(Boolean)
		: [];
	if (references.length > 14) {
		return { success: false, output: "", error: "At most 14 reference images are supported." };
	}
	const requestedAction = String(
		params.action ?? (references.length > 0 ? "edit" : "generate"),
	).toLowerCase();
	if (requestedAction !== "generate" && requestedAction !== "edit") {
		return {
			success: false,
			output: "",
			error: "Invalid action. Use generate or edit.",
		};
	}
	if (requestedAction === "edit" && references.length === 0) {
		return {
			success: false,
			output: "",
			error: "Edit action requires at least one reference image.",
		};
	}
	if (requestedAction === "generate" && references.length > 0) {
		return {
			success: false,
			output: "",
			error: "Reference images require action edit. Omit action to infer it automatically.",
		};
	}
	const count = Number(params.n ?? 1);
	if (!Number.isInteger(count) || count < 1 || count > 4) {
		return { success: false, output: "", error: "n must be an integer from 1 to 4." };
	}
	const temperature = params.temperature === undefined ? undefined : Number(params.temperature);
	if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
		return { success: false, output: "", error: "temperature must be between 0 and 2." };
	}
	const topP = params.topP === undefined ? undefined : Number(params.topP);
	if (topP !== undefined && (!Number.isFinite(topP) || topP < 0 || topP > 1)) {
		return { success: false, output: "", error: "topP must be between 0 and 1." };
	}

	const routes = uniqueRoutes([
		imageConfig.primary,
		...imageConfig.fallbacks,
	]);
	const catalog = getMultimediaCatalog(config).routes.filter(
		(entry) => entry.mediaType === "image",
	);
	type AttemptKind = "unavailable" | "param-incompat" | "provider-error";
	const attempts: Array<{
		route: MediaRoute;
		error?: string;
		kind: AttemptKind;
	}> = [];
	const allWarnings: string[] = [];
	const usageReceipts: MediaUsageEvent[] = [];
	const usageEventId = `image:${context.agent?.idempotencyKey ?? randomUUID()}`;
	for (const route of routes) {
		const available = catalog.some(
			(entry) =>
				entry.provider === route.provider &&
				entry.transport === route.transport &&
				entry.available,
		);
		if (!available) {
			attempts.push({
				route,
				error: "Provider credentials are not configured.",
				kind: "unavailable",
			});
			continue;
		}
		const delegated = buildDelegatedRequest(
			route,
			params,
			references,
			requestedAction,
			count,
		);
		if ("error" in delegated) {
			attempts.push({ route, error: delegated.error, kind: "param-incompat" });
			continue;
		}
		if (delegated.warnings) allWarnings.push(...delegated.warnings);
		const implementation = implementationForRoute(
			route,
			requestedAction,
			options.implementations,
		);
		if (!implementation) {
			attempts.push({ route, error: "Unsupported image route.", kind: "param-incompat" });
			continue;
		}
		if (config.tools.disabled.includes(implementation.name)) {
			attempts.push({
				route,
				error: `Image implementation ${implementation.name} is disabled.`,
				kind: "param-incompat",
			});
			continue;
		}
		const routeUsageEventId = `${usageEventId}:route:${attempts.length + 1}`;
		await recordPendingImageUsage(
			options.usage,
			routeUsageEventId,
			route,
			count,
			context,
		);
		const result = await implementation.handler(delegated.params, context);
		const usageReceipt = await recordImageUsage(
			options.usage,
			routeUsageEventId,
			route,
			result,
			count,
			context,
		);
		if (usageReceipt) usageReceipts.push(usageReceipt);
		if (result.success) {
			return {
				...result,
				metadata: {
					...result.metadata,
					canonicalTool: "generate_image",
					route,
					attemptedRoutes: attempts.length + 1,
					warnings: allWarnings.length ? allWarnings : undefined,
					usageReceipt,
					usageReceipts,
				},
			};
		}
		attempts.push({
			route,
			error: result.error ?? "Image route failed.",
			kind: "provider-error",
		});
		if (result.metadata?.submissionState !== "rejected") {
			const state = result.metadata?.submissionState;
			const suffix =
				state === "accepted"
					? " No fallback was attempted because the provider already accepted the request."
					: state === "unknown"
						? " No fallback was attempted because the provider acceptance state may be ambiguous."
						: "";
			return {
				...result,
				error: `${result.error ?? "Image generation failed."}${suffix}`,
				metadata: {
					...result.metadata,
					route,
					attemptedRoutes: attempts.length,
					usageReceipt,
					usageReceipts,
				},
			};
		}
	}

	// Surface the most informative failure. A route that actually attempted a
	// provider call (kind "provider-error": auth/HTTP/network) reveals the real
	// problem (e.g. a Codex 403), while "param-incompat" / "unavailable"
	// fallback errors (e.g. "cannot preserve quality") are secondary and
	// actively misleading on their own — they previously masked the true cause.
	// Prefer the first provider-error (typically the primary route).
	const providerError = attempts.find((attempt) => attempt.kind === "provider-error");
	return {
		success: false,
		output: "",
		error:
			providerError?.error ??
			attempts.at(-1)?.error ??
			"No configured image route is currently available.",
		metadata: {
			attemptedRoutes: attempts.length,
			routes: attempts.map((attempt) => attempt.route),
			warnings: allWarnings.length ? allWarnings : undefined,
			usageReceipts,
		},
	};
}

async function recordPendingImageUsage(
	usage: MediaUsageSink | undefined,
	id: string,
	route: MediaRoute,
	requestedOutputs: number,
	context: ToolContext,
): Promise<void> {
	if (!usage) return;
	await usage.recordMedia({
			id,
			mediaType: "image",
			provider: route.provider,
			model: route.model,
			transport: route.transport,
			status: "unknown",
			toolName: "generate_image",
			agentId: context.agent?.agentId,
			conversationId:
				context.agent?.conversationId ?? context.agent?.channelId,
			requestedOutputs,
			outputCount: 0,
		});
}

async function recordImageUsage(
	usage: MediaUsageSink | undefined,
	id: string,
	route: MediaRoute,
	result: ToolResult,
	requestedOutputs: number,
	context: ToolContext,
): Promise<MediaUsageEvent | undefined> {
	if (!usage) return undefined;
	const urls = Array.isArray(result.metadata?.urls)
		? result.metadata.urls
		: [];
	const metadataCount = Number(result.metadata?.count);
	const outputCount = urls.length || (Number.isFinite(metadataCount) ? metadataCount : 0);
	const submissionState = result.metadata?.submissionState;
	const event: MediaUsageEvent = {
			id,
			mediaType: "image",
			provider: route.provider,
			model: route.model,
			transport: route.transport,
			status: result.success
				? "succeeded"
				: submissionState === "unknown"
					? "unknown"
					: "failed",
			toolName: "generate_image",
			agentId: context.agent?.agentId,
			conversationId:
				context.agent?.conversationId ?? context.agent?.channelId,
			requestedOutputs,
			outputCount,
			estimatedCost:
				typeof result.metadata?.estimatedCost === "number"
					? result.metadata.estimatedCost
					: undefined,
			costSource:
				typeof result.metadata?.estimatedCost === "number"
					? "provider-response"
					: undefined,
		};
	await usage
		.recordMedia(event)
		.catch((error) => {
			console.error("[multimedia] failed to persist image usage:", error);
		});
	return event;
}

function implementationForRoute(
	route: MediaRoute,
	action: "generate" | "edit",
	implementations: ImageGenerationImplementations,
): ToolDefinition | undefined {
	if (route.provider === "openai" && route.transport === "openai-images") {
		return action === "edit" ? implementations.openaiEdit : implementations.openaiGenerate;
	}
	if (
		(route.provider === "gemini" || route.provider === "vertex") &&
		route.transport === "generate-content"
	) {
		return implementations.google;
	}
	return undefined;
}

function buildDelegatedRequest(
	route: MediaRoute,
	params: Record<string, unknown>,
	references: string[],
	action: "generate" | "edit",
	count: number,
): { params: Record<string, unknown>; warnings?: string[] } | { error: string } {
	const delegated: Record<string, unknown> = {
		...params,
		model: route.model,
		__octopus_image_route: route,
	};
	delegated.action = undefined;
	const warnings: string[] = [];
	if (route.provider === "openai") {
		if (params.resolution !== undefined && params.resolution !== "1K") {
			return { error: "OpenAI image routes cannot preserve the requested resolution." };
		}
		if (
			params.system_instruction !== undefined ||
			params.temperature !== undefined ||
			params.topP !== undefined ||
			params.enable_grounding === true
		) {
			return { error: "OpenAI image routes do not support the requested Google-only controls." };
		}
		let prompt = String(params.prompt ?? "");
		if (params.style) prompt += `. Visual style: ${String(params.style)}`;
		if (params.negative_prompt) {
			prompt += `. IMPORTANT - Avoid/do NOT include: ${String(params.negative_prompt)}`;
		}
		delegated.prompt = prompt;
		delegated.size = params.size ?? openAIImageSize(String(params.aspect_ratio ?? ""));
		delegated.n = count;
		if (action === "edit") {
			delegated.image = references[0];
			delegated.images = references.slice(1);
		}
		delegated.reference_images = undefined;
		return { params: delegated };
	}
	if (params.path) {
		return { error: "Google image routes do not support direct workspace paths." };
	}
	if (count !== 1) {
		return { error: "Google image routes currently support exactly one image." };
	}
	if (params.quality !== undefined && params.quality !== "auto") {
		// Google image routes have no OpenAI-style quality dial. Downgrade to
		// 'auto' (the field is cleared below) instead of aborting the whole
		// request — a quality hint must not prevent an otherwise viable image.
		warnings.push(
			`quality='${params.quality}' is not supported on Google image routes; using 'auto'.`,
		);
	}
	if (params.size !== undefined) {
		const mapped = googleImageDimensions(String(params.size));
		if (!mapped) {
			return { error: "Google image routes cannot preserve the requested size." };
		}
		delegated.resolution = params.resolution ?? mapped.resolution;
		delegated.aspect_ratio = params.aspect_ratio ?? mapped.aspectRatio;
	}
	delegated.size = undefined;
	delegated.quality = undefined;
	delegated.n = undefined;
	delegated.reference_images = references;
	return { params: delegated, warnings: warnings.length ? warnings : undefined };
}

function openAIImageSize(aspectRatio: string): string {
	if (["2:3", "3:4", "4:5", "9:16"].includes(aspectRatio)) return "1024x1536";
	if (["3:2", "4:3", "5:4", "16:9", "21:9"].includes(aspectRatio)) {
		return "1536x1024";
	}
	return "1024x1024";
}

function googleImageDimensions(size: string): { resolution: string; aspectRatio: string } | undefined {
	const match = size.match(/^(\d+)x(\d+)$/);
	if (!match) return undefined;
	const width = Number(match[1]);
	const height = Number(match[2]);
	if (!width || !height) return undefined;
	const largest = Math.max(width, height);
	const resolution = largest <= 512 ? "512" : largest <= 1536 ? "1K" : largest <= 3072 ? "2K" : "4K";
	const divisor = greatestCommonDivisor(width, height);
	return { resolution, aspectRatio: `${width / divisor}:${height / divisor}` };
}

function greatestCommonDivisor(left: number, right: number): number {
	let a = left;
	let b = right;
	while (b !== 0) {
		const remainder = a % b;
		a = b;
		b = remainder;
	}
	return a;
}

function uniqueRoutes(routes: MediaRoute[]): MediaRoute[] {
	const seen = new Set<string>();
	return routes.filter((route) => {
		const key = `${route.provider}:${route.transport}:${route.model}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
