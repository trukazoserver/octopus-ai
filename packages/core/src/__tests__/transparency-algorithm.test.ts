import { describe, expect, it } from "vitest";
import {
	type TransparencyInput,
	computeTransparencyAlpha,
} from "../tools/transparency-algorithm.js";
import { ensureTransparentImage } from "../tools/codex-image.js";

function rgbImage(
	width: number,
	height: number,
	paint: (x: number, y: number) => [number, number, number],
): TransparencyInput {
	const data = new Uint8Array(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b] = paint(x, y);
			const offset = (y * width + x) * 3;
			data[offset] = r;
			data[offset + 1] = g;
			data[offset + 2] = b;
		}
	}
	return { data, width, height, channels: 3 };
}

describe("computeTransparencyAlpha", () => {
	it("makes the flood-filled border background transparent and keeps the subject opaque", () => {
		const size = 20;
		const input = rgbImage(size, size, (x, y) => {
			const inSquare = x >= 6 && x < 14 && y >= 6 && y < 14;
			return inSquare ? [200, 30, 30] : [255, 255, 255];
		});

		const result = computeTransparencyAlpha(input);

		expect(result.kind).toBe("rgba");
		if (result.kind !== "rgba") return;
		const alphaAt = (x: number, y: number) =>
			result.rgba[(y * size + x) * 4 + 3];
		expect(alphaAt(0, 0)).toBe(0);
		expect(alphaAt(19, 0)).toBe(0);
		expect(alphaAt(0, 19)).toBe(0);
		expect(alphaAt(10, 10)).toBe(255);
	});

	it("reports no-background for a uniform image", () => {
		const input = rgbImage(30, 30, () => [10, 20, 30]);

		const result = computeTransparencyAlpha(input);

		expect(result.kind).toBe("none");
	});

	it("rejects images too small to analyze", () => {
		const input = rgbImage(2, 2, () => [0, 0, 0]);

		const result = computeTransparencyAlpha(input);

		expect(result).toEqual({ kind: "none", reason: "too-small" });
	});
});

describe("ensureTransparentImage (worker con fallback inline)", () => {
	it("recovers transparency for an opaque subject-on-white PNG", async () => {
		const { default: sharp } = await import("sharp");
		const size = 48;
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="#ffffff"/><rect x="14" y="14" width="20" height="20" fill="#1a7f37"/></svg>`;
		const opaquePng = await sharp(Buffer.from(svg)).png().toBuffer();
		const before = await sharp(opaquePng).stats();
		expect(before.isOpaque).toBe(true);

		const { buffer, alphaPostProcessed } = await ensureTransparentImage(
			opaquePng,
		);

		expect(alphaPostProcessed).toBe(true);
		const after = await sharp(buffer).stats();
		expect(after.isOpaque).toBe(false);
	});
});
