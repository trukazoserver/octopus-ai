import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import type { ToolDefinition, ToolResult } from "./registry.js";

const MEDIA_DIR = join(homedir(), ".octopus", "media");
const MEDIA_META_PATH = join(MEDIA_DIR, "meta.json");

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

function ensureMediaDir(): void {
	if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });
}

function loadMediaMeta(): unknown[] {
	ensureMediaDir();
	try {
		return JSON.parse(readFileSync(MEDIA_META_PATH, "utf-8"));
	} catch {
		return [];
	}
}

function saveMediaMeta(items: unknown[]): void {
	ensureMediaDir();
	writeFileSync(MEDIA_META_PATH, JSON.stringify(items, null, 2), "utf-8");
}

function normalizeBase64Data(data: string): string {
	const match = data.match(/^data:[^;]+;base64,(.+)$/s);
	return match?.[1] ?? data;
}

export const mediaContext = {
	save: async (buffer: Buffer, mimeType: string, description?: string) => {
		const id = randomUUID();
		const ext = MIME_EXTENSIONS[mimeType] || extname(`file.${mimeType.split("/")[1] || "png"}`) || ".png";
		const filename = `${id}${ext}`;
		const filePath = join(MEDIA_DIR, filename);
		ensureMediaDir();

		writeFileSync(filePath, buffer);

		const items = loadMediaMeta();
		const item = {
			id,
			filename,
			mimetype: mimeType,
			size: buffer.length,
			createdAt: new Date().toISOString(),
			description,
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(items as any[]).push(item);
		saveMediaMeta(items);

		return {
			...item,
			url: `/api/media/file/${filename}`
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
		
		const items = loadMediaMeta() as any[];
		const item = items.find(i => i.filename === filename || i.id === filename || urlStr.includes(i.id));
		
		return {
			buffer,
			mimeType: item ? item.mimetype : "application/octet-stream"
		};
	}
};

export function createMediaTools(): ToolDefinition[] {
	return [
		{
			name: "save_media",
			description:
				"Save a generated media file (image, audio, video) to the Octopus AI media library. " +
				"Provide the file data as base64, a filename, and the MIME type. " +
				"Returns a URL that can be embedded in your response to display the media to the user. " +
				"Use this whenever you generate or create an image, audio, or video file.",
			parameters: {
				data: {
					type: "string",
					description: "Base64-encoded file data or a data URL",
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
					const id = randomUUID();
					const ext = extname(filename) || MIME_EXTENSIONS[mimetype] || "";
					const storedName = id + ext;
					const filePath = join(MEDIA_DIR, storedName);
					ensureMediaDir();

					const fileData = Buffer.from(normalizeBase64Data(data), "base64");
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
					const items = loadMediaMeta() as any[];
					let filtered = items;

					const typeFilter = params.type ? String(params.type).toLowerCase() : "";
					if (typeFilter) {
						filtered = filtered.filter(
							(i) => i.mimetype && i.mimetype.startsWith(typeFilter),
						);
					}

					const search = params.search ? String(params.search).toLowerCase() : "";
					if (search) {
						filtered = filtered.filter(
							(i) =>
								(i.filename && i.filename.toLowerCase().includes(search)) ||
								(i.description && i.description.toLowerCase().includes(search)),
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
