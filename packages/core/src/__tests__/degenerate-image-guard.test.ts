import { describe, expect, it } from "vitest";
import { ToolExecutor } from "../tools/executor.js";
import { ToolRegistry } from "../tools/registry.js";

function pngWithDimensions(width: number, height: number): Buffer {
	// Firma PNG + longitud IHDR + "IHDR" + width/height big-endian.
	const buffer = Buffer.alloc(24);
	buffer.writeUInt32BE(0x89504e47, 0);
	buffer.writeUInt32BE(13, 8);
	buffer.write("IHDR", 12, "ascii");
	buffer.writeUInt32BE(width, 16);
	buffer.writeUInt32BE(height, 20);
	return buffer;
}

function makeExecutor(): ToolExecutor {
	return new ToolExecutor(new ToolRegistry(), {
		sandboxCommands: false,
		allowedPaths: [],
	});
}

describe("isDegenerateImage (guard contra placeholders de tools fallidas)", () => {
	it("detecta PNGs de 1x1 (los cuadros verdes)", () => {
		expect(makeExecutor().isDegenerateImage(pngWithDimensions(1, 1), "image/png")).toBe(true);
	});

	it("acepta PNGs normales", () => {
		expect(makeExecutor().isDegenerateImage(pngWithDimensions(512, 512), "image/png")).toBe(false);
	});

	it("detecta GIFs de 1x1", () => {
		const buffer = Buffer.alloc(11);
		buffer.write("GIF89a", 0, "ascii");
		buffer.writeUInt16LE(1, 6);
		buffer.writeUInt16LE(1, 8);
		expect(makeExecutor().isDegenerateImage(buffer, "image/gif")).toBe(true);
	});

	it("ignora tipos no-imagen y SVG", () => {
		const executor = makeExecutor();
		expect(executor.isDegenerateImage(Buffer.alloc(10), "application/pdf")).toBe(false);
		expect(executor.isDegenerateImage(Buffer.from("<svg/>"), "image/svg+xml")).toBe(false);
	});
});
