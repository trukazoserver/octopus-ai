import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { createWorker } from "tesseract.js";
import {
	getOfflineOcrLanguageStatus,
	getOfflineTessdataPath,
} from "../tools/ocr-language-data.js";

describe("offline OCR language data", () => {
	const original = process.env.OCTOPUS_TESSDATA_PATH;

	afterEach(() => {
		if (original === undefined) process.env.OCTOPUS_TESSDATA_PATH = undefined;
		else process.env.OCTOPUS_TESSDATA_PATH = original;
	});

	it("materializes locked English and Spanish traineddata without network access", async () => {
		const dir = await mkdtemp(join(tmpdir(), "octopus-tessdata-"));
		try {
			process.env.OCTOPUS_TESSDATA_PATH = dir;
			expect(getOfflineTessdataPath()).toBe(dir);
			const status = getOfflineOcrLanguageStatus();
			expect(status.map((item) => item.code).sort()).toEqual(["eng", "spa"]);
			expect(status.every((item) => item.present && item.size > 1_000_000)).toBe(true);
			for (const item of status) {
				const bytes = await readFile(item.path);
				expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it(
		"runs OCR with the bundled traineddata path",
		async () => {
			const dir = await mkdtemp(join(tmpdir(), "octopus-tessdata-live-"));
			try {
				process.env.OCTOPUS_TESSDATA_PATH = join(dir, "models");
				const image = await sharp(
					Buffer.from('<svg width="700" height="180"><rect width="100%" height="100%" fill="white"/><text x="30" y="120" font-family="Arial" font-size="76" fill="black">OCTOPUS TEST</text></svg>'),
				).png().toBuffer();
				const worker = await createWorker(["eng"], 1, {
					logger: () => {},
					langPath: getOfflineTessdataPath(),
					cachePath: join(dir, "cache"),
				});
				try {
					const result = await worker.recognize(image);
					expect(result.data.text.toUpperCase()).toContain("OCTOPUS");
				} finally {
					await worker.terminate();
				}
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
		30_000,
	);
});
