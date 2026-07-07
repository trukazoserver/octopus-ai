import { describe, expect, it } from "vitest";
import {
	isLocalBaseUrl,
	readNextWithTimeout,
} from "../ai/providers/stream-reader.js";

describe("isLocalBaseUrl", () => {
	it("true for localhost / loopback / .local", () => {
		expect(isLocalBaseUrl("http://localhost:11434")).toBe(true);
		expect(isLocalBaseUrl("http://127.0.0.1:1234/v1")).toBe(true);
		expect(isLocalBaseUrl("http://0.0.0.0:8080")).toBe(true);
		expect(isLocalBaseUrl("http://my-box.local:8000")).toBe(true);
	});

	it("false for remote hosts", () => {
		expect(isLocalBaseUrl("https://api.z.ai/api/paas/v4")).toBe(false);
		expect(isLocalBaseUrl("https://api.openai.com/v1")).toBe(false);
		expect(
			isLocalBaseUrl("https://generativelanguage.googleapis.com/v1beta"),
		).toBe(false);
	});

	it("false for empty / garbage", () => {
		expect(isLocalBaseUrl(undefined)).toBe(false);
		expect(isLocalBaseUrl("")).toBe(false);
		expect(isLocalBaseUrl("not-a-url")).toBe(false);
	});
});

describe("readNextWithTimeout", () => {
	it("returns chunks as soon as they arrive", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
				controller.close();
			},
		});
		const reader = stream.getReader();
		const first = await readNextWithTimeout(reader, 5000, "Test");
		expect(first.done).toBe(false);
		expect(new TextDecoder().decode(first.value)).toContain("data: hi");
		const second = await readNextWithTimeout(reader, 5000, "Test");
		expect(second.done).toBe(true);
	});

	it("rejects when no chunk arrives within the timeout", async () => {
		// A stream that never enqueues and never closes — simulates a hung
		// provider (keep-alive pings with no content, dropped connection).
		const stream = new ReadableStream<Uint8Array>({
			start() {
				// intentionally never calls controller.enqueue/close
			},
		});
		const reader = stream.getReader();
		const start = Date.now();
		await expect(readNextWithTimeout(reader, 80, "Stalled")).rejects.toThrow(
			/Stalled stream read timeout/,
		);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(70);
		expect(elapsed).toBeLessThan(1000);
		reader.cancel().catch(() => {});
	});
});
