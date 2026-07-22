import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createOfficePreviewTools } from "../tools/office-preview.js";
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

	it("creates a themed presentation with semantic layouts and rich objects", async () => {
		const dir = await mkdtemp(join(tmpdir(), "octopus-premium-pptx-"));
		try {
			const imagePath = join(dir, "hero.png");
			await writeFile(
				imagePath,
				await sharp({
					create: {
						width: 640,
						height: 420,
						channels: 4,
						background: { r: 45, g: 90, b: 155, alpha: 1 },
					},
				}).png().toBuffer(),
			);
			const outputPath = join(dir, "premium-deck.pptx");
			const progress: string[] = [];
			const tool = createOfficeTools([dir], dir).find(
				(candidate) => candidate.name === "pptx_create",
			);
			const result = await tool?.handler(
				{
					path: outputPath,
					title: "Perspectiva de mercado",
					designBrief:
						"Audiencia ejecutiva; estilo editorial, seguro y basado en evidencia.",
					stylePreset: "editorial",
					slides: [
						{
							layout: "cover",
							title: "El mercado entra en una nueva etapa",
							subtitle: "Tres señales que definirán los próximos 18 meses",
							imagePath,
						},
						{
							layout: "metrics",
							title: "El crecimiento se concentra en tres motores",
							metrics: [
								{ value: "+24%", label: "Demanda digital", detail: "Crecimiento interanual" },
								{ value: "3.2x", label: "Productividad", detail: "Frente a procesos manuales" },
								{ value: "68%", label: "Adopción", detail: "Empresas en fase activa" },
							],
						},
						{
							layout: "chart",
							title: "La adopción acelera después de 2025",
							chart: {
								type: "column",
								categories: ["2024", "2025", "2026"],
								series: [{ name: "Adopción", values: [32, 49, 68] }],
								showValues: true,
							},
							takeaway: "La mayor oportunidad está en convertir pilotos en procesos centrales.",
						},
						{
							layout: "table",
							title: "Cada escenario exige una respuesta distinta",
							table: {
								headers: ["Escenario", "Señal", "Respuesta"],
								rows: [
									["Base", "Demanda estable", "Escalar capacidades"],
									["Alto", "Adopción rápida", "Acelerar inversión"],
								],
							},
						},
						{
							layout: "quote",
							title: "La ventaja no proviene de adoptar primero, sino de integrar mejor.",
							quoteAttribution: "Conclusión del análisis",
							speaker: {
								narrative: "Cerrar conectando inversión con ejecución.",
								sources: ["https://example.com/research"],
							},
						},
					],
				},
				{ onProgress: (status: string) => progress.push(status) } as never,
			);

			expect(result?.success).toBe(true);
			expect(result?.output).toContain("Theme: editorial");
			expect(result?.output).toContain('"metrics":1');
			expect(progress.some((item) => item.includes("phase_visual_direction"))).toBe(true);
			expect(progress.some((item) => item.includes("phase_generation"))).toBe(true);
			expect(progress.some((item) => item.includes("phase_validation"))).toBe(true);

			const zip = new AdmZip(outputPath);
			const entries = zip.getEntries().map((entry) => entry.entryName);
			expect(entries.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(5);
			expect(entries.some((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name))).toBe(true);
			expect(entries.some((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))).toBe(true);
			const slide4 = zip.readAsText("ppt/slides/slide4.xml");
			expect(slide4).toContain("<a:tbl>");
			const notes = entries
				.filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))
				.map((name) => zip.readAsText(name))
				.join("\n");
			expect(notes).toContain("Sources:");
			expect(notes).toContain("example.com/research");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("streams typed generation and validation phases for Office previews", async () => {
		const dir = await mkdtemp(join(tmpdir(), "octopus-office-progress-"));
		try {
			const sourcePath = join(dir, "source.pdf");
			const outputPath = join(dir, "validated.pdf");
			const pdf = await PDFDocument.create();
			pdf.addPage();
			await writeFile(sourcePath, await pdf.save());
			const progress: string[] = [];
			const tool = createOfficePreviewTools([dir], dir).find(
				(candidate) => candidate.name === "office_convert_preview",
			);
			const result = await tool?.handler(
				{ source: sourcePath, outputPath },
				{ onProgress: (status: string) => progress.push(status) } as never,
			);

			expect(result?.success).toBe(true);
			expect(progress.some((item) => item.includes("phase_generation"))).toBe(true);
			expect(progress.some((item) => item.includes("phase_validation"))).toBe(true);
			expect(progress.every((item) => item.startsWith("\x00STATUS:"))).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
