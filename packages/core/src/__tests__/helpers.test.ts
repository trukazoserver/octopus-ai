import { describe, expect, it, vi } from "vitest";
import {
	deepClone,
	expandTildePath,
	generateId,
	retry,
	sleep,
	truncateToTokenBudget,
} from "../utils/helpers.js";

describe("Helpers", () => {
	describe("expandTildePath", () => {
		it("should expand tilde to home directory", () => {
			const result = expandTildePath("~/.octopus/config.json");
			expect(result.startsWith("~")).toBe(false);
			expect(result).toContain(".octopus");
		});

		it("should not modify paths without tilde", () => {
			const path = "/absolute/path/config.json";
			expect(expandTildePath(path)).toBe(path);
		});

		it("should handle bare tilde", () => {
			const result = expandTildePath("~");
			expect(result).not.toContain("~");
		});
	});

	describe("deepClone", () => {
		it("should deep clone an object", () => {
			const obj = { a: 1, b: { c: 2, d: [3, 4] } };
			const cloned = deepClone(obj);
			expect(cloned).toEqual(obj);
			expect(cloned).not.toBe(obj);
			expect(cloned.b).not.toBe(obj.b);
			expect(cloned.b.d).not.toBe(obj.b.d);
		});

		it("should handle arrays", () => {
			const arr = [1, [2, 3], { a: 4 }];
			const cloned = deepClone(arr);
			expect(cloned).toEqual(arr);
			expect(cloned).not.toBe(arr);
		});

		it("should handle null and primitives", () => {
			expect(deepClone(null)).toBeNull();
			expect(deepClone(42)).toBe(42);
			expect(deepClone("hello")).toBe("hello");
		});
	});

	describe("generateId", () => {
		it("should generate unique IDs", () => {
			const ids = new Set(Array.from({ length: 100 }, () => generateId()));
			expect(ids.size).toBe(100);
		});

		it("should generate IDs of length 12", () => {
			const id = generateId();
			expect(id).toHaveLength(12);
		});
	});

	describe("sleep", () => {
		it("should resolve after specified time", async () => {
			const start = Date.now();
			await sleep(50);
			const elapsed = Date.now() - start;
			expect(elapsed).toBeGreaterThanOrEqual(40);
		});

		it("should resolve immediately with 0", async () => {
			const start = Date.now();
			await sleep(0);
			expect(Date.now() - start).toBeLessThan(50);
		});
	});

	describe("retry", () => {
		it("should return result on first attempt if successful", async () => {
			const result = await retry(() => Promise.resolve("success"), {
				maxAttempts: 3,
				baseDelay: 10,
			});
			expect(result).toBe("success");
		});

		it("should retry on failure and eventually succeed", async () => {
			let attempts = 0;
			const result = await retry(
				() => {
					attempts++;
					if (attempts < 3) throw new Error("fail");
					return Promise.resolve("success");
				},
				{ maxAttempts: 5, baseDelay: 10 },
			);
			expect(result).toBe("success");
			expect(attempts).toBe(3);
		});

		it("should throw after max attempts", async () => {
			await expect(
				retry(() => Promise.reject(new Error("always fail")), {
					maxAttempts: 3,
					baseDelay: 10,
				}),
			).rejects.toThrow("always fail");
		});
	});

	describe("truncateToTokenBudget", () => {
		it("should include items within budget", () => {
			const items = [
				{ text: "a", tokenCount: 10 },
				{ text: "b", tokenCount: 20 },
				{ text: "c", tokenCount: 30 },
			];
			const result = truncateToTokenBudget(items, 50);
			expect(result).toHaveLength(2);
			expect(result[0]?.text).toBe("a");
			expect(result[1]?.text).toBe("b");
		});

		it("should return empty for budget 0", () => {
			const items = [{ text: "a", tokenCount: 10 }];
			const result = truncateToTokenBudget(items, 0);
			expect(result).toHaveLength(0);
		});

		it("should return all items if within budget", () => {
			const items = [
				{ text: "a", tokenCount: 10 },
				{ text: "b", tokenCount: 20 },
			];
			const result = truncateToTokenBudget(items, 100);
			expect(result).toHaveLength(2);
		});
	});
});
