import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PdfReader } from "../tools/pdf-reader.js";

describe("PdfReader", () => {
	it("exposes PDF read, search, and export tool definitions", () => {
		const reader = new PdfReader();
		const tools = reader.createTools();
		expect(tools.map((tool) => tool.name)).toEqual([
			"pdf_read",
			"pdf_search",
			"pdf_extract_text",
		]);
		expect(tools[0].parameters.source.required).toBe(true);
	});

	it("requires a source parameter", async () => {
		const reader = new PdfReader();
		const tool = reader.createTools()[0];
		const result = await tool.handler({ source: "" });
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/source/i);
	});

	it("rejects local paths outside the allowed roots", async () => {
		const reader = new PdfReader({
			allowedLocalRoots: ["/definitely-not-a-real-root"],
		});
		await expect(reader.loadSource("some/local/file.pdf")).rejects.toThrow(
			/outside the allowed roots/i,
		);
	});

	it("rejects non-http(s) remote-looking sources via the URL policy", async () => {
		const reader = new PdfReader();
		// "file:" is not an allowed protocol for the download path.
		await expect(reader.loadSource("file:///etc/passwd")).rejects.toThrow();
	});

	it("searches extracted page text without returning the full PDF", async () => {
		const reader = new PdfReader();
		vi.spyOn(reader, "loadSource").mockResolvedValue(Buffer.from("pdf"));
		vi.spyOn(
			reader as unknown as {
				extractPages: (buffer: Buffer, opts: unknown) => Promise<unknown>;
			},
			"extractPages",
		).mockResolvedValue({
			totalPages: 1500,
			pages: [
				{ page: 1, text: "irrelevant intro", ocrUsed: false },
				{ page: 987, text: "Contrato principal con clausula de rescisión", ocrUsed: false },
			],
			ocrUsed: false,
		});
		const tool = reader.createTools().find((candidate) => candidate.name === "pdf_search");

		const result = await tool?.handler({
			source: "C:/doc.pdf",
			query: "rescisión",
		});

		expect(result?.success).toBe(true);
		expect(result?.output).toContain("1500 page(s) total");
		expect(result?.output).toContain("Page 987");
		expect(result?.output).toContain("clausula de rescisión");
	});

	it("exports extracted PDF text to a file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "octopus-pdf-export-"));
		try {
			const outPath = join(dir, "full.txt");
			const reader = new PdfReader({ allowedLocalRoots: [dir] });
			vi.spyOn(reader, "loadSource").mockResolvedValue(Buffer.from("pdf"));
			vi.spyOn(
				reader as unknown as {
					extractPages: (buffer: Buffer, opts: unknown) => Promise<unknown>;
				},
				"extractPages",
			).mockResolvedValue({
				totalPages: 1500,
				pages: [
					{ page: 1, text: "Pagina uno", ocrUsed: false },
					{ page: 1500, text: "Pagina final", ocrUsed: true },
				],
				ocrUsed: true,
			});
			const tool = reader
				.createTools()
				.find((candidate) => candidate.name === "pdf_extract_text");

			const result = await tool?.handler({
				source: join(dir, "doc.pdf"),
				outputPath: outPath,
				maxOcrPages: 1500,
			});

			expect(result?.success).toBe(true);
			expect(result?.output).toContain(outPath);
			const saved = await readFile(outPath, "utf8");
			expect(saved).toContain("Total pages: 1500");
			expect(saved).toContain("--- Page 1500 (OCR) ---");
			expect(saved).toContain("Pagina final");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
