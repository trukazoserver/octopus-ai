import { describe, expect, it } from "vitest";
import {
	type ToolResultTruncationLimits,
	truncateToolResultForContext,
} from "../agent/truncate-result.js";
import { TokenCounter } from "../ai/tokenizer.js";

const counter = new TokenCounter();

describe("truncateToolResultForContext", () => {
	it("leaves small results untouched", () => {
		const limits: ToolResultTruncationLimits = {
			maxTokens: 4000,
			maxCharsCeiling: 12000,
		};
		const out = truncateToolResultForContext("hello world", limits, counter);
		expect(out).toBe("hello world");
		expect(out).not.toContain("truncated");
	});

	it("truncates a large result to fit the token budget", () => {
		const limits: ToolResultTruncationLimits = {
			maxTokens: 100,
			maxCharsCeiling: 100_000,
		};
		// ~20k chars → well over 100 tokens.
		const big = "alpha ".repeat(4000);
		expect(big.length).toBeGreaterThan(10000);
		const out = truncateToolResultForContext(big, limits, counter);
		expect(out).toContain("truncated");
		// The kept prefix must fit within the token budget.
		const kept = out.replace(/\n\.\.\.\[tool result truncated.*$/, "");
		expect(counter.countTokens(kept)).toBeLessThanOrEqual(100);
	});

	it("applies the hard char ceiling even when the token budget is loose", () => {
		const limits: ToolResultTruncationLimits = {
			maxTokens: 1_000_000,
			maxCharsCeiling: 5000,
		};
		// Spaced tokens keep tiktoken's pretokener fast (a single repeated char
		// with no spaces is a pathological O(n²) BPE input, not representative).
		const big = "word ".repeat(12_000);
		expect(big.length).toBeGreaterThan(50_000);
		const out = truncateToolResultForContext(big, limits, counter);
		expect(out).toContain("truncated");
		const kept = out.replace(/\n\.\.\.\[tool result truncated.*$/, "");
		// char ceiling wins over the huge token budget
		expect(kept.length).toBeLessThanOrEqual(5000);
	});

	it("honors both caps, taking the tighter one", () => {
		const limits: ToolResultTruncationLimits = {
			maxTokens: 50,
			maxCharsCeiling: 2000,
		};
		const big = "word ".repeat(2000); // ~10k chars, ~2600 tokens
		const out = truncateToolResultForContext(big, limits, counter);
		const kept = out.replace(/\n\.\.\.\[tool result truncated.*$/, "");
		expect(counter.countTokens(kept)).toBeLessThanOrEqual(50);
		expect(kept.length).toBeLessThanOrEqual(2000);
	});
});
