import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MAX_DOC_CHARS,
	extractDocumentText,
	guessDocumentKind,
} from "../tools/document-extract.js";
import { PdfReader } from "../tools/pdf-reader.js";

describe("guessDocumentKind", () => {
	it("classifies common extensions", () => {
		expect(guessDocumentKind("foo.txt")).toBe("text");
		expect(guessDocumentKind("notes.md")).toBe("text");
		expect(guessDocumentKind("data.csv")).toBe("text");
		expect(guessDocumentKind("app.tsx")).toBe("code");
		expect(guessDocumentKind("script.py")).toBe("code");
		expect(guessDocumentKind("report.pdf")).toBe("pdf");
		expect(guessDocumentKind("book.xlsx")).toBe("spreadsheet");
		expect(guessDocumentKind("letter.docx")).toBe("document");
		expect(guessDocumentKind("pack.zip")).toBe("archive");
		expect(guessDocumentKind("photo.png")).toBe("image");
		expect(guessDocumentKind("clip.mp4")).toBe("media");
		expect(guessDocumentKind("weird.xyz")).toBe("unknown");
	});

	it("is case-insensitive on extensions", () => {
		expect(guessDocumentKind("A.PDF")).toBe("pdf");
		expect(guessDocumentKind("B.XLSX")).toBe("spreadsheet");
		expect(guessDocumentKind("C.JPEG")).toBe("image");
	});
});

describe("extractDocumentText", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "octopus-doc-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(dir, { recursive: true, force: true });
	});

	it("extracts plain text and code files as-is", async () => {
		const txt = join(dir, "note.txt");
		await writeFile(txt, "hello world", "utf8");
		const res = await extractDocumentText(txt, "note.txt");
		expect(res.kind).toBe("text");
		expect(res.text).toContain("hello world");
		expect(res.truncated).toBe(false);

		const py = join(dir, "app.py");
		await writeFile(py, "print('hi')", "utf8");
		const code = await extractDocumentText(py, "app.py");
		expect(code.kind).toBe("code");
		expect(code.text).toContain("print('hi')");
	});

	it("returns empty text for non-image media/unknown without throwing", async () => {
		const media = await extractDocumentText(join(dir, "x.mp4"), "x.mp4");
		expect(media.kind).toBe("media");
		expect(media.text).toBe("");

		const unknown = await extractDocumentText(join(dir, "x.bin"), "x.bin");
		expect(unknown.kind).toBe("unknown");
		expect(unknown.text).toBe("");
	});

	it("truncates very large text files", async () => {
		const big = join(dir, "big.txt");
		await writeFile(big, "a".repeat(MAX_DOC_CHARS + 5000), "utf8");
		const res = await extractDocumentText(big, "big.txt");
		expect(res.truncated).toBe(true);
		expect(res.text).toContain("contenido truncado");
		expect(res.text.length).toBeLessThan(MAX_DOC_CHARS + 5000);
	});

	it("produces a graceful note when the file is missing", async () => {
		const res = await extractDocumentText(join(dir, "nope.pdf"), "nope.pdf");
		expect(res.kind).toBe("pdf");
		expect(res.text).toContain("No se pudo leer");
		expect(res.text).toContain("NO intentes instalar");
	});

	it("uses automatic OCR for PDF chat attachments", async () => {
		const pdfPath = join(dir, "scan.pdf");
		await writeFile(pdfPath, Buffer.from("%PDF-1.7\n"));
		const extractSpy = vi.spyOn(PdfReader.prototype, "extract").mockResolvedValue({
			totalPages: 1,
			pages: [{ page: 1, text: "texto extraido", ocrUsed: true }],
			text: "--- Page 1 ---\ntexto extraido",
			ocrUsed: true,
		});

		const result = await extractDocumentText(pdfPath, "scan.pdf");

		expect(extractSpy).toHaveBeenCalledWith(expect.any(Buffer), {
			ocr: "auto",
			pages: "1-20",
		});
		expect(result.kind).toBe("pdf");
		expect(result.text).toContain("texto extraido");
	});

	it("extracts visible SVG text without running raster OCR", async () => {
		const svgPath = join(dir, "diagram.svg");
		await writeFile(
			svgPath,
			'<svg><text>Factura 123</text><script>hidden()</script></svg>',
			"utf8",
		);

		const result = await extractDocumentText(svgPath, "diagram.svg");

		expect(result.kind).toBe("image");
		expect(result.text).toContain("Factura 123");
		expect(result.text).not.toContain("hidden");
	});
});
