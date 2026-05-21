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
import { basename, extname, join, resolve, sep } from "node:path";
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

function loadMediaMeta(): MediaMetaItem[] {
	ensureMediaDir();
	try {
		const parsed = JSON.parse(readFileSync(MEDIA_META_PATH, "utf-8"));
		return Array.isArray(parsed) ? (parsed as MediaMetaItem[]) : [];
	} catch {
		return [];
	}
}

function saveMediaMeta(items: MediaMetaItem[]): void {
	ensureMediaDir();
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

function expandHome(filePath: string): string {
	if (filePath === "~") return homedir();
	if (filePath.startsWith(`~${sep}`) || filePath.startsWith("~/")) {
		return join(homedir(), filePath.slice(2));
	}
	return filePath;
}

function isPathInside(child: string, parent: string): boolean {
	return child === parent || child.startsWith(`${parent}${sep}`);
}

function resolveImportPath(filePath: string): string {
	const resolved = resolve(expandHome(filePath));
	const allowedRoots = [
		homedir(),
		join(homedir(), ".octopus"),
		process.cwd(),
	].map((root) => resolve(root));
	if (!allowedRoots.some((root) => isPathInside(resolved, root))) {
		throw new Error(
			`Access denied: path '${resolved}' is not within allowed paths`,
		);
	}
	return resolved;
}

export const mediaContext = {
	save: async (buffer: Buffer, mimeType: string, description?: string) => {
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
		const filePath = join(MEDIA_DIR, filename);
		if (!existsSync(filePath)) {
			throw new Error(`Media not found: ${urlStr}`);
		}
		const buffer = readFileSync(filePath);

		const items = loadMediaMeta();
		const item = items.find(
			(i) =>
				i.filename === filename || i.id === filename || urlStr.includes(i.id),
		);

		return {
			buffer,
			mimeType: item ? item.mimetype : "application/octet-stream",
		};
	},
};

export function createMediaTools(): ToolDefinition[] {
	return [
		{
			name: "save_media",
			description:
				"Save a generated media file (image, audio, video) to the Octopus AI media library. " +
				"Provide the file data as base64, a filename, and the MIME type. " +
				"Use this for small in-memory media only. For existing local files or large videos, use import_media_file instead of converting the file to base64. " +
				"Returns a URL that can be embedded in your response to display the media to the user. " +
				"Use this whenever you generate or create an image, audio, or video file.",
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
					description: "Brief description of the media content",
				},
			},
			handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
				const data = String(params.data);
				const filename = String(params.filename);
				const mimetype = String(params.mimetype);
				const description = params.description
					? String(params.description)
					: undefined;

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
				"Returns a /api/media/file/... URL that can be embedded in the response. Prefer this over save_media for files larger than a few MB.",
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
					description: "Brief description of the media content",
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
					const sourcePath = resolveImportPath(inputPath);
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
						"Search term to filter by filename or description (case-insensitive)",
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
								i.description?.toLowerCase().includes(search),
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
							return `- ${i.description || i.filename || i.id}\n  URL: ${url}\n  Type: ${i.mimetype} | Size: ${i.size} bytes | Created: ${i.createdAt}`;
						})
						.join("\n");

					return {
						success: true,
						output: `Found ${result.length} media file(s):\n${listing}\n\nTo use any of these in your response, use markdown: ![description](URL)`,
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
