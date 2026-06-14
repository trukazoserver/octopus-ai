import { describe, expect, it } from "vitest";
import { isRetryableProviderError } from "../ai/router.js";

describe("isRetryableProviderError", () => {
	it("retries network/transient errors", () => {
		expect(isRetryableProviderError(new Error("fetch failed"))).toBe(true);
		expect(isRetryableProviderError(new Error("ETIMEDOUT"))).toBe(true);
		expect(isRetryableProviderError(new Error("socket hang up"))).toBe(true);
	});

	it("retries provider rate-limit (HTTP 429 / 503) errors so parallel workers back off instead of dying", () => {
		expect(
			isRetryableProviderError(
				new Error("Z.ai API error (coding-plan): 429 {\"error\":{\"code\":\"429\"}}"),
			),
		).toBe(true);
		expect(
			isRetryableProviderError(new Error("HTTP 503 Service Unavailable")),
		).toBe(true);
		expect(isRetryableProviderError(new Error("rate limit exceeded"))).toBe(
			true,
		);
		expect(isRetryableProviderError(new Error("Too Many Requests"))).toBe(
			true,
		);
	});

	it("does not retry non-transient errors", () => {
		expect(isRetryableProviderError(new Error("HTTP 400 Bad Request"))).toBe(
			false,
		);
		expect(isRetryableProviderError(new Error("Invalid API key"))).toBe(false);
		expect(isRetryableProviderError(null)).toBe(false);
		expect(isRetryableProviderError(undefined)).toBe(false);
	});
});
