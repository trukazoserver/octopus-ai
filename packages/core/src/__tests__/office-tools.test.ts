import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { createOfficeTools } from "../tools/office-tools.js";

describe("office tools", () => {
	it("creates real DOCX, XLSX, PPTX and PDF files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "octopus-office-tools-"));
		try {
			const tools = createOfficeTools([dir], dir);
			const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

			const docxPath = join(dir, "report.docx");
			const docx = await byName.docx_create?.handler(
				{
					path: docxPath,
					title: "Reporte",
					blocks: [
						{ type: "heading", text: "Resumen", level: 1 },
						{ type: "paragraph", text: "Contenido de prueba" },
						{ type: "table", rows: [["A", "B"], ["1", "2"]] },
					],
				},
				undefined as never,
			);
			expect(docx?.success).toBe(true);
			expect((await readFile(docxPath)).subarray(0, 2).toString()).toBe("PK");

			const xlsxPath = join(dir, "book.xlsx");
			const xlsx = await byName.xlsx_create?.handler(
				{
					path: xlsxPath,
					sheets: [
						{
							name: "Ventas",
							columns: ["Producto", "Total"],
							rows: [["A", 10], ["B", 20]],
							formulas: [{ cell: "B4", formula: "SUM(B2:B3)", result: 30 }],
							table: true,
						},
					],
				},
				undefined as never,
			);
			expect(xlsx?.success).toBe(true);
			expect((await readFile(xlsxPath)).subarray(0, 2).toString()).toBe("PK");

			const editPath = join(dir, "book-edited.xlsx");
			const edit = await byName.xlsx_edit?.handler(
				{
					path: xlsxPath,
					outputPath: editPath,
					updates: [{ sheet: "Ventas", cell: "C1", value: "Editado", bold: true }],
				},
				undefined as never,
			);
			expect(edit?.success).toBe(true);
			expect((await stat(editPath)).size).toBeGreaterThan(1000);

			const pptxPath = join(dir, "deck.pptx");
			const pptx = await byName.pptx_create?.handler(
				{
					path: pptxPath,
					title: "Deck",
					slides: [{ title: "Inicio", bullets: ["Uno", "Dos"], notes: "Notas" }],
				},
				undefined as never,
			);
			expect(pptx?.success).toBe(true);
			expect((await readFile(pptxPath)).subarray(0, 2).toString()).toBe("PK");

			const pdfPath = join(dir, "report.pdf");
			const pdf = await byName.pdf_create?.handler(
				{
					path: pdfPath,
					title: "PDF",
					blocks: [{ type: "heading", text: "Titulo" }, { type: "paragraph", text: "Texto" }],
				},
				undefined as never,
			);
			expect(pdf?.success).toBe(true);
			expect((await readFile(pdfPath)).subarray(0, 4).toString()).toBe("%PDF");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("extracts selected PDF pages", async () => {
		const dir = await mkdtemp(join(tmpdir(), "octopus-pdf-pages-"));
		try {
			const sourcePath = join(dir, "source.pdf");
			const outputPath = join(dir, "page-2.pdf");
			const source = await PDFDocument.create();
			source.addPage();
			source.addPage();
			const bytes = await source.save();
			await import("node:fs/promises").then((fs) => fs.writeFile(sourcePath, bytes));

			const tool = createOfficeTools([dir], dir).find((candidate) => candidate.name === "pdf_pages");
			const result = await tool?.handler(
				{ action: "extract", source: sourcePath, pages: "2", outputPath },
				undefined as never,
			);

			expect(result?.success).toBe(true);
			const extracted = await PDFDocument.load(await readFile(outputPath));
			expect(extracted.getPageCount()).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
