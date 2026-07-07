import { describe, expect, it } from "vitest";
import {
	DEFAULT_TOOL_LOOP_GUARDRAILS_CONFIG,
	ToolLoopGuardrails,
	type ToolLoopGuardrailsConfig,
} from "../agent/tool-loop-guardrails.js";

const interactive: ToolLoopGuardrailsConfig = {
	...DEFAULT_TOOL_LOOP_GUARDRAILS_CONFIG,
	hardStopEnabled: false,
	workerHardStopEnabled: false,
};

const worker: ToolLoopGuardrailsConfig = {
	...DEFAULT_TOOL_LOOP_GUARDRAILS_CONFIG,
	hardStopEnabled: true,
	workerHardStopEnabled: true,
};

describe("ToolLoopGuardrails — exact_failure", () => {
	it("warns after warnAfter.exactFailure identical failures", () => {
		const g = new ToolLoopGuardrails(interactive);
		g.recordOutcome(
			{
				toolName: "t",
				paramsSignature: "a",
				success: false,
				resultSignature: "err",
				progressed: false,
			},
			{ worker: false },
		);
		const v = g.recordOutcome(
			{
				toolName: "t",
				paramsSignature: "a",
				success: false,
				resultSignature: "err",
				progressed: false,
			},
			{ worker: false },
		);
		expect(v.action).toBe("warn");
		expect(v.pattern).toBe("exact_failure");
	});

	it("blocks after hardStopAfter.exactFailure for workers (and pre-skips next)", () => {
		const g = new ToolLoopGuardrails(worker);
		for (let i = 0; i < 5; i++) {
			g.recordOutcome(
				{
					toolName: "t",
					paramsSignature: "a",
					success: false,
					resultSignature: "err",
					progressed: false,
				},
				{ worker: true },
			);
		}
		const before = g.beforeCall("t", "a");
		expect(before.skip).toBe(true);
	});

	it("does NOT block on the interactive loop (hardStopEnabled false)", () => {
		const g = new ToolLoopGuardrails(interactive);
		for (let i = 0; i < 10; i++) {
			const v = g.recordOutcome(
				{
					toolName: "t",
					paramsSignature: "a",
					success: false,
					resultSignature: "err",
					progressed: false,
				},
				{ worker: false },
			);
			expect(v.action).not.toBe("block");
		}
		expect(g.beforeCall("t", "a").skip).toBe(false);
	});
});

describe("ToolLoopGuardrails — same_tool_failure", () => {
	it("detects the same tool failing with different args", () => {
		const g = new ToolLoopGuardrails(worker);
		for (const args of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
			g.recordOutcome(
				{
					toolName: "t",
					paramsSignature: args,
					success: false,
					resultSignature: "err",
					progressed: false,
				},
				{ worker: true },
			);
		}
		// 8 distinct-arg failures → same_tool_failure block threshold (8)
		const v = g.recordOutcome(
			{
				toolName: "t",
				paramsSignature: "i",
				success: false,
				resultSignature: "err",
				progressed: false,
			},
			{ worker: true },
		);
		expect(v.action).toBe("block");
		expect(v.pattern).toBe("same_tool_failure");
	});
});

describe("ToolLoopGuardrails — idempotent_no_progress", () => {
	it("warns then blocks on repeated identical successful no-progress results", () => {
		const g = new ToolLoopGuardrails(worker);
		// success, no progress, identical result signature
		const outcome = (sig: string) =>
			g.recordOutcome(
				{
					toolName: "t",
					paramsSignature: sig,
					success: true,
					resultSignature: "same",
					progressed: false,
				},
				{ worker: true },
			);
		// Reuse the same params signature so the block marker sticks to it.
		const sig = "a";
		expect(outcome(sig).action).toBe("continue");
		const w = outcome(sig);
		expect(w.action).toBe("warn");
		expect(w.pattern).toBe("idempotent_no_progress");
		for (let i = 0; i < 5; i++) outcome(sig);
		const v = outcome(sig);
		expect(v.action).toBe("block");
		expect(v.pattern).toBe("idempotent_no_progress");
	});

	it("progress resets the counters", () => {
		const g = new ToolLoopGuardrails(worker);
		for (let i = 0; i < 3; i++) {
			g.recordOutcome(
				{
					toolName: "t",
					paramsSignature: "a",
					success: false,
					resultSignature: "err",
					progressed: false,
				},
				{ worker: true },
			);
		}
		// a progressed success resets failure counters
		g.recordOutcome(
			{
				toolName: "t",
				paramsSignature: "a",
				success: true,
				resultSignature: "ok",
				progressed: true,
			},
			{ worker: true },
		);
		// next failure starts fresh (warn threshold is 2, so a single failure is "continue")
		const v = g.recordOutcome(
			{
				toolName: "t",
				paramsSignature: "a",
				success: false,
				resultSignature: "err2",
				progressed: false,
			},
			{ worker: true },
		);
		expect(v.action).toBe("continue");
	});
});

describe("ToolLoopGuardrails — beforeCall", () => {
	it("passes through when not blocked", () => {
		const g = new ToolLoopGuardrails(interactive);
		expect(g.beforeCall("t", "a").skip).toBe(false);
	});
});
