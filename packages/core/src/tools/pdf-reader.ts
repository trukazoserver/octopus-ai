/**
 * PdfReader — extract text from PDFs (native text layer) with an optional OCR
 * fallback for scanned/image-only PDFs.
 *
 * Why this exists: the browser can navigate to a PDF but Chromium's built-in
 * PDF viewer (PDFium) does not expose the text in the DOM, so the agent could
 * "see" a PDF but not read it. This tool downloads/reads the PDF and extracts
 * its text directly via PDF.js. When the text layer is empty (scanned PDF) and
 * OCR is enabled, it rasterizes pages (PDF.js + @napi-rs/canvas) and runs
 * Tesseract.js. The OCR path degrades gracefully: if the `@napi-rs/canvas` module
 * is unavailable, OCR is skipped and the (possibly empty) text is returned with
 * a clear note, so text-PDF reading always works.
 */
import { readFile, mkdir } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import {
	UrlSafetyPolicy,
	type UrlSafetyPolicyConfig,
} from "../security/url-safety.js";
import type { ToolDefinition, ToolResult } from "./registry.js";

const require = createRequire(import.meta.url);

const PDF_SVG =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';
const MAX_PDF_BYTES = 60 * 1024 * 1024; // 60 MB
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DOWNLOAD_MAX_REDIRECTS = 5;
const OCR_DEFAULT_LANGS = ["spa", "eng"];
const OCR_DEFAULT_MAX_PAGES = 5;
const OCR_RENDER_SCALE = 2;
const SPARSE_TEXT_THRESHOLD = 50; // chars below which a page is "image-only"

export interface PdfReaderConfig {
	urlPolicy?: UrlSafetyPolicyConfig;
	/** Restrict local-file reads to these roots (absolute paths). */
	allowedLocalRoots?: string[];
	ocrLanguages?: string[];
	ocrMaxPages?: number;
	/** Where Tesseract.js caches its traineddata. Defaults to ~/.octopus/tesseract-cache. */
	tesseractCachePath?: string;
}

export interface PdfPageResult {
	page: number;
	text: string;
	ocrUsed: boolean;
}

export interface PdfExtractionResult {
	totalPages: number;
	pages: PdfPageResult[];
	text: string;
	ocrUsed: boolean;
	ocrSkippedReason?: string;
}

// --- lazy, isolated loaders (heavy modules; OCR path is optional) ---

// PDF.js types are awkward to resolve for the deep legacy import in v6; we use
// it through a loose any to avoid coupling the build to its .d.ts layout.
type PdfjsLike = {
	GlobalWorkerOptions: { workerSrc: string };
	getDocument(params: Record<string, unknown>): { promise: Promise<PdfjsDocLike> };
};
type PdfjsDocLike = {
	numPages: number;
	getPage(n: number): Promise<PdfjsPageLike>;
	cleanup?: () => Promise<void>;
	destroy?: () => Promise<void>;
};
type PdfjsPageLike = {
	getViewport(opts: { scale: number }): { width: number; height: number };
	getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
	render(params: Record<string, unknown>): { promise: Promise<void> };
};

let pdfjsPromise: Promise<PdfjsLike> | undefined;
async function getPdfjs(): Promise<PdfjsLike> {
	if (!pdfjsPromise) {
		pdfjsPromise = (async () => {
			const mod = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as {
				default?: PdfjsLike;
			} & PdfjsLike;
			const pdfjs: PdfjsLike = mod.default ?? (mod as unknown as PdfjsLike);
			try {
				const workerPath = require.resolve(
					"pdfjs-dist/legacy/build/pdf.worker.mjs",
				);
				pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
			} catch {
				// If the worker file can't be resolved, PDF.js will fall back to a
				// fake worker on the main thread (slower, but still functional).
			}
			return pdfjs;
		})();
	}
	return pdfjsPromise;
}

/** Load the @napi-rs/canvas module; returns null when it is not available. */
async function loadCanvas(): Promise<{
	createCanvas: (w: number, h: number) => unknown;
} | null> {
	try {
		const mod = (await import("@napi-rs/canvas")) as unknown as {
			createCanvas?: (w: number, h: number) => unknown;
			default?: { createCanvas: (w: number, h: number) => unknown };
		};
		if (typeof mod.createCanvas === "function") {
			return { createCanvas: mod.createCanvas };
		}
		if (mod.default && typeof mod.default.createCanvas === "function") {
			return mod.default;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Minimal canvas factory bridging PDF.js rendering to @napi-rs/canvas, so PDF pages
 * can be rasterized for OCR. Lives entirely in the optional OCR path.
 */
class NodeCanvasFactory {
	constructor(private canvasMod: unknown) {}

	create(width: number, height: number): {
		canvas: { width: number; height: number; toBuffer: (t: string) => Buffer };
		context: unknown;
	} {
		const mod = this.canvasMod as { createCanvas: (w: number, h: number) => any };
		const canvas = mod.createCanvas(width, height);
		return { canvas, context: canvas.getContext("2d") };
	}

	reset(contextAndCanvas: { canvas: { width: number; height: number } }, width: number, height: number): void {
		contextAndCanvas.canvas.width = width;
		contextAndCanvas.canvas.height = height;
	}

	destroy(contextAndCanvas: { canvas: { width: number; height: number } }): void {
		contextAndCanvas.canvas.width = 0;
		contextAndCanvas.canvas.height = 0;
	}
}

// --- core ---

export class PdfReader {
	private urlSafetyPolicy: UrlSafetyPolicy;
	private allowedLocalRoots: string[];
	private ocrLanguages: string[];
	private ocrMaxPages: number;
	private tesseractCachePath: string;

	constructor(config: PdfReaderConfig = {}) {
		this.urlSafetyPolicy = new UrlSafetyPolicy(config.urlPolicy);
		this.allowedLocalRoots =
			config.allowedLocalRoots && config.allowedLocalRoots.length > 0
				? config.allowedLocalRoots
				: [homedir()];
		this.ocrLanguages = config.ocrLanguages ?? OCR_DEFAULT_LANGS;
		this.ocrMaxPages = config.ocrMaxPages ?? OCR_DEFAULT_MAX_PAGES;
		this.tesseractCachePath =
			config.tesseractCachePath ??
			resolvePath(homedir(), ".octopus", "tesseract-cache");
	}

	/** Download (URL) or read (local path) a PDF into a buffer. */
	async loadSource(source: string): Promise<Buffer> {
		if (/^https?:\/\//i.test(source)) {
			return this.downloadPdf(source);
		}
		return this.readLocalFile(source);
	}

	private async downloadPdf(url: string): Promise<Buffer> {
		const allowed = await this.urlSafetyPolicy.assertAllowedAsync(
			url,
			"PDF download URL",
		);
		return downloadWithRedirects(allowed.href, DOWNLOAD_MAX_REDIRECTS);
	}

	private async readLocalFile(rawPath: string): Promise<Buffer> {
		const abs = isAbsolute(rawPath) ? rawPath : resolvePath(process.cwd(), rawPath);
		if (!this.allowedLocalRoots.some((root) => abs.startsWith(root))) {
			throw new Error(
				`Local PDF path is outside the allowed roots: ${abs}. Allowed roots: ${this.allowedLocalRoots.join(", ")}`,
			);
		}
		return readFile(abs);
	}

	/**
	 * Extract text from a PDF buffer. OCR runs only when a page's native text
	 * layer is sparse (scanned/image PDF) and OCR is enabled/auto.
	 */
	async extract(
		buffer: Buffer,
		opts: {
			pages?: string;
			ocr?: "auto" | "never" | "force";
		} = {},
	): Promise<PdfExtractionResult> {
		if (buffer.byteLength > MAX_PDF_BYTES) {
			throw new Error(
				`PDF is too large (${Math.round(buffer.byteLength / 1024 / 1024)} MB); limit is ${MAX_PDF_BYTES / 1024 / 1024} MB.`,
			);
		}
		const data = new Uint8Array(buffer);
		const pdfjs = await getPdfjs();
		const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
		const totalPages = doc.numPages;
		const targets = parsePageRange(opts.pages, totalPages);

		const pageTexts = new Map<number, string>();
		for (const p of targets) {
			const page = await doc.getPage(p);
			const content = await page.getTextContent();
			pageTexts.set(
				p,
				content.items.map((it) => it.str ?? "").join(" ").trim(),
			);
		}

		const ocr = opts.ocr ?? "auto";
		const sparsePages = targets.filter(
			(p) => (pageTexts.get(p)?.length ?? 0) < SPARSE_TEXT_THRESHOLD,
		);
		const forceAll = ocr === "force";
		const pagesToOcr =
			ocr === "never"
				? []
				: forceAll
					? targets.slice(0, this.ocrMaxPages)
					: sparsePages.slice(0, this.ocrMaxPages);

		const results: PdfPageResult[] = [];
		let ocrUsed = false;
		let ocrSkippedReason: string | undefined;

		if (pagesToOcr.length > 0) {
			const ocrOutcome = await this.runOcr(doc, pagesToOcr).then(
				(outcome): { texts: Map<number, string>; reason?: string } => outcome,
				(err): { texts: Map<number, string>; reason?: string } => ({
					texts: new Map(),
					reason: err instanceof Error ? err.message : String(err),
				}),
			);
			if (ocrOutcome.texts.size > 0) {
				ocrUsed = true;
				for (const p of pagesToOcr) {
					const ocrText = ocrOutcome.texts.get(p);
					if (ocrText && ocrText.length > (pageTexts.get(p)?.length ?? 0)) {
						pageTexts.set(p, ocrText);
					}
				}
			} else {
				ocrSkippedReason = ocrOutcome.reason;
			}
		}

		for (const p of targets) {
			results.push({
				page: p,
				text: pageTexts.get(p) ?? "",
				ocrUsed:
					ocrUsed && pagesToOcr.includes(p) && (pageTexts.get(p)?.length ?? 0) > 0,
			});
		}

		await doc.destroy?.().catch(() => {});

		return {
			totalPages,
			pages: results,
			text: results.map((r) => `--- Page ${r.page} ---\n${r.text}`).join("\n\n"),
			ocrUsed,
			ocrSkippedReason: ocrSkippedReason,
		};
	}

	/** Rasterize + OCR the given pages; throws if canvas/tesseract unavailable. */
	private async runOcr(
		doc: PdfjsDocLike,
		pages: number[],
	): Promise<{ texts: Map<number, string> }> {
		const canvasMod = await loadCanvas();
		if (!canvasMod) {
			throw new Error(
				"OCR no está disponible: no se pudo cargar el módulo '@napi-rs/canvas' para este entorno. La extracción de texto funciona, pero los PDFs escaneados no se pueden reconocer. Ejecuta 'pnpm install' para instalar el binario precompilado de @napi-rs/canvas.",
			);
		}
		const { createWorker } = await import("tesseract.js");
		const factory = new NodeCanvasFactory(canvasMod);
		// Cache traineddata outside the working directory so OCR doesn't litter
		// the repo/cwd with .traineddata files. langPath stays at its default
		// (remote) so the data is downloaded; cachePath stores it locally.
		await mkdir(this.tesseractCachePath, { recursive: true }).catch(() => {});
		const worker = await createWorker(this.ocrLanguages, 1, {
			logger: () => {},
			cachePath: this.tesseractCachePath,
		});
		const texts = new Map<number, string>();
		try {
			for (const p of pages) {
				const page = await doc.getPage(p);
				const viewport = page.getViewport({ scale: OCR_RENDER_SCALE });
				const target = factory.create(viewport.width, viewport.height) as {
					canvas: any;
					context: unknown;
				};
				await page.render({
					canvasContext: target.context,
					viewport,
					canvasFactory: factory as unknown,
				} as Record<string, unknown>).promise;
				const png = target.canvas.toBuffer("image/png") as Buffer;
				const { data } = await worker.recognize(png);
				texts.set(p, (data?.text ?? "").trim());
			}
		} finally {
			await worker.terminate();
		}
		return { texts };
	}

	/** Build the ToolDefinition exposed to the model. */
	createTools(): ToolDefinition[] {
		return [
			{
				name: "pdf_read",
				description:
					"Read a PDF and extract its text. Use this whenever you need the content of a PDF (the browser cannot read PDF text). Accepts an http(s) URL or a local file path. For scanned/image PDFs, OCR runs automatically (via @napi-rs/canvas + Tesseract); set ocr='force' to always OCR, or ocr='never' to skip it.",
				uiIcon: PDF_SVG,
				managesOwnPathPolicy: true,
				parameters: {
					source: {
						type: "string",
						description: "PDF URL (http/https) or absolute local file path.",
						required: true,
					},
					pages: {
						type: "string",
						description:
							"Optional page range, e.g. '1-5' or '1,3,5'. Omit to read all pages.",
						required: false,
					},
					ocr: {
						type: "string",
						description: "'auto' (default) | 'never' | 'force'.",
						required: false,
					},
				},
				handler: async (params: Record<string, unknown>): Promise<ToolResult> => {
					const source = String(params.source ?? "").trim();
					if (!source) {
						return {
							success: false,
							output: "",
							error: "Parameter 'source' is required (URL or local path).",
						};
					}
					const ocrRaw = String(params.ocr ?? "auto").toLowerCase();
					const ocr: "auto" | "never" | "force" =
						ocrRaw === "never" || ocrRaw === "force" ? ocrRaw : "auto";
					try {
						const buffer = await this.loadSource(source);
						const result = await this.extract(buffer, {
							pages: params.pages ? String(params.pages) : undefined,
							ocr,
						});
						const header =
							`PDF read OK — ${result.totalPages} page(s) total, returned ${result.pages.length}.` +
							(result.ocrUsed ? " OCR used on scanned page(s)." : "") +
							(result.ocrSkippedReason
								? ` OCR skipped: ${result.ocrSkippedReason}`
								: "");
						const text = result.text.trim();
						if (!text) {
							return {
								success: true,
								output: `${header}\n\n(No extractable text found. If this is a scanned PDF, OCR could not run: ${
									result.ocrSkippedReason ?? "unknown reason"
								})`,
								metadata: {
									totalPages: result.totalPages,
									pages: result.pages.length,
									ocrUsed: result.ocrUsed,
								},
							};
						}
						return {
							success: true,
							output: `${header}\n\n${text}`,
							metadata: {
								totalPages: result.totalPages,
								pages: result.pages.length,
								ocrUsed: result.ocrUsed,
								ocrSkipped: Boolean(result.ocrSkippedReason),
							},
						};
					} catch (err) {
						return {
							success: false,
							output: "",
							error: err instanceof Error ? err.message : String(err),
						};
					}
				},
			},
		];
	}
}

// --- helpers ---

function parsePageRange(spec: string | undefined, total: number): number[] {
	if (!spec || !spec.trim()) {
		return Array.from({ length: total }, (_, i) => i + 1);
	}
	const set = new Set<number>();
	for (const part of spec.split(",")) {
		const trimmed = part.trim();
		const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
		if (rangeMatch) {
			const a = Number(rangeMatch[1]);
			const b = Number(rangeMatch[2]);
			for (let i = a; i <= b; i++) if (i >= 1 && i <= total) set.add(i);
		} else if (/^\d+$/.test(trimmed)) {
			const n = Number(trimmed);
			if (n >= 1 && n <= total) set.add(n);
		}
	}
	const sorted = [...set].sort((a, b) => a - b);
	return sorted.length > 0 ? sorted : Array.from({ length: total }, (_, i) => i + 1);
}

async function downloadWithRedirects(
	url: string,
	redirectsLeft: number,
): Promise<Buffer> {
	if (redirectsLeft < 0) throw new Error("Too many redirects downloading PDF");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			redirect: "manual",
			headers: { "user-agent": "OctopusAI-PdfReader/1.0" },
		});
		if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
			const next = new URL(response.headers.get("location") as string, url).href;
			return downloadWithRedirects(next, redirectsLeft - 1);
		}
		if (!response.ok) {
			throw new Error(`PDF download failed: HTTP ${response.status} ${response.statusText}`);
		}
		const arrayBuffer = await response.arrayBuffer();
		return Buffer.from(arrayBuffer);
	} finally {
		clearTimeout(timer);
	}
}
