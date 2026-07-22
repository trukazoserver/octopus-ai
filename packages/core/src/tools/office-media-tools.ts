import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import AdmZip from "adm-zip";
import {
	assertRealPathInside,
	expandHome,
	isPathInsideAny,
} from "../utils/path-safety.js";
import type { ToolDefinition, ToolResult } from "./registry.js";
import { getOfflineTessdataPath } from "./ocr-language-data.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"]);
const MAX_ARCHIVE_BYTES = 150 * 1024 * 1024;
const MAX_MEDIA_FILES = 500;
const MAX_MEDIA_BYTES = 12 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;
const MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
const MAX_OCR_FILES = 25;
const OCR_TIMEOUT_MS = 25_000;
const OCR_CACHE_DIR = path.join(os.homedir(), ".octopus", "cache", "ocr", "office-media");
const MEDIA_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>`;

export function createOfficeMediaTools(
	allowedPaths: string[],
	workspaceDir: string = path.join(os.homedir(), ".octopus", "workspace"),
): ToolDefinition[] {
	const roots = allowedPaths.map((root) => path.resolve(expandHome(root)));
	const resolve = (raw: string) => {
		const expanded = expandHome(raw);
		if (path.isAbsolute(expanded)) return path.resolve(expanded);
		const resolved = path.resolve(workspaceDir, expanded);
		if (!isPathInsideAny(resolved, [workspaceDir])) throw new Error(`Relative path escapes workspace: ${raw}`);
		return resolved;
	};
	const authorize = async (resolved: string) => {
		if (!isPathInsideAny(resolved, roots)) throw new Error(`Access denied: ${resolved}`);
		await assertRealPathInside(resolved, roots);
	};
	const authorizeOutput = async (resolved: string) => {
		await authorize(resolved);
		await mkdir(resolved, { recursive: true });
		await authorize(resolved);
	};

	return [
		{
			name: "office_extract_media",
			description:
				"List or extract images embedded in DOCX, PPTX, and XLSX files. Optionally OCR image text locally (Spanish + English), cache results, and filter OCR results by a query. Use when information may be inside screenshots, scans, diagrams, or rasterized tables embedded in Office files.",
			uiIcon: MEDIA_SVG,
			managesOwnPathPolicy: true,
			longRunning: true,
			parameters: {
				path: { type: "string", description: "Input DOCX, PPTX, or XLSX path", required: true },
				outputDir: { type: "string", description: "Optional directory where embedded media will be extracted", required: false },
				ocr: { type: "boolean", description: "Run OCR on supported images, default false", required: false },
				query: { type: "string", description: "Optional text to search inside OCR results", required: false },
				maxFiles: { type: "number", description: "Maximum media files returned, default 100, max 500", required: false },
				maxOcrFiles: { type: "number", description: "Maximum images OCRed, default 10, max 25", required: false },
			},
			handler: async (params, context): Promise<ToolResult> => {
				try {
					const inputPath = resolve(requiredString(params.path, "path"));
					await authorize(inputPath);
					const buffer = await readFile(inputPath);
					if (buffer.length > MAX_ARCHIVE_BYTES) throw new Error("Office package exceeds media extraction size limit");
					const ext = path.extname(inputPath).toLowerCase();
					const mediaPrefix = ext === ".docx" ? "word/media/" : ext === ".pptx" ? "ppt/media/" : ext === ".xlsx" ? "xl/media/" : "";
					if (!mediaPrefix) throw new Error("office_extract_media supports DOCX, PPTX, and XLSX only");
					const zip = new AdmZip(buffer);
					const allEntries = zip.getEntries();
					if (allEntries.length > MAX_ZIP_ENTRIES) throw new Error("Office package has too many ZIP entries");
					let uncompressed = 0;
					for (const entry of allEntries) {
						if (entry.entryName.split("/").includes("..") || path.posix.isAbsolute(entry.entryName)) throw new Error(`Unsafe ZIP entry: ${entry.entryName}`);
						uncompressed += entry.header.size;
						if (uncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error("Office package is too large when decompressed");
					}
					const maxFiles = clampInt(params.maxFiles, 1, MAX_MEDIA_FILES, 100);
					const entries = allEntries.filter((entry) => entry.entryName.startsWith(mediaPrefix) && !entry.isDirectory).slice(0, maxFiles);
					const outputDirRaw = optionalString(params.outputDir);
					const outputDir = outputDirRaw ? resolve(outputDirRaw) : undefined;
					if (outputDir) await authorizeOutput(outputDir);
					const shouldOcr = params.ocr === true || Boolean(optionalString(params.query));
					const maxOcrFiles = clampInt(params.maxOcrFiles, 1, MAX_OCR_FILES, 10);
					const query = optionalString(params.query);
					const results: Array<Record<string, unknown>> = [];
					let ocrCount = 0;
					for (const [index, entry] of entries.entries()) {
						if (entry.header.size > MAX_MEDIA_BYTES) {
							results.push({ ref: `${ext.slice(1)}:media:${index + 1}`, entry: entry.entryName, size: entry.header.size, skipped: "media file exceeds size limit" });
							continue;
						}
						const data = entry.getData();
						const filename = safeFilename(path.posix.basename(entry.entryName), index);
						const mediaExt = path.extname(filename).toLowerCase();
						const ref = `${ext.slice(1)}:media:${encodeURIComponent(filename)}`;
						let extractedPath: string | undefined;
						if (outputDir) {
							extractedPath = path.join(outputDir, filename);
							await authorize(extractedPath);
							await writeFile(extractedPath, data);
						}
						let ocrText = "";
						let ocrError: string | undefined;
						if (shouldOcr && IMAGE_EXTENSIONS.has(mediaExt) && data.length <= MAX_MEDIA_BYTES && ocrCount < maxOcrFiles) {
							context?.onProgress?.(`OCR embedded image ${ocrCount + 1}/${Math.min(maxOcrFiles, entries.length)}`);
							try {
								ocrText = await cachedImageOcr(data);
							} catch (error) {
								ocrError = error instanceof Error ? error.message : String(error);
							}
							ocrCount++;
						}
						if (query && !normalize(ocrText).includes(normalize(query))) continue;
						results.push({
							ref,
							entry: entry.entryName,
							filename,
							size: data.length,
							sha256: createHash("sha256").update(data).digest("hex"),
							extractedPath,
							ocrText: ocrText || undefined,
							ocrError,
						});
					}
					return {
						success: true,
						output: JSON.stringify({
							operation: "office_extract_media",
							file: inputPath,
							mediaCount: entries.length,
							returned: results.length,
							ocrProcessed: ocrCount,
							query,
							items: results,
						}, null, 2),
						metadata: { mediaCount: entries.length, returned: results.length, ocrProcessed: ocrCount },
					};
				} catch (error) {
					return { success: false, output: "", error: error instanceof Error ? error.message : String(error) };
				}
			},
		},
	];
}

async function cachedImageOcr(buffer: Buffer): Promise<string> {
	const hash = createHash("sha256").update(buffer).digest("hex");
	const cachePath = path.join(OCR_CACHE_DIR, `${hash}.txt`);
	const cached = await readFile(cachePath, "utf8").catch(() => "");
	if (cached) return cached;
	const { default: sharp } = await import("sharp");
	const { createWorker } = await import("tesseract.js");
	const image = await sharp(buffer, { animated: false })
		.rotate()
		.resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
		.grayscale()
		.normalize()
		.png()
		.toBuffer();
	const worker = await createWorker(["spa", "eng"], 1, {
		logger: () => {},
		langPath: getOfflineTessdataPath(),
		cachePath: path.join(os.homedir(), ".octopus", "tesseract-cache"),
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const text = await Promise.race([
			worker.recognize(image).then((result) => result.data.text.trim()),
			new Promise<string>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Embedded image OCR timed out")), OCR_TIMEOUT_MS);
			}),
		]);
		if (text) {
			await mkdir(OCR_CACHE_DIR, { recursive: true });
			await writeFile(cachePath, text, "utf8");
		}
		return text;
	} finally {
		if (timer) clearTimeout(timer);
		await worker.terminate().catch(() => {});
	}
}

function safeFilename(filename: string, index: number): string {
	const cleaned = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
	return cleaned || `media-${index + 1}.bin`;
}

function requiredString(value: unknown, name: string): string {
	const text = typeof value === "string" ? value.trim() : "";
	if (!text) throw new Error(`Missing required parameter '${name}'`);
	return text;
}

function optionalString(value: unknown): string | undefined {
	const text = typeof value === "string" ? value.trim() : "";
	return text || undefined;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalize(value: string): string {
	let result = "";
	for (const char of value.normalize("NFD")) {
		const code = char.charCodeAt(0);
		if (code < 0x0300 || code > 0x036f) result += char;
	}
	return result.toLowerCase();
}
