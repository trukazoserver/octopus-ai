import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	extractDocumentText,
	guessDocumentKind,
	MAX_DOC_CHARS,
} from "../tools/document-extract.js";

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
		expect(guessDocumentKind("photo.png")).toBe("media");
		expect(guessDocumentKind("weird.xyz")).toBe("unknown");
	});

	it("is case-insensitive on extensions", () => {
		expect(guessDocumentKind("A.PDF")).toBe("pdf");
		expect(guessDocumentKind("B.XLSX")).toBe("spreadsheet");
	});
});

describe("extractDocumentText", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "octopus-doc-"));
	});

	afterEach(async () => {
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

	it("returns empty text for media/unknown without throwing", async () => {
		const res = await extractDocumentText(join(dir, "x.png"), "x.png");
		expect(res.kind).toBe("media");
		expect(res.text).toBe("");
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
		const res = await extractDocumentText(
			join(dir, "nope.pdf"),
			"nope.pdf",
		);
		expect(res.kind).toBe("pdf");
		expect(res.text).toContain("No se pudo leer");
		expect(res.text).toContain("NO intentes instalar");
	});
});
