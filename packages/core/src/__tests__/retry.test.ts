import { beforeEach, describe, expect, it, vi } from "vitest";
import { RetryHandler } from "../connection/retry.js";

describe("RetryHandler", () => {
	it("should return result on first successful attempt", async () => {
		const handler = new RetryHandler({ maxAttempts: 3, baseDelay: 10 });
		const result = await handler.execute(() => Promise.resolve("ok"));
		expect(result).toBe("ok");
	});

	it("should retry on retryable errors", async () => {
		const handler = new RetryHandler({ maxAttempts: 3, baseDelay: 10 });
		let attempts = 0;
		const result = await handler.execute(() => {
			attempts++;
			if (attempts < 3) {
				const err = new Error("connection refused");
				(err as unknown as { code: string }).code = "ECONNREFUSED";
				throw err;
			}
			return Promise.resolve("ok");
		});
		expect(result).toBe("ok");
		expect(attempts).toBe(3);
	});

	it("should throw immediately for non-retryable errors", async () => {
		const handler = new RetryHandler({ maxAttempts: 3, baseDelay: 10 });
		await expect(
			handler.execute(() => {
				throw new Error("bad request");
			}),
		).rejects.toThrow("bad request");
	});

	describe("isRetryable", () => {
		const handler = new RetryHandler();

		it("should retry on ECONNREFUSED", () => {
			expect(
				handler.isRetryable(
					Object.assign(new Error(), { code: "ECONNREFUSED" }),
				),
			).toBe(true);
		});

		it("should retry on ECONNRESET", () => {
			expect(
				handler.isRetryable(Object.assign(new Error(), { code: "ECONNRESET" })),
			).toBe(true);
		});

		it("should retry on ETIMEDOUT", () => {
			expect(
				handler.isRetryable(Object.assign(new Error(), { code: "ETIMEDOUT" })),
			).toBe(true);
		});

		it("should retry on HTTP 429", () => {
			expect(
				handler.isRetryable(Object.assign(new Error(), { status: 429 })),
			).toBe(true);
		});

		it("should retry on HTTP 503", () => {
			expect(
				handler.isRetryable(Object.assign(new Error(), { status: 503 })),
			).toBe(true);
		});

		it("should not retry on HTTP 400", () => {
			expect(
				handler.isRetryable(Object.assign(new Error(), { status: 400 })),
			).toBe(false);
		});

		it("should not retry on HTTP 401", () => {
			expect(
				handler.isRetryable(Object.assign(new Error(), { status: 401 })),
			).toBe(false);
		});

		it("should not retry on null error", () => {
			expect(handler.isRetryable(null)).toBe(false);
		});

		it("should not retry on undefined error", () => {
			expect(handler.isRetryable(undefined)).toBe(false);
		});

		it("should retry on TimeoutError name", () => {
			expect(
				handler.isRetryable(
					Object.assign(new Error(), { name: "TimeoutError" }),
				),
			).toBe(true);
		});

		it("should retry on network-related message", () => {
			expect(handler.isRetryable(new Error("Network connection lost"))).toBe(
				true,
			);
		});

		it("should not retry on generic error", () => {
			expect(handler.isRetryable(new Error("something went wrong"))).toBe(
				false,
			);
		});
	});
});
