import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { createOfficeAdvancedTools } from "../tools/office-advanced-tools.js";
import {
	createOfficePreviewTools,
	findLibreOfficeExecutable,
} from "../tools/office-preview.js";
import { createOfficeTools } from "../tools/office-tools.js";

describe("advanced office tools", () => {
	it("inspects and searches real PPTX and XLSX structures", async () => {
		const dir = await mkdtemp(join(tmpdir(), "octopus-office-inspect-"));
		try {
			const creators = byName(createOfficeTools([dir], dir));
			const advanced = byName(createOfficeAdvancedTools([dir], dir));
			const pptxPath = join(dir, "deck.pptx");
			await creators.pptx_create?.handler(
				{ path: pptxPath, slides: [{ title: "Estrategia anual", bullets: ["Mercado Perú", "Objetivo 2027"] }] },
				undefined as never,
			);
			const pptSearch = await advanced.office_search?.handler(
				{ path: pptxPath, query: "mercado peru" },
				undefined as never,
			);
			expect(pptSearch?.success).toBe(true);
			const pptResult = JSON.parse(pptSearch?.output ?? "{}") as { matches: Array<{ ref: string }> };
			expect(pptResult.matches[0]?.ref).toMatch(/^pptx:slide:1/);

			const xlsxPath = join(dir, "book.xlsx");
			await creators.xlsx_create?.handler(
				{
					path: xlsxPath,
					sheets: [{ name: "Ventas", columns: ["Producto", "Total"], rows: [["Pulpo", 12]], formulas: [{ cell: "B3", formula: "SUM(B2:B2)", result: 12 }] }],
				},
				undefined as never,
			);
			const inspect = await advanced.office_inspect?.handler(
				{ path: xlsxPath, limit: 20 },
				undefined as never,
			);
			expect(inspect?.success).toBe(true);
			const inspectResult = JSON.parse(inspect?.output ?? "{}") as {
				items: Array<{ ref: string; formula?: string }>;
			};
			expect(inspectResult.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ ref: "xlsx:sheet:Ventas/cell:A2", text: "Pulpo" }),
					expect.objectContaining({ ref: "xlsx:sheet:Ventas/cell:B3", formula: "SUM(B2:B2)" }),
				]),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("fills DOCX placeholders split across runs without changing the template", async () => {
		const dir = await mkdtemp(join(tmpdir(), "octopus-docx-template-"));
		try {
			const templatePath = join(dir, "template.docx");
			const outputPath = join(dir, "filled.docx");
			const doc = new Document({
				sections: [
					{
						children: [
							new Paragraph({
								children: [
									new TextRun({ text: "Cliente: {{cli", bold: true }),
									new TextRun({ text: "ente}}", italics: true }),
								],
							}),
						],
					},
				],
			});
			await writeFile(templatePath, await Packer.toBuffer(doc));
			const before = await readFile(templatePath);
			const advanced = byName(createOfficeAdvancedTools([dir], dir));
			const fill = await advanced.docx_template_fill?.handler(
				{ path: templatePath, outputPath, values: { cliente: "Octopus & Compañía" } },
				undefined as never,
			);
			expect(fill?.success).toBe(true);
			expect(await readFile(templatePath)).toEqual(before);
			const search = await advanced.office_search?.handler(
				{ path: outputPath, query: "Octopus & Compañía" },
				undefined as never,
			);
			expect(search?.success).toBe(true);
			const result = JSON.parse(search?.output ?? "{}") as { totalMatches: number };
			expect(result.totalMatches).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("fills PPTX templates and preserves a readable presentation", async () => {
		const dir = await mkdtemp(join(tmpdir(), "octopus-pptx-template-"));
		try {
			const templatePath = join(dir, "template.pptx");
			const outputPath = join(dir, "filled.pptx");
			const creators = byName(createOfficeTools([dir], dir));
			await creators.pptx_create?.handler(
				{ path: templatePath, slides: [{ title: "Plan {{anio}}", bullets: ["Cliente {{cliente}}"] }] },
				undefined as never,
			);
			const advanced = byName(createOfficeAdvancedTools([dir], dir));
			const fill = await advanced.pptx_template_fill?.handler(
				{ path: templatePath, outputPath, values: { anio: 2027, cliente: "Acme" } },
				undefined as never,
			);
			expect(fill?.success).toBe(true);
			const search = await advanced.office_search?.handler(
				{ path: outputPath, query: "Cliente Acme" },
				undefined as never,
			);
			const result = JSON.parse(search?.output ?? "{}") as { matches: Array<{ slide: number }> };
			expect(result.matches[0]?.slide).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("renders selected PDF pages to PNG without LibreOffice", async () => {
		const dir = await mkdtemp(join(tmpdir(), "octopus-office-preview-"));
		try {
			const sourcePath = join(dir, "source.pdf");
			const outputPath = join(dir, "copy.pdf");
			const previewDir = join(dir, "preview");
			const pdf = await PDFDocument.create();
			pdf.addPage([300, 300]);
			pdf.addPage([300, 300]);
			await writeFile(sourcePath, await pdf.save());
			const tool = createOfficePreviewTools([dir], dir)[0];
			const result = await tool?.handler(
				{ source: sourcePath, outputPath, previewDir, previewPages: "2" },
				undefined as never,
			);
			expect(result?.success, result?.error).toBe(true);
			const pngPath = join(previewDir, "page-0002.png");
			expect((await readFile(pngPath)).subarray(1, 4).toString("ascii")).toBe("PNG");
			expect((await stat(outputPath)).size).toBeGreaterThan(100);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.runIf(Boolean(findLibreOfficeExecutable()))(
		"converts a real DOCX to validated PDF and PNG with LibreOffice",
		async () => {
			const dir = await mkdtemp(join(tmpdir(), "octopus-libreoffice-preview-"));
			try {
				const sourcePath = join(dir, "report.docx");
				const outputPath = join(dir, "report.pdf");
				const previewDir = join(dir, "preview");
				const create = createOfficeTools([dir], dir).find((tool) => tool.name === "docx_create");
				const created = await create?.handler(
					{ path: sourcePath, title: "Informe Octopus", blocks: [{ type: "paragraph", text: "Conversión validada" }] },
					undefined as never,
				);
				expect(created?.success, created?.error).toBe(true);
				const preview = createOfficePreviewTools([dir], dir).find((tool) => tool.name === "office_convert_preview");
				const result = await preview?.handler(
					{ source: sourcePath, outputPath, previewDir, previewPages: "1" },
					undefined as never,
				);
				expect(result?.success, result?.error).toBe(true);
				expect((await readFile(outputPath)).subarray(0, 5).toString("ascii")).toBe("%PDF-");
				expect((await readFile(join(previewDir, "page-0001.png"))).subarray(1, 4).toString("ascii")).toBe("PNG");
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	);
});

function byName<T extends { name: string }>(items: T[]): Record<string, T | undefined> {
	return Object.fromEntries(items.map((item) => [item.name, item]));
}
