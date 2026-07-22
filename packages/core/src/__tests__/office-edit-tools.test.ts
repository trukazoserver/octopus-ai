import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { Document, Packer, Paragraph, TextRun } from "docx";
import pptxgen from "pptxgenjs";
import { describe, expect, it } from "vitest";
import { createOfficeEditTools } from "../tools/office-edit-tools.js";

describe("office edit tools", () => {
	it("edits a real DOCX across runs and preserves unaffected parts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "octopus-docx-edit-"));
		try {
			const inputPath = join(dir, "input.docx");
			const outputPath = join(dir, "output.docx");
			const document = new Document({
				sections: [{
					children: [
						new Paragraph({ children: [new TextRun("Alpha old"), new TextRun(" value old")] }),
						new Paragraph({ children: [new TextRun("DELETE "), new TextRun("ME")] }),
					],
				}],
			});
			await writeFile(inputPath, await Packer.toBuffer(document));
			const before = await readFile(inputPath);
			const beforeZip = new AdmZip(before);
			const stylesBefore = beforeZip.getEntry("word/styles.xml")?.getData();
			const tool = createOfficeEditTools([dir], dir).find((item) => item.name === "docx_edit");

			const edit = await tool?.handler({
				path: inputPath,
				outputPath,
				operations: [
					{ type: "replaceText", find: "old value", replace: "new & improved" },
					{ type: "replaceText", find: "old", replace: "fresh" },
					{ type: "removeParagraphsContaining", text: "DELETE ME" },
					{ type: "appendParagraphs", paragraphs: ["First appended", { text: "Second <appended>" }] },
				],
			}, undefined as never);

			expect(edit?.success, edit?.error).toBe(true);
			expect(await readFile(inputPath)).toEqual(before);
			const outputZip = new AdmZip(await readFile(outputPath));
			const documentXml = outputZip.getEntry("word/document.xml")?.getData().toString("utf8") ?? "";
			expect(decodeText(documentXml)).toContain("Alpha new & improved fresh");
			expect(decodeText(documentXml)).not.toContain("DELETE ME");
			expect(decodeText(documentXml)).toContain("First appended");
			expect(decodeText(documentXml)).toContain("Second <appended>");
			expect(outputZip.getEntry("word/styles.xml")?.getData()).toEqual(stylesBefore);
			const result = JSON.parse(edit?.output ?? "{}") as {
				changes: Array<{ count: number; references: string[] }>;
				changedParts: string[];
			};
			expect(result.changes.map((change) => change.count)).toEqual([1, 1, 1, 2]);
			expect(result.changes[0]?.references[0]).toMatch(/^docx:document\.xml\/p:/);
			expect(result.changedParts).toEqual(["word/document.xml"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("edits selected PPTX slides across runs and removes matching text shapes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "octopus-pptx-edit-"));
		try {
			const inputPath = join(dir, "input.pptx");
			const outputPath = join(dir, "output.pptx");
			const PptxGen = pptxgen as unknown as { new (): {
				addSlide(): { addText(text: unknown, options: JsonObject): void };
				writeFile(options: { fileName: string }): Promise<void>;
			} };
			const presentation = new PptxGen();
			const slide1 = presentation.addSlide();
			slide1.addText([{ text: "Quarter old" }, { text: " value" }], { x: 1, y: 1, w: 6, h: 1 });
			slide1.addText("KEEP SHAPE", { x: 1, y: 2, w: 4, h: 1 });
			const slide2 = presentation.addSlide();
			slide2.addText([{ text: "Quarter old" }, { text: " value" }], { x: 1, y: 1, w: 6, h: 1 });
			slide2.addText([{ text: "REMOVE" }, { text: " SHAPE" }], { x: 1, y: 2, w: 4, h: 1 });
			await presentation.writeFile({ fileName: inputPath });
			const inputZip = new AdmZip(await readFile(inputPath));
			const themeBefore = inputZip.getEntry("ppt/theme/theme1.xml")?.getData();
			const tool = createOfficeEditTools([dir], dir).find((item) => item.name === "pptx_edit");

			const edit = await tool?.handler({
				path: inputPath,
				outputPath,
				operations: [
					{ type: "replaceText", find: "old value", replace: "new value", slides: [1] },
					{ type: "removeShapesContaining", text: "REMOVE SHAPE", slides: "2" },
				],
			}, undefined as never);

			expect(edit?.success, edit?.error).toBe(true);
			const outputZip = new AdmZip(await readFile(outputPath));
			const firstSlide = decodeText(outputZip.getEntry("ppt/slides/slide1.xml")?.getData().toString("utf8") ?? "");
			const secondSlide = decodeText(outputZip.getEntry("ppt/slides/slide2.xml")?.getData().toString("utf8") ?? "");
			expect(firstSlide).toContain("Quarter new value");
			expect(secondSlide).toContain("Quarter old value");
			expect(secondSlide).not.toContain("REMOVE SHAPE");
			expect(outputZip.getEntry("ppt/theme/theme1.xml")?.getData()).toEqual(themeBefore);
			const result = JSON.parse(edit?.output ?? "{}") as { changes: Array<{ count: number; references: string[] }> };
			expect(result.changes[0]).toMatchObject({ count: 1, references: [expect.stringMatching(/^pptx:slide:1\/p:/)] });
			expect(result.changes[1]).toMatchObject({ count: 1, references: [expect.stringMatching(/^pptx:slide:2\/shape:/)] });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects in-place edits and macro-enabled packages", async () => {
		const dir = await mkdtemp(join(tmpdir(), "octopus-office-edit-safe-"));
		const outsideDir = await mkdtemp(join(tmpdir(), "octopus-office-edit-outside-"));
		try {
			const inputPath = join(dir, "input.docx");
			const outputPath = join(dir, "output.docx");
			const document = new Document({ sections: [{ children: [new Paragraph("Safe")] }] });
			const documentBuffer = await Packer.toBuffer(document);
			await writeFile(inputPath, documentBuffer);
			const tool = createOfficeEditTools([dir], dir).find((item) => item.name === "docx_edit");
			const inPlace = await tool?.handler({
				path: inputPath,
				outputPath: inputPath,
				operations: [{ type: "replaceText", find: "Safe", replace: "Changed" }],
			}, undefined as never);
			expect(inPlace?.success).toBe(false);
			expect(inPlace?.error).toMatch(/different/);

			await writeFile(join(outsideDir, "outside.docx"), documentBuffer);
			const linkedDir = join(dir, "linked-outside");
			await symlink(outsideDir, linkedDir, process.platform === "win32" ? "junction" : "dir");
			const junctionEscape = await tool?.handler({
				path: join(linkedDir, "outside.docx"),
				outputPath,
				operations: [{ type: "replaceText", find: "Safe", replace: "Changed" }],
			}, undefined as never);
			expect(junctionEscape?.success).toBe(false);
			expect(junctionEscape?.error).toMatch(/outside the allowed paths/);

			const macroZip = new AdmZip(await readFile(inputPath));
			macroZip.addFile("word/vbaProject.bin", Buffer.from("macro"));
			await writeFile(inputPath, macroZip.toBuffer());
			const macro = await tool?.handler({
				path: inputPath,
				outputPath,
				operations: [{ type: "replaceText", find: "Safe", replace: "Changed" }],
			}, undefined as never);
			expect(macro?.success).toBe(false);
			expect(macro?.error).toMatch(/Macro-enabled/);
		} finally {
			await rm(dir, { recursive: true, force: true });
			await rm(outsideDir, { recursive: true, force: true });
		}
	});
});

type JsonObject = Record<string, unknown>;

function decodeText(xml: string) {
	return xml
		.replace(/<[^>]+>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}
