/**
 * Document extraction for chat attachments.
 *
 * When a user attaches a file, its text content is extracted and
 * inlined into the model's context so the model can read it directly (no tool
 * round-trip required). Heavy parsers (xlsx, officeparser, adm-zip, PDF.js) are
 * imported lazily inside the branch that needs them, so startup stays fast and a
 * missing optional dependency can't crash unrelated extractions.
 *
 * All parsers used here are pure JavaScript (no native build), which keeps the
 * Windows install native-build-free.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { PdfReader } from "./pdf-reader.js";
import { getOfflineTessdataPath } from "./ocr-language-data.js";

export type DocumentKind =
	| "text"
	| "code"
	| "pdf"
	| "spreadsheet"
	| "document"
	| "archive"
	| "image"
	| "media"
	| "unknown";

const TEXT_EXTS = new Set([
	".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml",
	".html", ".htm", ".log", ".ini", ".env", ".toml",
]);
const CODE_EXTS = new Set([
	".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java",
	".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".cs", ".php", ".rb", ".pl",
	".sh", ".bash", ".zsh", ".lua", ".swift", ".kt", ".kts", ".scala", ".r",
	".vue", ".svelte", ".css", ".scss", ".sass", ".less", ".dart", ".clj",
	".ex", ".exs", ".erl", ".hs", ".jl", ".nim", ".v", ".sv",
]);
const SHEET_EXTS = new Set([".xls", ".xlsx", ".ods"]);
const DOC_EXTS = new Set([".docx", ".doc", ".pptx", ".ppt", ".odt", ".odp", ".rtf"]);
const ARCHIVE_EXTS = new Set([".zip"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);
const MEDIA_EXTS = new Set([
	".mp3", ".wav", ".ogg", ".m4a", ".mp4", ".webm", ".mov", ".ogv",
]);

/** Map of file extension -> markdown fence language hint, for nicer rendering. */
const CODE_LANG: Record<string, string> = {
	".js": "javascript", ".jsx": "jsx", ".mjs": "javascript", ".cjs": "javascript",
	".ts": "typescript", ".tsx": "tsx",
	".py": "python", ".rs": "rust", ".go": "go", ".java": "java",
	".c": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".h": "c", ".hpp": "cpp",
	".cs": "csharp", ".php": "php", ".rb": "ruby", ".pl": "perl",
	".sh": "bash", ".bash": "bash", ".zsh": "bash", ".lua": "lua",
	".swift": "swift", ".kt": "kotlin", ".kts": "kotlin", ".scala": "scala",
	".r": "r", ".vue": "vue", ".svelte": "svelte",
	".css": "css", ".scss": "scss", ".sass": "sass", ".less": "less",
	".dart": "dart", ".clj": "clojure", ".ex": "elixir", ".exs": "elixir",
	".erl": "erlang", ".hs": "haskell", ".jl": "julia", ".json": "json",
	".xml": "xml", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
	".html": "html", ".htm": "html", ".sql": "sql", ".md": "markdown",
	".csv": "csv", ".tsv": "csv",
};

export function guessDocumentKind(filename: string): DocumentKind {
	const ext = extname(filename).toLowerCase();
	if (IMAGE_EXTS.has(ext)) return "image";
	if (MEDIA_EXTS.has(ext)) return "media";
	if (CODE_EXTS.has(ext)) return "code";
	if (SHEET_EXTS.has(ext)) return "spreadsheet";
	if (ext === ".pdf") return "pdf";
	if (DOC_EXTS.has(ext)) return "document";
	if (ARCHIVE_EXTS.has(ext)) return "archive";
	if (TEXT_EXTS.has(ext)) return "text";
	return "unknown";
}

export function fenceLangFor(filename: string): string | undefined {
	return CODE_LANG[extname(filename).toLowerCase()];
}

export const MAX_DOC_CHARS = 20000;
export const MAX_TOTAL_DOC_CHARS = 60000;
const PDF_INGEST_MAX_PAGES = 20;
const MAX_TEXT_READ_BYTES = 2 * 1024 * 1024; // bound memory for large text/code files
const IMAGE_OCR_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_OCR_TIMEOUT_MS = 12_000;
const IMAGE_OCR_LANGS = ["spa", "eng"];
const IMAGE_OCR_CACHE_DIR = join(homedir(), ".octopus", "cache", "ocr");
const CACHE_MAX_ENTRIES = 50;

export interface ExtractResult {
	kind: DocumentKind;
	text: string;
	truncated: boolean;
}

interface CacheEntry {
	text: string;
	kind: DocumentKind;
	mtimeMs: number;
	truncated: boolean;
}
const extractCache = new Map<string, CacheEntry>();

/**
 * Extract a readable text representation of a document stored at `localPath`.
 * `filename` (the original name with extension) drives type detection. Results
 * are cached per file+mtime so repeated turns don't re-parse the same attachment.
 *
 * Never throws: on failure returns a short note telling the model to use a tool.
 */
export async function extractDocumentText(
	localPath: string,
	filename: string,
): Promise<ExtractResult> {
	const kind = guessDocumentKind(filename);
	if (kind === "media" || kind === "unknown") {
		return { kind, text: "", truncated: false };
	}

	let mtimeMs = 0;
	try {
		mtimeMs = (await stat(localPath)).mtimeMs;
	} catch {
		/* proceed; extraction will likely fail and return a note */
	}
	const cached = extractCache.get(localPath);
	if (cached && cached.mtimeMs === mtimeMs) {
		return { kind: cached.kind, text: cached.text, truncated: cached.truncated };
	}

	let text = "";
	let truncated = false;
	try {
		switch (kind) {
			case "text":
			case "code":
				text = await readBoundedText(localPath);
				break;
			case "pdf":
				text = await extractPdf(localPath);
				break;
			case "spreadsheet":
				text = await extractSpreadsheet(localPath);
				break;
			case "document":
				text = await extractOfficeDoc(localPath);
				break;
			case "archive":
				text = await extractArchiveListing(localPath);
				break;
			case "image":
				text = await extractImageText(localPath, filename, mtimeMs);
				break;
		}
	} catch (err) {
		text = `[No se pudo leer automáticamente el archivo ${filename}: ${
			err instanceof Error ? err.message : String(err)
		}. NO intentes instalar paquetes ni ejecutar código para procesarlo tú mismo. Si necesitas su contenido, pide al usuario que lo exporte a texto/CSV/PDF, o usa el tool pdf_read sólo si es un PDF.]`;
	}

	if (text.length > MAX_DOC_CHARS) {
		truncated = true;
		text = `${text.slice(0, MAX_DOC_CHARS)}\n...[contenido truncado a ${MAX_DOC_CHARS} caracteres]`;
	}

	// Bounded LRU-ish eviction (Map preserves insertion order).
	if (extractCache.size >= CACHE_MAX_ENTRIES) {
		const firstKey = extractCache.keys().next().value;
		if (firstKey) extractCache.delete(firstKey);
	}
	extractCache.set(localPath, { text, kind, mtimeMs, truncated });
	return { kind, text, truncated };
}

async function readBoundedText(localPath: string): Promise<string> {
	const info = await stat(localPath);
	if (info.size <= MAX_TEXT_READ_BYTES) {
		return readFile(localPath, "utf8");
	}
	// Large text file: read only the leading slice to bound memory.
	const handle = await open(localPath, "r");
	try {
		const buf = Buffer.alloc(MAX_TEXT_READ_BYTES);
		const { bytesRead } = await handle.read(buf, 0, MAX_TEXT_READ_BYTES, 0);
		return `${buf.subarray(0, bytesRead).toString("utf8")}\n...[archivo grande; sólo se cargaron los primeros ${Math.round(MAX_TEXT_READ_BYTES / 1024)} KB]`;
	} finally {
		await handle.close();
	}
}

interface XlsxModule {
	read: (
		data: Buffer,
		opts?: Record<string, unknown>,
	) => { SheetNames: string[]; Sheets: Record<string, unknown> };
	utils: { sheet_to_csv: (ws: unknown) => string };
}

interface OfficeParserConvertModule {
	convert?: (
		file: string | Buffer,
		destination: string,
	) => Promise<{ value: unknown }>;
	default?: OfficeParserConvertModule;
}

async function extractPdf(localPath: string): Promise<string> {
	const buf = await readFile(localPath);
	const reader = new PdfReader({});
	const res = await reader.extract(buf, {
		ocr: "auto",
		pages: `1-${PDF_INGEST_MAX_PAGES}`,
	});
	const capped =
		res.totalPages > PDF_INGEST_MAX_PAGES
			? ` (mostrando las primeras ${PDF_INGEST_MAX_PAGES} de ${res.totalPages} páginas)`
			: ` (${res.totalPages} páginas)`;
	return `PDF${capped}\n${res.text}`;
}

async function extractImageText(
	localPath: string,
	filename: string,
	mtimeMs: number,
): Promise<string> {
	const ext = extname(filename).toLowerCase();
	if (ext === ".svg") {
		return extractSvgText(await readBoundedText(localPath));
	}

	const info = await stat(localPath);
	if (info.size > IMAGE_OCR_MAX_BYTES) return "";

	const cachePath = imageOcrCachePath(localPath, info.size, mtimeMs);
	const cached = await readFile(cachePath, "utf8").catch(() => "");
	if (cached) return cached;

	const text = await runImageOcr(localPath).catch(() => "");
	const trimmed = cleanOcrText(text);
	if (!trimmed) return "";

	const output = `OCR de imagen (${filename})\n${trimmed}`;
	await mkdir(IMAGE_OCR_CACHE_DIR, { recursive: true }).catch(() => {});
	await writeFile(cachePath, output, "utf8").catch(() => {});
	return output;
}

function imageOcrCachePath(localPath: string, size: number, mtimeMs: number): string {
	const key = createHash("sha256")
		.update(`${localPath}\n${size}\n${mtimeMs}\n${IMAGE_OCR_LANGS.join("+")}`)
		.digest("hex")
		.slice(0, 32);
	return join(IMAGE_OCR_CACHE_DIR, `${key}.txt`);
}

async function runImageOcr(localPath: string): Promise<string> {
	const { default: sharp } = await import("sharp");
	const { createWorker } = await import("tesseract.js");
	const input = await sharp(localPath, { animated: false })
		.rotate()
		.resize({
			width: 2200,
			height: 2200,
			fit: "inside",
			withoutEnlargement: true,
		})
		.grayscale()
		.normalize()
		.png()
		.toBuffer();

	const worker = await createWorker(IMAGE_OCR_LANGS, 1, {
		logger: () => {},
		langPath: getOfflineTessdataPath(),
		cachePath: join(homedir(), ".octopus", "tesseract-cache"),
	});
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			worker.recognize(input).then(({ data }) => data?.text ?? ""),
			new Promise<string>((_, reject) => {
				timeout = setTimeout(() => {
					void worker.terminate();
					reject(new Error("Image OCR timed out"));
				}, IMAGE_OCR_TIMEOUT_MS);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
		await worker.terminate().catch(() => {});
	}
}

function cleanOcrText(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.join("\n")
		.trim();
}

function extractSvgText(svg: string): string {
	return svg
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

async function extractSpreadsheet(localPath: string): Promise<string> {
	// SheetJS exposes `read`/`utils` on the module namespace (and additionally
	// `readFile` under `.default`). Read from a buffer via `read`, which covers
	// both legacy .xls (BIFF) and .xlsx/ods.
	const mod = (await import("xlsx")) as XlsxModule & {
		default?: XlsxModule;
	};
	const XLSX: XlsxModule = mod.default ?? mod;
	const buf = await readFile(localPath);
	const wb = XLSX.read(buf, { type: "buffer" });
	const parts: string[] = [];
	for (const name of wb.SheetNames) {
		const ws = wb.Sheets[name];
		if (!ws) continue;
		parts.push(`=== Hoja: ${name} ===\n${XLSX.utils.sheet_to_csv(ws)}`);
	}
	return parts.join("\n\n") || "[hoja de cálculo vacía]";
}

async function extractOfficeDoc(localPath: string): Promise<string> {
	// officeparser v7 API: convert(file, destination) -> { value }. Handles
	// docx/doc, pptx/ppt, odt/odp/ods, rtf. Pass the file PATH (not a buffer) so
	// the type is inferred from the extension — magic-byte detection from a
	// buffer fails for several formats (rtf/doc/odt). "text" yields plain text.
	const mod = (await import("officeparser")) as unknown as OfficeParserConvertModule;
	const convert = mod.convert ?? mod.default?.convert;
	if (!convert) throw new Error("officeparser.convert no disponible");
	const result = await convert(localPath, "text");
	const value = result?.value;
	const text = typeof value === "string" ? value : String(value ?? "");
	return text.trim() || "[documento sin texto extraíble]";
}

async function extractArchiveListing(localPath: string): Promise<string> {
	const AdmZipModule = (await import("adm-zip")) as unknown as {
		default: new (path: string) => {
			getEntries: () => Array<{ entryName: string; header: { size: number } }>;
		};
	};
	const AdmZip = AdmZipModule.default;
	const zip = new AdmZip(localPath);
	const entries = zip
		.getEntries()
		.map((e) => `${e.entryName} (${e.header.size} bytes)`);
	return `Archivo ZIP con ${entries.length} entradas:\n${entries.join("\n")}`;
}
