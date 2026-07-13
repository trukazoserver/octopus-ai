import { randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { PathSafetyPolicy } from "../security/path-safety-policy.js";
import { resolveRelativePathInside } from "../utils/path-safety.js";
import type { ToolDefinition, ToolResult } from "./registry.js";

const MEDIA_DIR = join(homedir(), ".octopus", "media");
const MEDIA_META_PATH = join(MEDIA_DIR, "meta.json");
const MAX_SAVE_MEDIA_BASE64_BYTES = 8 * 1024 * 1024;

interface MediaMetaItem {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	createdAt: string;
	description?: string;
	metadata?: Record<string, unknown>;
}

const MIME_EXTENSIONS: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
	"audio/mpeg": ".mp3",
	"audio/wav": ".wav",
	"audio/ogg": ".ogg",
	"audio/mp4": ".m4a",
	"video/mp4": ".mp4",
	"video/webm": ".webm",
};

function guessMime(filename: string): string {
	const ext = extname(filename).toLowerCase();
	const mimeMap: Record<string, string> = {
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".webp": "image/webp",
		".svg": "image/svg+xml",
		".mp3": "audio/mpeg",
		".wav": "audio/wav",
		".ogg": "audio/ogg",
		".m4a": "audio/mp4",
		".mp4": "video/mp4",
		".webm": "video/webm",
	};
	return mimeMap[ext] ?? "application/octet-stream";
}

function ensureMediaDir(): void {
	if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });
}

let mediaMetaCache: MediaMetaItem[] | undefined;
let mediaMetaIndex = new Map<string, MediaMetaItem>();

function loadMediaMeta(): MediaMetaItem[] {
	if (mediaMetaCache) return mediaMetaCache;
	ensureMediaDir();
	try {
		const parsed = JSON.parse(readFileSync(MEDIA_META_PATH, "utf-8"));
		mediaMetaCache = Array.isArray(parsed) ? (parsed as MediaMetaItem[]) : [];
	} catch {
		mediaMetaCache = [];
	}
	mediaMetaIndex = new Map(mediaMetaCache.flatMap((item) => [[item.id, item], [item.filename, item]]));
	return mediaMetaCache;
}

function saveMediaMeta(items: MediaMetaItem[]): void {
	ensureMediaDir();
	mediaMetaCache = items;
	mediaMetaIndex = new Map(items.flatMap((item) => [[item.id, item], [item.filename, item]]));
	writeFileSync(MEDIA_META_PATH, JSON.stringify(items, null, 2), "utf-8");
}

function normalizeBase64Data(data: string): string {
	const match = data.match(/^data:[^;]+;base64,(.+)$/s);
	return match?.[1] ?? data;
}

function estimateBase64DecodedBytes(data: string): number {
	const compact = data.replace(/\s/g, "");
	const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
	return Math.floor((compact.length * 3) / 4) - padding;
}

function formatBytes(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function parseMetadata(value: unknown): Record<string, unknown> | undefined {
	if (!value) return undefined;
	if (typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	if (typeof value === "string" && value.trim()) {
		try {
			const parsed = JSON.parse(value) as unknown;
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: undefined;
		} catch {
			return { note: value.trim() };
		}
	}
	return undefined;
}

function compactMetadata(metadata?: Record<string, unknown>): string {
	if (!metadata || Object.keys(metadata).length === 0) return "";
	return Object.entries(metadata)
		.filter(
			([, value]) => value !== undefined && value !== null && value !== "",
		)
		.map(([key, value]) => `${key}=${String(value)}`)
		.join(" | ");
}

function createDefaultImportPathPolicy(): PathSafetyPolicy {
	return new PathSafetyPolicy({
		// No process.cwd(): generated/imported media must stay under the user's
		// home or ~/.octopus, never wherever the backend was launched from.
		allowedPaths: [homedir(), join(homedir(), ".octopus")],
	});
}

export const mediaContext = {
	save: async (
		buffer: Buffer,
		mimeType: string,
		description?: string,
		metadata?: Record<string, unknown>,
	) => {
		const id = randomUUID();
		const ext =
			MIME_EXTENSIONS[mimeType] ||
			extname(`file.${mimeType.split("/")[1] || "png"}`) ||
			".png";
		const filename = `${id}${ext}`;
		const filePath = join(MEDIA_DIR, filename);
		ensureMediaDir();

		writeFileSync(filePath, buffer);

		const items = loadMediaMeta();
		const item: MediaMetaItem = {
			id,
			filename,
			mimetype: mimeType,
			size: buffer.length,
			createdAt: new Date().toISOString(),
			description,
			metadata,
		};
		items.push(item);
		saveMediaMeta(items);

		return {
			...item,
			url: `/api/media/file/${filename}`,
		};
	},
	resolve: async (urlStr: string) => {
		let filename = "";
		if (urlStr.startsWith("/api/media/file/")) {
			filename = urlStr.slice("/api/media/file/".length);
		} else {
			filename = urlStr;
		}
		const filePath = resolveRelativePathInside(MEDIA_DIR, filename);
		if (!filePath) {
			throw new Error(`Media path denied by path safety policy: ${urlStr}`);
		}
		if (!existsSync(filePath)) {
			throw new Error(`Media not found: ${urlStr}`);
		}
		const buffer = readFileSync(filePath);

		loadMediaMeta();
		const item = mediaMetaIndex.get(filename) ?? mediaMetaIndex.get(filename.split(".")[0] ?? "");

		return {
			buffer,
			mimeType: item ? item.mimetype : "application/octet-stream",
		};
	},
};

export function createMediaTools(allowedPaths?: string[]): ToolDefinition[] {
	const importPathPolicy = allowedPaths
		? new PathSafetyPolicy({ allowedPaths })
		: createDefaultImportPathPolicy();
	return [
		{
			name: "save_media",
			description:
				"Save a generated media file (image, audio, video) to the Octopus AI media library. " +
				"Provide the file data as base64, a filename, and the MIME type. " +
				"Use this for small in-memory media only. For existing local files or large videos, use import_media_file instead of converting the file to base64. " +
				"Returns a URL that can be embedded in your response to display the media to the user. " +
				"Use semantic descriptions/metadata for long workflows, e.g. sceneNumber, stage, role, prompt, workflowId, and parentMediaIds, so future steps can identify the correct file.",
			parameters: {
				data: {
					type: "string",
					description:
						"Base64-encoded file data or a data URL. Keep under 8 MB decoded size; use import_media_file for larger local files.",
					required: true,
				},
				filename: {
					type: "string",
					description:
						"Original filename with extension (e.g. 'goku.png', 'speech.mp3')",
					required: true,
				},
				mimetype: {
					type: "string",
					description:
						"MIME type of the file (e.g. 'image/png', 'audio/mpeg', 'video/mp4')",
					required: true,
				},
				description: {
					type: "string",
					description:
						"Brief semantic description, e.g. 'Construction timelapse Img 03 - sobre-cimientos final keyframe'",
				},
				metadata: {
					type: "object",
					description:
						"Optional structured metadata such as workflowId, sceneNumber, imageNumber, stage, role, prompt, sourceTool, parentMediaIds.",
				},
			},
			handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
				const data = String(params.data);
				const filename = String(params.filename);
				const mimetype = String(params.mimetype);
				const description = params.description
					? String(params.description)
					: undefined;
				const metadata = parseMetadata(params.metadata);

				if (!data || !filename) {
					return {
						success: false,
						output: "",
						error: "Missing required parameters: data and filename",
					};
				}

				try {
					const normalizedData = normalizeBase64Data(data);
					const estimatedSize = estimateBase64DecodedBytes(normalizedData);
					if (estimatedSize > MAX_SAVE_MEDIA_BASE64_BYTES) {
						return {
							success: false,
							output: "",
							error: `save_media only accepts small base64 payloads up to ${formatBytes(MAX_SAVE_MEDIA_BASE64_BYTES)} decoded size. This payload is about ${formatBytes(estimatedSize)}. If the file already exists on disk, use import_media_file with its local path instead of converting it to base64.`,
						};
					}

					const id = randomUUID();
					const ext = extname(filename) || MIME_EXTENSIONS[mimetype] || "";
					const storedName = id + ext;
					const filePath = join(MEDIA_DIR, storedName);
					ensureMediaDir();

					const fileData = Buffer.from(normalizedData, "base64");
					writeFileSync(filePath, fileData);

					const items = loadMediaMeta();
					const item = {
						id,
						filename,
						mimetype,
						size: fileData.length,
						createdAt: new Date().toISOString(),
						description,
						metadata,
					};
					items.push(item);
					saveMediaMeta(items);

					const mediaUrl = `/api/media/file/${id}${ext}`;

					return {
						success: true,
						output: `Media saved successfully.\nURL: ${mediaUrl}\nFile: ${filename}\nSize: ${fileData.length} bytes\n\nTo display this in your response, use markdown: ![${description || filename}](${mediaUrl})`,
						metadata: {
							id,
							url: mediaUrl,
							filename,
							mimetype,
							size: fileData.length,
							description,
							metadata,
						},
					};
				} catch (err) {
					return {
						success: false,
						output: "",
						error: `Failed to save media: ${err instanceof Error ? err.message : String(err)}`,
					};
				}
			},
		},
		{
			name: "import_media_file",
			description:
				"Import an existing local media file into the Octopus AI media library without base64. " +
				"Use this for large generated files such as MP4 videos, ffmpeg outputs, audio, PDFs, or images that already exist on disk. " +
				"Returns a /api/media/file/... URL that can be embedded in the response. Prefer this over save_media for files larger than a few MB. Include semantic metadata for scene/image/video workflows.",
			parameters: {
				path: {
					type: "string",
					description:
						"Absolute path or ~/ path of the local file to import into the media library",
					required: true,
				},
				filename: {
					type: "string",
					description:
						"Optional display filename with extension. Defaults to the source filename.",
				},
				mimetype: {
					type: "string",
					description:
						"Optional MIME type. If omitted, it is inferred from the filename extension.",
				},
				description: {
					type: "string",
					description:
						"Brief semantic description, e.g. 'Construction timelapse scene 04 video draft'.",
				},
				metadata: {
					type: "object",
					description:
						"Optional structured metadata such as workflowId, sceneNumber, imageNumber, stage, role, prompt, sourceTool, parentMediaIds.",
				},
			},
			handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
				const inputPath = String(params.path || "").trim();
				if (!inputPath) {
					return {
						success: false,
						output: "",
						error: "Missing required parameter: path",
					};
				}

				try {
					const sourcePath = importPathPolicy.assertAllowed(
						inputPath,
						"Media import path",
					);
					if (!existsSync(sourcePath)) {
						return {
							success: false,
							output: "",
							error: `File not found: ${sourcePath}`,
						};
					}
					const stats = statSync(sourcePath);
					if (!stats.isFile()) {
						return {
							success: false,
							output: "",
							error: `Path is not a file: ${sourcePath}`,
						};
					}

					const displayName = params.filename
						? String(params.filename)
						: basename(sourcePath);
					const mimetype = params.mimetype
						? String(params.mimetype)
						: guessMime(displayName || sourcePath);
					const ext = extname(displayName) || MIME_EXTENSIONS[mimetype] || "";
					const id = randomUUID();
					const storedName = id + ext;
					const filePath = join(MEDIA_DIR, storedName);
					ensureMediaDir();
					copyFileSync(sourcePath, filePath);

					const items = loadMediaMeta();
					const item: MediaMetaItem = {
						id,
						filename: displayName,
						mimetype,
						size: stats.size,
						createdAt: new Date().toISOString(),
						description: params.description
							? String(params.description)
							: undefined,
						metadata: parseMetadata(params.metadata),
					};
					items.push(item);
					saveMediaMeta(items);

					const mediaUrl = `/api/media/file/${storedName}`;
					return {
						success: true,
						output: `Media imported successfully.\nURL: ${mediaUrl}\nFile: ${displayName}\nMIME: ${mimetype}\nSize: ${stats.size} bytes\n\nTo display this in your response, use markdown: ![${item.description || displayName}](${mediaUrl})`,
						metadata: {
							...item,
							url: mediaUrl,
							sourcePath,
						},
					};
				} catch (err) {
					return {
						success: false,
						output: "",
						error: `Failed to import media file: ${err instanceof Error ? err.message : String(err)}`,
					};
				}
			},
		},
		{
			name: "list_media",
			description:
				"List all saved media files in the Octopus AI media library. " +
				"Use this to find previously generated or uploaded images, audio, and video files. " +
				"Returns a list of media items with their URLs, filenames, types, and descriptions. " +
				"You can optionally filter by type (image, audio, video) or search by description/filename.",
			parameters: {
				type: {
					type: "string",
					description:
						"Filter by media type prefix: 'image', 'audio', 'video', or leave empty for all",
				},
				search: {
					type: "string",
					description:
						"Search term to filter by filename, description, or metadata (case-insensitive)",
				},
				limit: {
					type: "number",
					description: "Maximum number of results to return (default 20)",
				},
			},
			handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
				try {
					const items = loadMediaMeta();
					let filtered = items;

					const typeFilter = params.type
						? String(params.type).toLowerCase()
						: "";
					if (typeFilter) {
						filtered = filtered.filter((i) =>
							i.mimetype?.startsWith(typeFilter),
						);
					}

					const search = params.search
						? String(params.search).toLowerCase()
						: "";
					if (search) {
						filtered = filtered.filter(
							(i) =>
								i.filename?.toLowerCase().includes(search) ||
								i.description?.toLowerCase().includes(search) ||
								JSON.stringify(i.metadata ?? {})
									.toLowerCase()
									.includes(search),
						);
					}

					const limit = params.limit ? Number(params.limit) : 20;
					const result = filtered.slice(-limit).reverse();

					if (result.length === 0) {
						return {
							success: true,
							output: "No media files found matching your criteria.",
						};
					}

					const listing = result
						.map((i) => {
							const ext = MIME_EXTENSIONS[i.mimetype] || "";
							const url = `/api/media/file/${i.id}${ext}`;
							const metadata = compactMetadata(i.metadata);
							return [
								`- ${i.description || i.filename || i.id}`,
								`  URL: ${url}`,
								`  File: ${i.filename} | Type: ${i.mimetype} | Size: ${i.size} bytes | Created: ${i.createdAt}`,
								metadata ? `  Metadata: ${metadata}` : "",
							]
								.filter(Boolean)
								.join("\n");
						})
						.join("\n");

					return {
						success: true,
						output: `Found ${result.length} media file(s):\n${listing}\n\nTo use any of these in your response, use markdown: ![description](URL)`,
						metadata: {
							items: result.map((i) => {
								const ext = MIME_EXTENSIONS[i.mimetype] || "";
								return { ...i, url: `/api/media/file/${i.id}${ext}` };
							}),
						},
					};
				} catch (err) {
					return {
						success: false,
						output: "",
						error: `Failed to list media: ${err instanceof Error ? err.message : String(err)}`,
					};
				}
			},
		},
	];
}
