import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { createPdfAdvancedTools } from "../tools/pdf-advanced-tools.js";

describe("advanced PDF tools", () => {
	it("inspects and fills an AcroForm without changing the original", async () => {
		const dir = await mkdtemp(join(tmpdir(), "octopus-pdf-form-"));
		try {
			const inputPath = join(dir, "form.pdf");
			const outputPath = join(dir, "filled.pdf");
			const pdf = await PDFDocument.create();
			const page = pdf.addPage([400, 300]);
			const field = pdf.getForm().createTextField("customer");
			field.addToPage(page, { x: 40, y: 220, width: 220, height: 24 });
			await writeFile(inputPath, await pdf.save());
			const original = await readFile(inputPath);
			const tool = createPdfAdvancedTools([dir], dir).find((candidate) => candidate.name === "pdf_form");
			const inspect = await tool?.handler({ action: "inspect", path: inputPath }, undefined as never);
			expect(inspect?.success, inspect?.error).toBe(true);
			expect(JSON.parse(inspect?.output ?? "{}").fields[0].name).toBe("customer");

			const fill = await tool?.handler({ action: "fill", path: inputPath, outputPath, values: { customer: "Octopus AI" } }, undefined as never);
			expect(fill?.success, fill?.error).toBe(true);
			expect(await readFile(inputPath)).toEqual(original);
			const filled = await PDFDocument.load(await readFile(outputPath));
			expect(filled.getForm().getTextField("customer").getText()).toBe("Octopus AI");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rotates and watermarks selected pages", async () => {
		const dir = await mkdtemp(join(tmpdir(), "octopus-pdf-transform-"));
		try {
			const inputPath = join(dir, "input.pdf");
			const outputPath = join(dir, "output.pdf");
			const pdf = await PDFDocument.create();
			pdf.addPage([300, 500]);
			await writeFile(inputPath, await pdf.save());
			const tool = createPdfAdvancedTools([dir], dir).find((candidate) => candidate.name === "pdf_transform");
			const result = await tool?.handler({ path: inputPath, outputPath, rotate: 90, watermark: "BORRADOR", title: "Informe" }, undefined as never);
			expect(result?.success, result?.error).toBe(true);
			const transformed = await PDFDocument.load(await readFile(outputPath));
			expect(transformed.getPage(0).getRotation().angle).toBe(90);
			expect(transformed.getTitle()).toBe("Informe");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
