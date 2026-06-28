import { describe, expect, it } from "vitest";
import {
	computeBackoffDelay,
	isRetryableProviderError,
	isSchemaValidationError,
	isZaiOverloadError,
} from "../ai/router.js";

describe("isRetryableProviderError", () => {
	it("retries network/transient errors", () => {
		expect(isRetryableProviderError(new Error("fetch failed"))).toBe(true);
		expect(isRetryableProviderError(new Error("ETIMEDOUT"))).toBe(true);
		expect(isRetryableProviderError(new Error("socket hang up"))).toBe(true);
	});

	it("retries provider rate-limit (HTTP 429 / 503) errors so parallel workers back off instead of dying", () => {
		expect(
			isRetryableProviderError(
				new Error('Z.ai API error (coding-plan): 429 {"error":{"code":"429"}}'),
			),
		).toBe(true);
		expect(
			isRetryableProviderError(new Error("HTTP 503 Service Unavailable")),
		).toBe(true);
		expect(isRetryableProviderError(new Error("rate limit exceeded"))).toBe(
			true,
		);
		expect(isRetryableProviderError(new Error("Too Many Requests"))).toBe(true);
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

describe("isZaiOverloadError", () => {
	it("detects Z.ai coding-plan 429 with body code 1305 (overload)", () => {
		expect(
			isZaiOverloadError(
				new Error(
					'Z.ai API error (coding-plan): 429 {"error":{"code":1305,"message":"The service may be temporarily overloaded"}}',
				),
			),
		).toBe(true);
	});

	it("does not classify a generic 429 (quota) as overload", () => {
		expect(
			isZaiOverloadError(
				new Error('Z.ai API error (coding-plan): 429 {"error":{"code":"429"}}'),
			),
		).toBe(false);
		expect(isZaiOverloadError(new Error("HTTP 503 Service Unavailable"))).toBe(
			false,
		);
	});
});

describe("isSchemaValidationError", () => {
	it("detects payload/schema rejections", () => {
		expect(
			isSchemaValidationError(
				new Error("API error (openrouter): 400 Extra inputs are not permitted"),
			),
		).toBe(true);
		expect(isSchemaValidationError(new Error("invalid schema"))).toBe(true);
		expect(
			isSchemaValidationError(new Error("HTTP 400 Bad Request: bad prompt")),
		).toBe(false);
	});
});

describe("computeBackoffDelay", () => {
	const base = 1500;

	it("fails fast (-1) on schema-validation errors", () => {
		expect(
			computeBackoffDelay(
				new Error("Extra inputs are not permitted, field: foo"),
				0,
				base,
			),
		).toBe(-1);
	});

	it("uses the escalating schedule for z.ai overload (30/60/90/120s + jitter)", () => {
		const d0 = computeBackoffDelay(
			new Error('Z.ai API error (coding-plan): 429 {"error":{"code":1305}}'),
			0,
			base,
		);
		const d1 = computeBackoffDelay(
			new Error(
				'Z.ai API error (coding-global): 429 {"error":{"code":1305,"message":"temporarily overloaded"}}',
			),
			1,
			base,
		);
		expect(d0).toBeGreaterThanOrEqual(30_000);
		expect(d0).toBeLessThan(35_000);
		expect(d1).toBeGreaterThanOrEqual(60_000);
		expect(d1).toBeLessThan(65_000);
	});

	it("applies decorrelated full jitter in [exp/2, exp] for normal transient errors", () => {
		for (let i = 0; i < 500; i++) {
			const delay = computeBackoffDelay(new Error("fetch failed"), 1, base);
			// attempt 1 → exp = min(1500*2, 30000) = 3000; jitter in [1500, 3000]
			expect(delay).toBeGreaterThanOrEqual(1500);
			expect(delay).toBeLessThanOrEqual(3000);
		}
	});

	it("caps exponential growth at 30s", () => {
		for (let i = 0; i < 200; i++) {
			const delay = computeBackoffDelay(new Error("ETIMEDOUT"), 8, base);
			expect(delay).toBeGreaterThanOrEqual(15_000); // cap/2
			expect(delay).toBeLessThanOrEqual(30_000); // cap
		}
	});
});
