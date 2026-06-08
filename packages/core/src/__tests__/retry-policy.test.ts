import { describe, expect, it } from "vitest";
import {
	createProgressSignature,
	decideRetryAfterFailure,
} from "../agent/retry-policy.js";

describe("retry policy", () => {
	it("blocks after five stagnant failures at the same step", () => {
		let state = {
			stepKey: "generate-image-4",
			progressSignature: "same",
			attemptCount: 0,
			stagnantAttemptCount: 0,
			maxStagnantAttempts: 5,
		};

		for (let i = 0; i < 4; i += 1) {
			const decision = decideRetryAfterFailure(state, {
				stepKey: "generate-image-4",
				progressSignature: "same",
			});
			expect(decision.shouldRetry).toBe(true);
			expect(decision.shouldBlock).toBe(false);
			state = { ...state, ...decision };
		}

		const blocked = decideRetryAfterFailure(state, {
			stepKey: "generate-image-4",
			progressSignature: "same",
		});
		expect(blocked.shouldRetry).toBe(false);
		expect(blocked.shouldBlock).toBe(true);
		expect(blocked.stagnantAttemptCount).toBe(5);
	});

	it("resets stagnant retries when measurable progress changes", () => {
		const decision = decideRetryAfterFailure(
			{
				stepKey: "media-batch",
				progressSignature: "assets:3",
				attemptCount: 4,
				stagnantAttemptCount: 4,
				maxStagnantAttempts: 5,
			},
			{
				stepKey: "media-batch",
				progressSignature: "assets:4",
			},
		);

		expect(decision.shouldRetry).toBe(true);
		expect(decision.shouldBlock).toBe(false);
		expect(decision.stagnantAttemptCount).toBe(1);
		expect(decision.reason).toContain("measurable progress");
	});

	it("creates stable progress signatures", () => {
		const first = createProgressSignature({
			status: "done",
			stepKey: "assets",
			artifacts: ["b", "a"],
		});
		const second = createProgressSignature({
			status: "done",
			stepKey: "assets",
			artifacts: ["a", "b"],
		});

		expect(first).toBe(second);
	});
});
