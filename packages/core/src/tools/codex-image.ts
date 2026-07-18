/**
 * codex_generate_image / codex_edit_image — generate and edit images via the
 * OpenAI Codex backend using the ChatGPT-account access_token (same auth as the
 * Codex text provider). Mirrors the Codex CLI image endpoints:
 *   POST {codex}/images/generations  (text -> image)
 *   POST {codex}/images/edits        (image(s) + text -> image)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import {
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { ConfigLoader } from "../config/loader.js";
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

type ImageBackground = "auto" | "opaque" | "transparent";

type ChromaKey = {
	hex: string;
	name: string;
	r: number;
	g: number;
	b: number;
	conflicts: RegExp;
};

const TRANSPARENT_BACKGROUND_RE =
	/(?:transparent(?:e)?\s+(?:background|fondo|image|imagen|png)|(?:background|fondo|image|imagen|png)\s+transparent(?:e)?|transparen(?:cy|cia)|(?:without|with\s+no|sin)\s+(?:a\s+|el\s+)?(?:background|fondo)|(?:remove|delete|erase|quitar|eliminar|remover|borrar)\s+(?:the\s+|el\s+)?(?:background|fondo)|(?:alpha|alfa)\s+channel|canal\s+alfa)/i;

const CHROMA_KEYS: ChromaKey[] = [
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
		(TRANSPARENT_BACKGROUND_RE.test(prompt) ? "transparent" : undefined);
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

function inferMime(p: string): string {
	return MIME_BY_EXT[extname(p).toLowerCase()] ?? "image/png";
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

function loadCodexCreds():
	| { accessToken: string; accountId?: string }
	| { error: string } {
	const openai = new ConfigLoader().load().ai.providers.openai;
	const accessToken = openai.accessToken;
	const accountId = openai.accountId;
	if (!accessToken || openai.authMode !== "codex") {
		return {
			error: "Codex login is required. Sign in with your OpenAI account first.",
		};
	}
	return { accessToken, accountId };
}

/**
 * Resolve an input image to bytes + mime. Accepts:
 *  - an Octopus media URL ("/api/media/file/<id>.png") or a bare media filename
 *  - an http(s) URL
 *  - a local/workspace file path
 */
async function resolveInputImage(
	input: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
	const s = input.trim();
	if (
		s.startsWith("/api/media/file/") ||
		/^[\w.-]+\.(png|jpe?g|webp|gif)$/i.test(s)
	) {
		return mediaContext.resolve(s);
	}
	if (/^https?:\/\//i.test(s)) {
		const r = await fetch(s);
		if (!r.ok) throw new Error(`Image fetch failed (${r.status})`);
		return {
			buffer: Buffer.from(await r.arrayBuffer()),
			mimeType: r.headers.get("content-type") || inferMime(s),
		};
	}
	const abs = isAbsolute(s) ? s : resolve(WORKSPACE_DIR, s);
	if (!existsSync(abs)) throw new Error(`Image not found: ${input}`);
	return { buffer: readFileSync(abs), mimeType: inferMime(abs) };
}

async function recoverTransparentBackground(
	buffer: Buffer,
	chromaKey?: ChromaKey,
): Promise<Buffer | undefined> {
	const { default: sharp } = await import("sharp");
	const { data, info } = await sharp(buffer)
		.removeAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const { width, height, channels } = info;
	if (width < 3 || height < 3 || channels < 3) return undefined;

	type ColorBucket = {
		count: number;
		r: number;
		g: number;
		b: number;
	};
	const buckets = new Map<number, ColorBucket>();
	let borderSamples = 0;
	const sample = (x: number, y: number) => {
		const offset = (y * width + x) * channels;
		const r = data[offset] ?? 0;
		const g = data[offset + 1] ?? 0;
		const b = data[offset + 2] ?? 0;
		const key = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
		const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
		bucket.count++;
		bucket.r += r;
		bucket.g += g;
		bucket.b += b;
		buckets.set(key, bucket);
		borderSamples++;
	};
	for (let x = 0; x < width; x++) {
		sample(x, 0);
		sample(x, height - 1);
	}
	for (let y = 1; y < height - 1; y++) {
		sample(0, y);
		sample(width - 1, y);
	}

	const dominant = [...buckets.values()]
		.filter((bucket) => bucket.count / borderSamples >= 0.02)
		.sort((a, b) => b.count - a.count)
		.slice(0, 6);
	if (dominant.length === 0 || dominant[0].count / borderSamples < 0.08) {
		return undefined;
	}
	const learnedColors = dominant.map((bucket) => ({
		count: bucket.count,
		r: bucket.r / bucket.count,
		g: bucket.g / bucket.count,
		b: bucket.b / bucket.count,
	}));
	const chromaColors = chromaKey
		? learnedColors.filter(
				(color) =>
					Math.max(
						Math.abs(color.r - chromaKey.r),
						Math.abs(color.g - chromaKey.g),
						Math.abs(color.b - chromaKey.b),
					) <= 96 &&
					Math.max(color.r, color.g, color.b) -
						Math.min(color.r, color.g, color.b) >=
						80,
			)
		: [];
	const chromaCoverage =
		chromaColors.reduce((sum, color) => sum + color.count, 0) / borderSamples;
	const chromaConfirmed = chromaColors.length > 0 && chromaCoverage >= 0.35;
	const colors = chromaConfirmed ? chromaColors : learnedColors;
	const tolerance = 30;
	const nearestBackground = (pixelIndex: number) => {
		const offset = pixelIndex * channels;
		const r = data[offset] ?? 0;
		const g = data[offset + 1] ?? 0;
		const b = data[offset + 2] ?? 0;
		let nearest = colors[0];
		let distance = Number.POSITIVE_INFINITY;
		for (const color of colors) {
			const candidate = Math.max(
				Math.abs(r - color.r),
				Math.abs(g - color.g),
				Math.abs(b - color.b),
			);
			if (candidate < distance) {
				distance = candidate;
				nearest = color;
			}
		}
		return { color: nearest, distance };
	};
	const matchesBackground = (pixelIndex: number): boolean => {
		return nearestBackground(pixelIndex).distance <= tolerance;
	};

	const pixelCount = width * height;
	const backgroundMask = new Uint8Array(pixelCount);
	const queue = new Int32Array(pixelCount);
	let head = 0;
	let tail = 0;
	const enqueue = (pixelIndex: number) => {
		if (backgroundMask[pixelIndex] || !matchesBackground(pixelIndex)) return;
		backgroundMask[pixelIndex] = 1;
		queue[tail++] = pixelIndex;
	};
	for (let x = 0; x < width; x++) {
		enqueue(x);
		enqueue((height - 1) * width + x);
	}
	for (let y = 1; y < height - 1; y++) {
		enqueue(y * width);
		enqueue(y * width + width - 1);
	}
	while (head < tail) {
		const pixelIndex = queue[head++];
		const x = pixelIndex % width;
		if (x > 0) enqueue(pixelIndex - 1);
		if (x + 1 < width) enqueue(pixelIndex + 1);
		if (pixelIndex >= width) enqueue(pixelIndex - width);
		if (pixelIndex + width < pixelCount) enqueue(pixelIndex + width);
	}

	let backgroundPixels = tail;
	if (chromaConfirmed) {
		const visited = new Uint8Array(pixelCount);
		for (let start = 0; start < pixelCount; start++) {
			if (
				backgroundMask[start] ||
				visited[start] ||
				!matchesBackground(start)
			) {
				continue;
			}
			head = 0;
			tail = 0;
			visited[start] = 1;
			queue[tail++] = start;
			while (head < tail) {
				const pixelIndex = queue[head++];
				const x = pixelIndex % width;
				const visit = (neighbor: number) => {
					if (
						visited[neighbor] ||
						backgroundMask[neighbor] ||
						!matchesBackground(neighbor)
					) {
						return;
					}
					visited[neighbor] = 1;
					queue[tail++] = neighbor;
				};
				if (x > 0) visit(pixelIndex - 1);
				if (x + 1 < width) visit(pixelIndex + 1);
				if (pixelIndex >= width) visit(pixelIndex - width);
				if (pixelIndex + width < pixelCount) visit(pixelIndex + width);
			}
			for (let index = 0; index < tail; index++) {
				backgroundMask[queue[index]] = 1;
			}
			backgroundPixels += tail;
		}
	}

	const foregroundPixels = pixelCount - backgroundPixels;
	if (
		backgroundPixels < pixelCount * 0.02 ||
		foregroundPixels < pixelCount * 0.005
	) {
		return undefined;
	}

	const matteRadius = 3;
	const edgeDistance = new Uint8Array(pixelCount);
	head = 0;
	tail = 0;
	const addEdgePixel = (pixelIndex: number, distance: number) => {
		if (backgroundMask[pixelIndex] || edgeDistance[pixelIndex]) return;
		edgeDistance[pixelIndex] = distance;
		queue[tail++] = pixelIndex;
	};
	for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
		if (!backgroundMask[pixelIndex]) continue;
		const x = pixelIndex % width;
		if (x > 0) addEdgePixel(pixelIndex - 1, 1);
		if (x + 1 < width) addEdgePixel(pixelIndex + 1, 1);
		if (pixelIndex >= width) addEdgePixel(pixelIndex - width, 1);
		if (pixelIndex + width < pixelCount) addEdgePixel(pixelIndex + width, 1);
	}
	while (head < tail) {
		const pixelIndex = queue[head++];
		const distance = edgeDistance[pixelIndex] ?? 0;
		if (distance >= matteRadius) continue;
		const x = pixelIndex % width;
		if (x > 0) addEdgePixel(pixelIndex - 1, distance + 1);
		if (x + 1 < width) addEdgePixel(pixelIndex + 1, distance + 1);
		if (pixelIndex >= width) addEdgePixel(pixelIndex - width, distance + 1);
		if (pixelIndex + width < pixelCount)
			addEdgePixel(pixelIndex + width, distance + 1);
	}

	const rgba = Buffer.allocUnsafe(pixelCount * 4);
	for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
		const sourceOffset = pixelIndex * channels;
		const targetOffset = pixelIndex * 4;
		const red = data[sourceOffset] ?? 0;
		const green = data[sourceOffset + 1] ?? 0;
		const blue = data[sourceOffset + 2] ?? 0;
		let alpha = backgroundMask[pixelIndex] ? 0 : 1;
		let outputRed = red;
		let outputGreen = green;
		let outputBlue = blue;
		const distance = edgeDistance[pixelIndex] ?? 0;
		if (alpha && distance) {
			const { color } = nearestBackground(pixelIndex);
			const colorDifference = Math.max(
				Math.abs(red - color.r),
				Math.abs(green - color.g),
				Math.abs(blue - color.b),
			);
			const availableRange = Math.max(
				color.r,
				255 - color.r,
				color.g,
				255 - color.g,
				color.b,
				255 - color.b,
				1,
			);
			const estimatedAlpha = Math.max(
				0,
				Math.min(1, (colorDifference - 2) / availableRange),
			);
			const layerFloor = ((distance - 1) / matteRadius) * 0.85;
			alpha = Math.max(estimatedAlpha, layerFloor);
			if (alpha < 0.02) {
				alpha = 0;
			} else {
				outputRed = color.r + (red - color.r) / alpha;
				outputGreen = color.g + (green - color.g) / alpha;
				outputBlue = color.b + (blue - color.b) / alpha;
			}
		}
		rgba[targetOffset] = Math.max(0, Math.min(255, Math.round(outputRed)));
		rgba[targetOffset + 1] = Math.max(
			0,
			Math.min(255, Math.round(outputGreen)),
		);
		rgba[targetOffset + 2] = Math.max(0, Math.min(255, Math.round(outputBlue)));
		rgba[targetOffset + 3] = Math.round(alpha * 255);
	}
	return sharp(rgba, { raw: { width, height, channels: 4 } })
		.png()
		.toBuffer();
}

/** Save returned images to a workspace path or the media library. */
async function persistImageOutputs(
	data: Array<{ b64_json?: string; url?: string }>,
	opts: {
		destPath: string;
		prompt: string;
		model: string;
		size: string;
		background?: ImageBackground;
		chromaKey?: ChromaKey;
	},
): Promise<{ urls: string[]; error?: string; alphaPostProcessed: boolean }> {
	const { destPath, prompt, model, size, background, chromaKey } = opts;
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
				alphaPostProcessed: false,
				error: `Destination path '${destPath}' escapes the Octopus workspace. Use a relative path inside the workspace (e.g. 'site/assets/hero.png').`,
			};
		}
		destAbs = abs;
		destExt = extname(abs) || ".png";
		destStem = abs.slice(0, abs.length - destExt.length);
	}
	const urls: string[] = [];
	let persistError: string | undefined;
	let alphaPostProcessed = false;
	for (const [idx, item] of data.entries()) {
		try {
			let buffer: Buffer | undefined;
			if (item.b64_json) buffer = Buffer.from(item.b64_json, "base64");
			else if (item.url) {
				const imgResp = await fetch(item.url);
				if (imgResp.ok) buffer = Buffer.from(await imgResp.arrayBuffer());
			}
			if (!buffer) continue;
			if (background === "transparent") {
				const { default: sharp } = await import("sharp");
				const stats = await sharp(buffer).stats();
				if (stats.isOpaque) {
					const recovered = await recoverTransparentBackground(
						buffer,
						chromaKey,
					);
					if (!recovered || (await sharp(recovered).stats()).isOpaque) {
						persistError =
							"Codex returned an opaque image and Octopus could not isolate its background safely; the file was not saved.";
						continue;
					}
					buffer = recovered;
					alphaPostProcessed = true;
				}
			}
			if (destPath) {
				const finalAbs =
					idx === 0 ? destAbs : `${destStem}_${idx + 1}${destExt}`;
				mkdirSync(dirname(finalAbs), { recursive: true });
				writeFileSync(finalAbs, buffer);
				const relPath = relative(WORKSPACE_DIR, finalAbs).split("\\").join("/");
				urls.push(relPath);
			} else {
				const saved = await mediaContext.save(buffer, "image/png", prompt, {
					provider: "codex",
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
			persistError =
				err instanceof Error ? err.message : "Failed to save generated image.";
		}
	}
	return { urls, error: persistError, alphaPostProcessed };
}

function fetchErrorResult(err: unknown, label: string): ToolResult {
	const msg = err instanceof Error ? err.message : String(err);
	const aborted = /aborted|timeout|timed out|TimeoutError/i.test(msg);
	console.error(`[codex-image] ${label} failed: ${msg}`);
	return {
		success: false,
		output: "",
		error: aborted
			? `${label} timed out (no response in 180s). The service may be overloaded — retry shortly.`
			: `${label} failed: ${msg}`,
	};
}

export function createCodexImageTools(): ToolDefinition[] {
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
				"Generate one or more images from a text prompt using the OpenAI Codex backend (your ChatGPT/Codex account, gpt-image-2). Requires Codex login. For a real transparent alpha channel, pass background='transparent'; Octopus requests a high-saturation chroma background selected to avoid the subject's colors, then removes that chroma locally while preserving internal details such as eyes and highlights. By default returns the saved image URL(s) in the Octopus media library. For images that must appear in a generated HTML/site, pass `path` so the image is saved next to the HTML and referenced by relative path — do NOT embed images as base64 data URIs in HTML, it bloats the file and breaks the conversation context.",
			uiIcon: IMAGE_SVG,
			managesOwnPathPolicy: true,
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
				const imageOptions = resolveImageOptions(params, prompt);
				if (imageOptions.error) {
					return { success: false, output: "", error: imageOptions.error };
				}
				const { model, background } = imageOptions;
				const chromaKey =
					background === "transparent" ? selectChromaKey(prompt) : undefined;
				const requestPrompt = chromaKey
					? addChromaKeyInstruction(prompt, chromaKey)
					: prompt;
				const size = String(params.size ?? "1024x1024");
				const n = Math.min(Math.max(Number(params.n ?? 1) || 1, 1), 4);
				const quality = String(params.quality ?? "auto");
				const destPath = params.path ? String(params.path).trim() : "";
				const destinationError = validateTransparentDestination(
					destPath,
					background,
				);
				if (destinationError) {
					return { success: false, output: "", error: destinationError };
				}

				const creds = loadCodexCreds();
				if ("error" in creds) {
					return { success: false, output: "", error: creds.error };
				}

				let response: Response;
				try {
					response = await fetch(`${CODEX_BASE_URL}/images/generations`, {
						method: "POST",
						headers: codexImageHeaders(creds.accessToken, creds.accountId),
						body: JSON.stringify({
							prompt: requestPrompt,
							model,
							n,
							size,
							quality,
							...(background ? { background } : {}),
						}),
						// Image generation can take a while (high-quality gpt-image
						// runs reach ~60-120s), but a hung request must not pin the
						// agent turn forever. 180s is generous; an abort surfaces as
						// a normal tool error the model can retry by calling again.
						signal: AbortSignal.timeout(180000),
					});
				} catch (err) {
					return fetchErrorResult(err, "Codex image request");
				}
				if (!response.ok) {
					const text = await response.text().catch(() => response.statusText);
					console.error(
						`[codex-image] API error ${response.status} (prompt=${prompt.slice(0, 80)}): ${text.slice(0, 300)}`,
					);
					return {
						success: false,
						output: "",
						error: `Codex image API error (${response.status}): ${text.slice(0, 300)}`,
					};
				}

				let json: { data?: Array<{ b64_json?: string; url?: string }> };
				try {
					json = (await response.json()) as typeof json;
				} catch (err) {
					return fetchErrorResult(err, "Codex image response");
				}
				const { urls, error, alphaPostProcessed } = await persistImageOutputs(
					json.data ?? [],
					{
						destPath,
						prompt,
						model,
						size,
						background,
						chromaKey,
					},
				);
				if (urls.length === 0) {
					return {
						success: false,
						output: "",
						error: error ?? "Codex image API returned no image data.",
					};
				}
				return {
					success: true,
					output: urls.map((u, i) => `Image ${i + 1}: ${u}`).join("\n"),
					metadata: {
						count: urls.length,
						urls,
						model,
						prompt,
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
				"Edit one or more existing images with a text prompt using the OpenAI Codex backend (gpt-image-2). Pass the image to edit via `image` (an Octopus media URL like '/api/media/file/<id>.png', an http(s) URL, or a local/workspace file path) plus a `prompt` describing the edit (e.g. 'remove the background', 'add a red hat', 'change the color to blue', 'make it a watercolor'). For background removal with a real alpha channel, pass background='transparent'; Octopus uses a dynamically selected chroma background and removes only that color, preserving internal subject details. To composite/edit with more than one input, pass additional images via `images`. Returns the edited image URL(s) in the media library, or a workspace-relative path when `path` is set.",
			uiIcon: EDIT_SVG,
			managesOwnPathPolicy: true,
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
				const imageOptions = resolveImageOptions(params, prompt);
				if (imageOptions.error) {
					return { success: false, output: "", error: imageOptions.error };
				}
				const { model, background } = imageOptions;
				const chromaKey =
					background === "transparent" ? selectChromaKey(prompt) : undefined;
				const requestPrompt = chromaKey
					? addChromaKeyInstruction(prompt, chromaKey)
					: prompt;
				const size = String(params.size ?? "1024x1024");
				const n = Math.min(Math.max(Number(params.n ?? 1) || 1, 1), 4);
				const quality = String(params.quality ?? "auto");
				const destPath = params.path ? String(params.path).trim() : "";
				const destinationError = validateTransparentDestination(
					destPath,
					background,
				);
				if (destinationError) {
					return { success: false, output: "", error: destinationError };
				}

				const creds = loadCodexCreds();
				if ("error" in creds) {
					return { success: false, output: "", error: creds.error };
				}

				// Resolve each input image -> {image_url: data URL}. The Codex
				// /images/edits endpoint expects an array of objects, each with
				// exactly one of `image_url` or `file_id`; data URLs work for local
				// images that the backend cannot fetch directly.
				const images: Array<{ image_url: string }> = [];
				for (const inp of inputs) {
					try {
						const { buffer, mimeType } = await resolveInputImage(inp);
						images.push({
							image_url: `data:${mimeType};base64,${buffer.toString("base64")}`,
						});
					} catch (err) {
						return {
							success: false,
							output: "",
							error: `Could not load input image '${inp}': ${err instanceof Error ? err.message : String(err)}`,
						};
					}
				}

				let response: Response;
				try {
					response = await fetch(`${CODEX_BASE_URL}/images/edits`, {
						method: "POST",
						headers: codexImageHeaders(creds.accessToken, creds.accountId),
						body: JSON.stringify({
							images,
							prompt: requestPrompt,
							model,
							n,
							size,
							quality,
							...(background ? { background } : {}),
						}),
						signal: AbortSignal.timeout(180000),
					});
				} catch (err) {
					return fetchErrorResult(err, "Codex image edit request");
				}
				if (!response.ok) {
					const text = await response.text().catch(() => response.statusText);
					console.error(
						`[codex-image] edit API error ${response.status} (prompt=${prompt.slice(0, 80)}): ${text.slice(0, 300)}`,
					);
					return {
						success: false,
						output: "",
						error: `Codex image edit API error (${response.status}): ${text.slice(0, 300)}`,
					};
				}

				let json: { data?: Array<{ b64_json?: string; url?: string }> };
				try {
					json = (await response.json()) as typeof json;
				} catch (err) {
					return fetchErrorResult(err, "Codex image edit response");
				}
				const { urls, error, alphaPostProcessed } = await persistImageOutputs(
					json.data ?? [],
					{
						destPath,
						prompt,
						model,
						size,
						background,
						chromaKey,
					},
				);
				if (urls.length === 0) {
					return {
						success: false,
						output: "",
						error: error ?? "Codex image edit returned no image data.",
					};
				}
				return {
					success: true,
					output: urls.map((u, i) => `Edited image ${i + 1}: ${u}`).join("\n"),
					metadata: {
						count: urls.length,
						urls,
						model,
						prompt,
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
