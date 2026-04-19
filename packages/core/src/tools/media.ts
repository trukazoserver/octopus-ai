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
	];
}
