/** OpenAI image generation/editing through either the public API or Codex. */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { Worker } from "node:worker_threads";
import {
	type TransparencyInput,
	type TransparencyResult,
	computeTransparencyAlpha,
} from "./transparency-algorithm.js";
import { ConfigLoader } from "../config/loader.js";
import type { OctopusConfig } from "../config/schema.js";
import type { MediaRoute } from "../multimedia/catalog.js";
import { UrlSafetyPolicy } from "../security/url-safety.js";
import { fetchSafeImage } from "../security/safe-image-fetch.js";
import { assertRealPathInside } from "../utils/path-safety.js";
import { mediaContext } from "./media.js";
import type { ToolDefinition, ToolResult } from "./registry.js";

const CODEX_BASE_URL =
	process.env.CODEX_BASE_URL || "https://chatgpt.com/backend-api/codex";

/**
 * Default workspace root (matches the filesystem tools' default). Overridable
 * via OCTOPUS_WORKSPACE_DIR for tests / non-standard installs.
 */
const WORKSPACE_DIR =
	process.env.OCTOPUS_WORKSPACE_DIR || join(homedir(), ".octopus", "workspace");

const IMAGE_SVG =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';
const EDIT_SVG =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>';

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};
const MAX_REFERENCE_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_REFERENCE_TOTAL_BYTES = 64 * 1024 * 1024;

type ImageBackground = "auto" | "opaque" | "transparent";
type OpenAIImageProvider = "openai-api" | "codex";

type OpenAIImageConnection = {
	provider: OpenAIImageProvider;
	model: string;
	baseUrl: string;
	headers: Record<string, string>;
};

export type ChromaKey = {
	hex: string;
	name: string;
	r: number;
	g: number;
	b: number;
};

type ChromaKeyCandidate = ChromaKey & { conflicts: RegExp };

const TRANSPARENT_BACKGROUND_RE =
	/(?:transparent(?:e)?\s+(?:background|fondo|image|imagen|png)|(?:background|fondo|image|imagen|png)\s+transparent(?:e)?|transparen(?:cy|cia)|(?:without|with\s+no|sin)\s+(?:a\s+|el\s+)?(?:background|fondo)|(?:remove|delete|erase|quitar|eliminar|remover|borrar)\s+(?:the\s+|el\s+)?(?:background|fondo)|(?:alpha|alfa)\s+channel|canal\s+alfa)/i;

const CHROMA_KEYS: ChromaKeyCandidate[] = [
	{
		hex: "#00FF00",
		name: "pure chroma green",
		r: 0,
		g: 255,
		b: 0,
		conflicts: /\b(?:green|verde|lime|esmeralda|emerald)\b/i,
	},
	{
		hex: "#0000FF",
		name: "pure chroma blue",
		r: 0,
		g: 0,
		b: 255,
		conflicts: /\b(?:blue|azul|navy|celeste|cobalt|cobalto)\b/i,
	},
	{
		hex: "#FF00FF",
		name: "pure chroma magenta",
		r: 255,
		g: 0,
		b: 255,
		conflicts:
			/\b(?:magenta|pink|rosa|purple|morado|violet|violeta|fuchsia|fucsia)\b/i,
	},
	{
		hex: "#00FFFF",
		name: "pure chroma cyan",
		r: 0,
		g: 255,
		b: 255,
		conflicts: /\b(?:cyan|cian|turquoise|turquesa|aqua)\b/i,
	},
];

function selectChromaKey(prompt: string): ChromaKey {
	return (
		CHROMA_KEYS.find((candidate) => !candidate.conflicts.test(prompt)) ??
		CHROMA_KEYS[0]
	);
}

function addChromaKeyInstruction(prompt: string, chromaKey: ChromaKey): string {
	return `${prompt}\n\nIMPORTANT INTERMEDIATE RENDER REQUIREMENT FOR TRANSPARENCY EXTRACTION: render every empty/background pixel as one completely flat, uniform ${chromaKey.name} field (${chromaKey.hex}, exact RGB ${chromaKey.r},${chromaKey.g},${chromaKey.b}). Do not render transparency, white, gray, a checkerboard, gradients, texture, scenery, or background shadows in this intermediate image. Keep the subject and all of its internal details intact, and do not use ${chromaKey.hex} anywhere inside the subject. Octopus will remove only this chroma field after generation to create the final transparent PNG.`;
}

export function isTransparentImageRequested(
	prompt: string,
	background?: string,
): boolean {
	const requested = background?.trim().toLowerCase();
	if (requested === "opaque") return false;
	if (requested === "transparent") return true;
	return TRANSPARENT_BACKGROUND_RE.test(prompt);
}

export function prepareTransparentImagePrompt(prompt: string): {
	prompt: string;
	chromaKey: ChromaKey;
} {
	const chromaKey = selectChromaKey(prompt);
	return { prompt: addChromaKeyInstruction(prompt, chromaKey), chromaKey };
}

function resolveImageOptions(
	params: Record<string, unknown>,
	prompt: string,
): { model: string; background?: ImageBackground; error?: string } {
	const requestedModel = String(params.model ?? "gpt-image-2").trim();
	const rawBackground = params.background
		? String(params.background).trim().toLowerCase()
		: "";
	if (
		rawBackground &&
		rawBackground !== "auto" &&
		rawBackground !== "opaque" &&
		rawBackground !== "transparent"
	) {
		return {
			model: requestedModel,
			error: "Invalid 'background'. Use auto, opaque, or transparent.",
		};
	}

	const background =
		(rawBackground as ImageBackground | "") ||
		(isTransparentImageRequested(prompt) ? "transparent" : undefined);
	return { model: requestedModel, background };
}

function validateTransparentDestination(
	destPath: string,
	background?: ImageBackground,
): string | undefined {
	if (
		background === "transparent" &&
		destPath &&
		extname(destPath).toLowerCase() !== ".png"
	) {
		return "Transparent Codex images must be saved with a .png extension to preserve the alpha channel.";
	}
	return undefined;
}

async function validateWorkspaceDestination(
	destPath: string,
): Promise<string | undefined> {
	if (!destPath) return undefined;
	const absolute = resolve(
		isAbsolute(destPath) ? destPath : resolve(WORKSPACE_DIR, destPath),
	);
	const rel = relative(WORKSPACE_DIR, absolute);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		return `Destination path '${destPath}' escapes the Octopus workspace. Use a relative path inside the workspace.`;
	}
	try {
		await assertRealPathInside(absolute, [WORKSPACE_DIR]);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function inferMime(p: string): string {
	return MIME_BY_EXT[extname(p).toLowerCase()] ?? "image/png";
}

function firstConfigured(
	...values: Array<string | undefined>
): string | undefined {
	return values.find((value) => Boolean(value?.trim()))?.trim();
}

function codexImageHeaders(
	accessToken: string,
	accountId?: string,
): Record<string, string> {
	const h: Record<string, string> = {
		Authorization: `Bearer ${accessToken.replace(/^Bearer\s+/i, "")}`,
		"content-type": "application/json",
		originator: "codex_cli_rs",
	};
	if (accountId) h.chatgpt_account_id = accountId;
	return h;
}

function loadOpenAIImageConnection(
	config: OctopusConfig = new ConfigLoader().load(),
	route?: MediaRoute,
):
	| OpenAIImageConnection
	| { error: string } {
	if (config.multimedia?.image.enabled === false) {
		return { error: "Image generation is disabled in Ajustes > Multimedia." };
	}
	const openai = config.ai.providers.openai;
	const settings = config.tools.imageGeneration.openai;
	if (!route && settings.enabled === false) {
		return { error: "The legacy OpenAI image alias is disabled." };
	}
	const apiKey = firstConfigured(
		openai.apiKey,
		openai.apiKeyEnv ? process.env[openai.apiKeyEnv] : undefined,
		process.env.OPENAI_API_KEY,
	);
	const accessToken = firstConfigured(
		openai.accessToken,
		openai.accessTokenEnv ? process.env[openai.accessTokenEnv] : undefined,
		process.env.CODEX_ACCESS_TOKEN,
	);
	const imageAuthMode = config.multimedia?.image.openaiAuthMode ?? "inherit";
	const selectedProvider: OpenAIImageProvider = route
		? imageAuthMode === "codex" ||
			(imageAuthMode === "inherit" &&
				(openai.authMode === "codex" || (!apiKey && Boolean(accessToken))))
			? "codex"
			: "openai-api"
		: settings.provider;
	const model = route?.model || settings.model || "gpt-image-2";
	if (selectedProvider === "openai-api") {
		if (!apiKey) {
			return {
				error: "OpenAI API key is required for the selected image provider.",
			};
		}
		return {
			provider: "openai-api",
			model,
			baseUrl: (openai.baseUrl || "https://api.openai.com/v1").replace(
				/\/+$/,
				"",
			),
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
		};
	}

	if (!accessToken) {
		return {
			error: "Codex login is required. Sign in with your OpenAI account first.",
		};
	}
	return {
		provider: "codex",
		model,
		baseUrl: CODEX_BASE_URL.replace(/\/+$/, ""),
		headers: codexImageHeaders(accessToken, openai.accountId),
	};
}

/**
 * Resolve an input image to bytes + mime. Accepts:
 *  - an Octopus media URL ("/api/media/file/<id>.png") or a bare media filename
 *  - an http(s) URL
 *  - a local/workspace file path
 */
async function resolveInputImage(
	input: string,
	urlSafetyPolicy: UrlSafetyPolicy,
): Promise<{ buffer: Buffer; mimeType: string }> {
	const s = input.trim();
	if (s.startsWith("/api/media/file/")) {
		return mediaContext.resolve(s, { maxBytes: MAX_REFERENCE_IMAGE_BYTES });
	}
	if (
		/^[\w.-]+\.(png|jpe?g|webp|gif)$/i.test(s) &&
		!existsSync(resolve(WORKSPACE_DIR, s))
	) {
		return mediaContext.resolve(s, { maxBytes: MAX_REFERENCE_IMAGE_BYTES });
	}
	if (/^https?:\/\//i.test(s)) {
		const fetched = await fetchSafeImage(s, {
			policy: urlSafetyPolicy,
			context: "Image input URL",
			maxBytes: MAX_REFERENCE_IMAGE_BYTES,
		});
		return {
			buffer: fetched.buffer,
			mimeType: fetched.mimeType || inferMime(s),
		};
	}
	const abs = isAbsolute(s) ? s : resolve(WORKSPACE_DIR, s);
	const rel = relative(WORKSPACE_DIR, abs);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error("Input image path must stay inside the Octopus workspace.");
	}
	if (!existsSync(abs)) throw new Error(`Image not found: ${input}`);
	await assertRealPathInside(abs, [WORKSPACE_DIR]);
	if (statSync(abs).size > MAX_REFERENCE_IMAGE_BYTES) {
		throw new Error(
			`Input image exceeds the ${MAX_REFERENCE_IMAGE_BYTES}-byte limit: ${input}`,
		);
	}
	return { buffer: readFileSync(abs), mimeType: inferMime(abs) };
}

async function recoverTransparentBackground(
	buffer: Buffer,
	chromaKey?: ChromaKey,
): Promise<Buffer | undefined> {
	const { default: sharp } = await import('sharp');
	const { data, info } = await sharp(buffer)
		.removeAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const { width, height, channels } = info;
	if (width < 3 || height < 3 || channels < 3) return undefined;

	const input: TransparencyInput = {
		data: new Uint8Array(
			data.buffer,
			data.byteOffset,
			data.byteLength,
		),
		width,
		height,
		channels,
		chromaKey,
	};
	// El flood-fill es CPU-bound (segundos en imágenes grandes): corre en un
	// worker thread para no congelar el event loop (descargas, WS, cron).
	// Si el worker no está disponible (p. ej. tests corriendo desde src sin
	// dist compilado), se ejecuta inline como fallback.
	let result: TransparencyResult;
	try {
		result = await runTransparencyWorker(input);
	} catch {
		result = computeTransparencyAlpha(input);
	}
	if (result.kind !== 'rgba') return undefined;
	return sharp(Buffer.from(result.rgba), {
		raw: { width, height, channels: 4 },
	})
		.png()
		.toBuffer();
}

const TRANSPARENCY_WORKER_TIMEOUT_MS = 60_000;

function runTransparencyWorker(
	input: TransparencyInput,
): Promise<TransparencyResult> {
	return new Promise((resolve, reject) => {
		let worker: Worker;
		try {
			worker = new Worker(
				new URL('./transparency-worker.js', import.meta.url),
				{ workerData: input },
			);
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		const timer = setTimeout(() => {
			void worker.terminate();
			reject(new Error('transparency worker timed out'));
		}, TRANSPARENCY_WORKER_TIMEOUT_MS);
		timer.unref?.();
		worker.on('message', (message: TransparencyResult) => {
			clearTimeout(timer);
			void worker.terminate();
			resolve(message);
		});
		worker.on('error', (error: Error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

export async function ensureTransparentImage(
	buffer: Buffer,
	chromaKey?: ChromaKey,
): Promise<{ buffer: Buffer; alphaPostProcessed: boolean }> {
	const { default: sharp } = await import("sharp");
	if (!(await sharp(buffer).stats()).isOpaque) {
		return { buffer, alphaPostProcessed: false };
	}
	const recovered = await recoverTransparentBackground(buffer, chromaKey);
	if (!recovered || (await sharp(recovered).stats()).isOpaque) {
		throw new Error(
			"The image is opaque and Octopus could not isolate its background safely.",
		);
	}
	return { buffer: recovered, alphaPostProcessed: true };
}

/** Save returned images to a workspace path or the media library. */
async function persistImageOutputs(
	data: Array<{ b64_json?: string; url?: string }>,
	opts: {
		destPath: string;
		prompt: string;
		model: string;
		provider: OpenAIImageProvider;
		size: string;
		background?: ImageBackground;
		chromaKey?: ChromaKey;
		urlSafetyPolicy: UrlSafetyPolicy;
	},
): Promise<{
	urls: string[];
	error?: string;
	failedCount: number;
	alphaPostProcessed: boolean;
}> {
	const {
		destPath,
		prompt,
		model,
		provider,
		size,
		background,
		chromaKey,
		urlSafetyPolicy,
	} =
		opts;
	let destAbs = "";
	let destStem = "";
	let destExt = ".png";
	if (destPath) {
		const abs = resolve(
			isAbsolute(destPath) ? destPath : resolve(WORKSPACE_DIR, destPath),
		);
		const rel = relative(WORKSPACE_DIR, abs);
		if (rel.startsWith("..") || isAbsolute(rel)) {
			return {
				urls: [],
				failedCount: 0,
				alphaPostProcessed: false,
				error: `Destination path '${destPath}' escapes the Octopus workspace. Use a relative path inside the workspace (e.g. 'site/assets/hero.png').`,
			};
		}
		try {
			await assertRealPathInside(abs, [WORKSPACE_DIR]);
		} catch (error) {
			return {
				urls: [],
				failedCount: 0,
				alphaPostProcessed: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		destAbs = abs;
		destExt = extname(abs) || ".png";
		destStem = abs.slice(0, abs.length - destExt.length);
	}
	const urls: string[] = [];
	let persistError: string | undefined;
	let failedCount = 0;
	let alphaPostProcessed = false;
	for (const [idx, item] of data.entries()) {
		try {
			let buffer: Buffer | undefined;
			if (item.b64_json) buffer = Buffer.from(item.b64_json, "base64");
			else if (item.url) {
				buffer = (
					await fetchSafeImage(item.url, {
						policy: urlSafetyPolicy,
						context: "Image output URL",
					})
				).buffer;
			}
			if (!buffer) throw new Error("Image output is missing data and URL payloads.");
			if (background === "transparent") {
				const transparent = await ensureTransparentImage(buffer, chromaKey);
				buffer = transparent.buffer;
				alphaPostProcessed ||= transparent.alphaPostProcessed;
			}
			if (destPath) {
				const finalAbs =
					idx === 0 ? destAbs : `${destStem}_${idx + 1}${destExt}`;
				await assertRealPathInside(finalAbs, [WORKSPACE_DIR]);
				mkdirSync(dirname(finalAbs), { recursive: true });
				writeFileSync(finalAbs, buffer);
				const relPath = relative(WORKSPACE_DIR, finalAbs).split("\\").join("/");
				urls.push(relPath);
			} else {
				const saved = await mediaContext.save(buffer, "image/png", prompt, {
					provider,
					model,
					prompt,
					size,
					background,
					chromaKey: chromaKey?.hex,
					alphaPostProcessed,
				});
				urls.push(saved.url);
			}
		} catch (err) {
			failedCount++;
			persistError =
				err instanceof Error ? err.message : "Failed to save generated image.";
		}
	}
	return { urls, error: persistError, failedCount, alphaPostProcessed };
}

function fetchErrorResult(err: unknown, label: string): ToolResult {
	const msg = err instanceof Error ? err.message : String(err);
	const aborted = isTimeoutError(err);
	console.error(`[codex-image] ${label} failed: ${msg}`);
	return {
		success: false,
		output: "",
		error: aborted
			? `${label} timed out (no response in 180s). The service may be overloaded — retry shortly.`
			: `${label} failed: ${msg}`,
		metadata: { submissionState: "unknown" },
	};
}

/**
 * Build a ToolResult for a non-OK image API HTTP response. For 401/403 it
 * appends actionable guidance: the single most common cause is a ChatGPT/Codex
 * login whose backend refuses image generation, which otherwise surfaces as an
 * opaque "Forbidden" that hides the real remedy (use a platform API key with
 * the auth mode off 'codex', or fall back to the Google route).
 */
function imageApiErrorResult(
	status: number,
	bodyText: string,
	label: string,
	prompt: string,
): ToolResult {
	const detail = bodyText.slice(0, 300);
	console.error(
		`[openai-image] ${label} error ${status} (prompt=${prompt.slice(0, 80)}): ${detail}`,
	);
	const refused = status === 401 || status === 403;
	const guidance = refused
		? " The ChatGPT/Codex backend refused image generation for this account (401/403) — it serves chat but gates images behind an eligible plan. Sign in (Settings > IA > OpenAI) with a ChatGPT Plus/Pro/Team account that includes image generation. Alternatively, set a platform OpenAI API key and switch the image auth mode off 'codex', or use the configured Google (Gemini/Vertex) fallback route."
		: "";
	return {
		success: false,
		output: "",
		error: `${label} error (${status}): ${detail}${guidance}`,
		metadata: {
			submissionState: status < 500 && status !== 408 ? "rejected" : "unknown",
		},
	};
}

function isTimeoutError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /aborted|timeout|timed out|TimeoutError/i.test(msg);
}

function isRetryableImageStatus(status: number): boolean {
	return status === 429;
}

function retryDelayMs(response: Response): number {
	const retryAfter = response.headers.get("retry-after")?.trim();
	if (retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)) {
		return Math.min(Number(retryAfter) * 1000, 5_000);
	}
	return 1_000;
}

async function requestImageWithRetry(
	label: string,
	requestedQuality: string,
	request: (quality: string) => Promise<Response>,
): Promise<
	| { response: Response; quality: string; retried: boolean }
	| { error: ToolResult }
> {
	const quality = requestedQuality;
	for (let attempt = 0; attempt < 2; attempt++) {
		let response: Response;
		try {
			response = await request(quality);
		} catch (err) {
			return { error: fetchErrorResult(err, label) };
		}

		if (
			response.ok ||
			attempt > 0 ||
			!isRetryableImageStatus(response.status)
		) {
			return { response, quality, retried: attempt > 0 };
		}

		const details = await response.text().catch(() => response.statusText);
		console.warn(
			`[codex-image] ${label} received ${response.status}; retrying once with unchanged quality=${quality}: ${details.slice(0, 200)}`,
		);
		const delay = retryDelayMs(response);
		if (delay > 0) {
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	return {
		error: {
			success: false,
			output: "",
			error: `${label} failed after retry.`,
		},
	};
}

export function createCodexImageTools(options: {
	getConfig?: () => OctopusConfig;
} = {}): ToolDefinition[] {
	const sharedImageParams = {
		model: {
			type: "string",
			description: "Image model (default: gpt-image-2).",
			required: false,
		},
		size: {
			type: "string",
			description:
				"Image size, e.g. '1024x1024', '1024x1536', 'auto' (default: 1024x1024).",
			required: false,
		},
		n: {
			type: "number",
			description: "Number of images to generate (default: 1, max 4).",
			required: false,
		},
		quality: {
			type: "string",
			description: "auto | low | medium | high (default: auto).",
			required: false,
		},
		background: {
			type: "string",
			description:
				"Output background: auto | opaque | transparent. Use transparent for a real PNG alpha channel. Octopus requests a dynamically selected high-saturation chroma background, removes only that color, and preserves internal details such as white eyes and highlights.",
			required: false,
		},
		path: {
			type: "string",
			description:
				"Optional destination path RELATIVE to the Octopus workspace (e.g. 'site/assets/hero.png'). When set, the image is written there (next to a generated HTML) and the tool returns that relative path (forward slashes) for use in <img src=\"...\">. If n>1, an index suffix is added before the extension. Omit to save to the media library instead. IMPORTANT: always use a workspace-relative path; do NOT pass the application install path or absolute paths outside ~/.octopus/workspace — those are rejected by the path-safety policy.",
			required: false,
		},
	};

	return [
		{
			name: "codex_generate_image",
			description:
				"Generate images with OpenAI gpt-image-2 using the provider selected in Settings: OpenAI API or OpenAI Codex. Supports native API transparency and safe chroma recovery for Codex. By default returns media-library URLs; pass `path` only for workspace assets used by generated HTML/sites.",
			uiIcon: IMAGE_SVG,
			managesOwnPathPolicy: true,
			metadata: {
				hiddenFromModel: true,
				compatibilityAliasFor: "generate_image",
			},
			parameters: {
				prompt: {
					type: "string",
					description: "A description of the image(s) to generate.",
					required: true,
				},
				...sharedImageParams,
			},
			handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
				const prompt = String(params.prompt ?? "").trim();
				if (!prompt) {
					return { success: false, output: "", error: "Missing 'prompt'." };
				}
				const runtimeConfig = options.getConfig?.() ?? new ConfigLoader().load();
				const connection = loadOpenAIImageConnection(
					runtimeConfig,
					params.__octopus_image_route as MediaRoute | undefined,
				);
				if ("error" in connection) {
					return {
						success: false,
						output: "",
						error: connection.error,
						metadata: { submissionState: "rejected" },
					};
				}
				const imageOptions = resolveImageOptions(
					{ ...params, model: params.model ?? connection.model },
					prompt,
				);
				if (imageOptions.error) {
					return {
						success: false,
						output: "",
						error: imageOptions.error,
						metadata: { submissionState: "rejected" },
					};
				}
				const { model, background } = imageOptions;
				const urlSafetyPolicy = new UrlSafetyPolicy(
					runtimeConfig.security?.urlPolicy,
				);
				const transparency =
					background === "transparent" && connection.provider === "codex"
						? prepareTransparentImagePrompt(prompt)
						: undefined;
				const chromaKey = transparency?.chromaKey;
				const requestPrompt = transparency?.prompt ?? prompt;
				const size = String(params.size ?? "1024x1024");
				const n = Math.min(Math.max(Number(params.n ?? 1) || 1, 1), 4);
				const quality = String(params.quality ?? "auto");
				const destPath = params.path ? String(params.path).trim() : "";
				const destinationError =
					validateTransparentDestination(destPath, background) ??
					(await validateWorkspaceDestination(destPath));
				if (destinationError) {
					return {
						success: false,
						output: "",
						error: destinationError,
						metadata: { submissionState: "rejected" },
					};
				}

				const requestResult = await requestImageWithRetry(
					"OpenAI image request",
					quality,
					(effectiveQuality) =>
						fetch(`${connection.baseUrl}/images/generations`, {
							method: "POST",
							headers: connection.headers,
							body: JSON.stringify({
								prompt: requestPrompt,
								model,
								n,
								size,
								quality: effectiveQuality,
								...(background ? { background } : {}),
								...(connection.provider === "openai-api"
									? { output_format: "png" }
									: {}),
							}),
							// Image generation can take a while (high-quality gpt-image
							// runs reach ~60-120s), but a hung request must not pin the
							// agent turn forever. 180s is generous; an abort surfaces as
							// a normal tool error the model can retry by calling again.
							signal: AbortSignal.timeout(180000),
						}),
				);
				if ("error" in requestResult) {
					return requestResult.error;
				}
				const { response, quality: effectiveQuality, retried } = requestResult;
				if (!response.ok) {
					const text = await response.text().catch(() => response.statusText);
					return imageApiErrorResult(
						response.status,
						text,
						"OpenAI image API",
						prompt,
					);
				}

				let json: { data?: Array<{ b64_json?: string; url?: string }> };
				try {
					json = (await response.json()) as typeof json;
				} catch (err) {
					return {
						...fetchErrorResult(err, "OpenAI image response"),
						metadata: { submissionState: "accepted" },
					};
				}
				const { urls, error, failedCount, alphaPostProcessed } =
					await persistImageOutputs(
					json.data ?? [],
					{
						destPath,
						prompt,
						model,
						provider: connection.provider,
						size,
						background,
						chromaKey,
						urlSafetyPolicy,
					},
				);
				if (urls.length === 0) {
					return {
						success: false,
						output: "",
						error: error ?? "OpenAI image API returned no image data.",
						metadata: { submissionState: "accepted" },
					};
				}
				return {
					success: true,
					output: [
						urls.map((u, i) => `Image ${i + 1}: ${u}`).join("\n"),
						error
							? `Warning: ${failedCount} paid output(s) could not be saved (${error}).`
							: "",
					]
						.filter(Boolean)
						.join("\n"),
					metadata: {
						submissionState: "accepted",
						partialFailure: error,
						failedOutputCount: failedCount,
						count: urls.length,
						urls,
						model,
						provider: connection.provider,
						prompt,
						quality: effectiveQuality,
						requestedQuality: quality,
						retried,
						background,
						chromaKey: chromaKey?.hex,
						alphaPostProcessed,
					},
				};
			},
		},
		{
			name: "codex_edit_image",
			description:
				"Edit one or more images with OpenAI gpt-image-2 using the provider selected in Settings: OpenAI API or OpenAI Codex. Accepts Octopus media URLs, HTTP URLs, and workspace paths, including multiple inputs for compositing.",
			uiIcon: EDIT_SVG,
			managesOwnPathPolicy: true,
			metadata: {
				hiddenFromModel: true,
				compatibilityAliasFor: "generate_image",
			},
			parameters: {
				image: {
					type: "string",
					description:
						"The image to edit: an Octopus media URL ('/api/media/file/<id>.png'), an http(s) URL, or a local/workspace file path.",
					required: true,
				},
				images: {
					type: "array",
					description:
						"Additional input images (media URLs / http URLs / file paths) for multi-image edit or composite.",
					required: false,
				},
				prompt: {
					type: "string",
					description:
						"A description of the edit to apply to the input image(s).",
					required: true,
				},
				...sharedImageParams,
			},
			handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
				const prompt = String(params.prompt ?? "").trim();
				if (!prompt) {
					return { success: false, output: "", error: "Missing 'prompt'." };
				}
				const image = params.image ? String(params.image).trim() : "";
				const extra = Array.isArray(params.images)
					? params.images.map((x) => String(x).trim()).filter(Boolean)
					: [];
				const inputs = [image, ...extra].filter(Boolean);
				if (inputs.length === 0) {
					return {
						success: false,
						output: "",
						error: "Missing 'image' (the image to edit).",
					};
				}
				const runtimeConfig = options.getConfig?.() ?? new ConfigLoader().load();
				const connection = loadOpenAIImageConnection(
					runtimeConfig,
					params.__octopus_image_route as MediaRoute | undefined,
				);
				if ("error" in connection) {
					return {
						success: false,
						output: "",
						error: connection.error,
						metadata: { submissionState: "rejected" },
					};
				}
				const imageOptions = resolveImageOptions(
					{ ...params, model: params.model ?? connection.model },
					prompt,
				);
				if (imageOptions.error) {
					return {
						success: false,
						output: "",
						error: imageOptions.error,
						metadata: { submissionState: "rejected" },
					};
				}
				const { model, background } = imageOptions;
				const urlSafetyPolicy = new UrlSafetyPolicy(
					runtimeConfig.security?.urlPolicy,
				);
				const transparency =
					background === "transparent" && connection.provider === "codex"
						? prepareTransparentImagePrompt(prompt)
						: undefined;
				const chromaKey = transparency?.chromaKey;
				const requestPrompt = transparency?.prompt ?? prompt;
				const size = String(params.size ?? "1024x1024");
				const n = Math.min(Math.max(Number(params.n ?? 1) || 1, 1), 4);
				const quality = String(params.quality ?? "auto");
				const destPath = params.path ? String(params.path).trim() : "";
				const destinationError =
					validateTransparentDestination(destPath, background) ??
					(await validateWorkspaceDestination(destPath));
				if (destinationError) {
					return {
						success: false,
						output: "",
						error: destinationError,
						metadata: { submissionState: "rejected" },
					};
				}

				// Resolve each input image -> {image_url: data URL}. The Codex
				// /images/edits endpoint expects an array of objects, each with
				// exactly one of `image_url` or `file_id`; data URLs work for local
				// images that the backend cannot fetch directly.
				const images: Array<{ image_url: string }> = [];
				const resolvedImages: Array<{ buffer: Buffer; mimeType: string }> = [];
				let totalReferenceBytes = 0;
				for (const inp of inputs) {
					try {
						const { buffer, mimeType } = await resolveInputImage(
							inp,
							urlSafetyPolicy,
						);
						totalReferenceBytes += buffer.length;
						if (totalReferenceBytes > MAX_REFERENCE_TOTAL_BYTES) {
							throw new Error(
								`Reference images exceed the ${MAX_REFERENCE_TOTAL_BYTES}-byte aggregate limit.`,
							);
						}
						resolvedImages.push({ buffer, mimeType });
						images.push({
							image_url: `data:${mimeType};base64,${buffer.toString("base64")}`,
						});
					} catch (err) {
						return {
							success: false,
							output: "",
							error: `Could not load input image '${inp}': ${err instanceof Error ? err.message : String(err)}`,
							metadata: { submissionState: "rejected" },
						};
					}
				}

				const requestResult = await requestImageWithRetry(
					"OpenAI image edit request",
					quality,
					async (effectiveQuality) => {
						if (connection.provider === "openai-api") {
							const form = new FormData();
							form.append("prompt", requestPrompt);
							form.append("model", model);
							form.append("n", String(n));
							form.append("size", size);
							form.append("quality", effectiveQuality);
							form.append("output_format", "png");
							if (background) form.append("background", background);
							resolvedImages.forEach(({ buffer, mimeType }, index) => {
								form.append(
									"image[]",
									new Blob([new Uint8Array(buffer)], { type: mimeType }),
									`image-${index + 1}.${mimeType.includes("png") ? "png" : "jpg"}`,
								);
							});
							return fetch(`${connection.baseUrl}/images/edits`, {
								method: "POST",
								headers: { Authorization: connection.headers.Authorization },
								body: form,
								signal: AbortSignal.timeout(180000),
							});
						}
						return fetch(`${connection.baseUrl}/images/edits`, {
							method: "POST",
							headers: connection.headers,
							body: JSON.stringify({
								images,
								prompt: requestPrompt,
								model,
								n,
								size,
								quality: effectiveQuality,
								...(background ? { background } : {}),
							}),
							signal: AbortSignal.timeout(180000),
						});
					},
				);
				if ("error" in requestResult) {
					return requestResult.error;
				}
				const { response, quality: effectiveQuality, retried } = requestResult;
				if (!response.ok) {
					const text = await response.text().catch(() => response.statusText);
					return imageApiErrorResult(
						response.status,
						text,
						"OpenAI image edit API",
						prompt,
					);
				}

				let json: { data?: Array<{ b64_json?: string; url?: string }> };
				try {
					json = (await response.json()) as typeof json;
				} catch (err) {
					return {
						...fetchErrorResult(err, "OpenAI image edit response"),
						metadata: { submissionState: "accepted" },
					};
				}
				const { urls, error, failedCount, alphaPostProcessed } =
					await persistImageOutputs(
					json.data ?? [],
					{
						destPath,
						prompt,
						model,
						provider: connection.provider,
						size,
						background,
						chromaKey,
						urlSafetyPolicy,
					},
				);
				if (urls.length === 0) {
					return {
						success: false,
						output: "",
						error: error ?? "OpenAI image edit returned no image data.",
						metadata: { submissionState: "accepted" },
					};
				}
				return {
					success: true,
					output: [
						urls.map((u, i) => `Edited image ${i + 1}: ${u}`).join("\n"),
						error
							? `Warning: ${failedCount} paid output(s) could not be saved (${error}).`
							: "",
					]
						.filter(Boolean)
						.join("\n"),
					metadata: {
						submissionState: "accepted",
						partialFailure: error,
						failedOutputCount: failedCount,
						count: urls.length,
						urls,
						model,
						provider: connection.provider,
						prompt,
						quality: effectiveQuality,
						requestedQuality: quality,
						retried,
						background,
						chromaKey: chromaKey?.hex,
						alphaPostProcessed,
						inputs,
					},
				};
			},
		},
	];
}
