import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createOfficeMediaTools } from "../tools/office-media-tools.js";
import { createOfficeTools } from "../tools/office-tools.js";

describe("office embedded media tools", () => {
	it("lists and extracts images embedded in a DOCX", async () => {
		const dir = await mkdtemp(join(tmpdir(), "octopus-office-media-"));
		try {
			const imagePath = join(dir, "logo.png");
			await writeFile(imagePath, await sharp({ create: { width: 80, height: 40, channels: 4, background: "#4f46e5" } }).png().toBuffer());
			const docxPath = join(dir, "with-image.docx");
			const create = createOfficeTools([dir], dir).find((tool) => tool.name === "docx_create");
			const created = await create?.handler({ path: docxPath, blocks: [{ type: "image", path: imagePath, width: 160, height: 80 }] }, undefined as never);
			expect(created?.success, created?.error).toBe(true);

			const outputDir = join(dir, "media");
			const extract = createOfficeMediaTools([dir], dir)[0];
			const result = await extract?.handler({ path: docxPath, outputDir }, undefined as never);
			expect(result?.success, result?.error).toBe(true);
			const parsed = JSON.parse(result?.output ?? "{}") as { items: Array<{ extractedPath: string; ref: string }> };
			expect(parsed.items).toHaveLength(1);
			expect(parsed.items[0]?.ref).toMatch(/^docx:media:/);
			expect((await readFile(parsed.items[0]?.extractedPath ?? "")).subarray(1, 4).toString("ascii")).toBe("PNG");
			expect((await stat(parsed.items[0]?.extractedPath ?? "")).size).toBeGreaterThan(20);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
