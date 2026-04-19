import { beforeEach, describe, expect, it } from "vitest";
import { CircuitBreaker } from "../connection/circuit.js";

describe("CircuitBreaker", () => {
	it("should start in closed state", () => {
		const cb = new CircuitBreaker();
		expect(cb.state).toBe("closed");
	});

	it("should stay closed on success", async () => {
		const cb = new CircuitBreaker({ threshold: 3 });
		await cb.execute(() => Promise.resolve("ok"));
		expect(cb.state).toBe("closed");
	});

	it("should open after threshold failures", () => {
		const cb = new CircuitBreaker({ threshold: 3, resetTimeout: 60000 });
		cb.recordFailure();
		cb.recordFailure();
		cb.recordFailure();
		expect(cb.state).toBe("open");
	});

	it("should reject calls when open", async () => {
		const cb = new CircuitBreaker({ threshold: 1, resetTimeout: 60000 });
		cb.recordFailure();
		await expect(cb.execute(() => Promise.resolve("ok"))).rejects.toThrow(
			"Circuit breaker is open",
		);
	});

	it("should transition to half-open after reset timeout", () => {
		const cb = new CircuitBreaker({ threshold: 1, resetTimeout: 0 });
		cb.recordFailure();
		expect(cb.state).toBe("half-open");
	});

	it("should close again after success in half-open", async () => {
		const cb = new CircuitBreaker({ threshold: 1, resetTimeout: 0 });
		cb.recordFailure();
		expect(cb.state).toBe("half-open");
		await cb.execute(() => Promise.resolve("ok"));
		expect(cb.state).toBe("closed");
	});

	it("should reset failure count on success", async () => {
		const cb = new CircuitBreaker({ threshold: 3 });
		cb.recordFailure();
		cb.recordFailure();
		expect(cb.failureCount).toBe(2);
		await cb.execute(() => Promise.resolve("ok"));
		expect(cb.failureCount).toBe(0);
		expect(cb.state).toBe("closed");
	});

	it("should track last failure time", () => {
		const cb = new CircuitBreaker();
		const before = Date.now();
		cb.recordFailure();
		expect(cb.lastFailureTime).toBeGreaterThanOrEqual(before);
	});
});
