export interface RetryProgressState {
	stepKey?: string | null;
	progressSignature?: string | null;
	attemptCount: number;
	stagnantAttemptCount: number;
	maxStagnantAttempts: number;
}

export interface RetryDecision {
	shouldRetry: boolean;
	shouldBlock: boolean;
	stagnantAttemptCount: number;
	attemptCount: number;
	reason: string;
}

export function decideRetryAfterFailure(
	state: RetryProgressState,
	next: { stepKey?: string | null; progressSignature?: string | null },
): RetryDecision {
	const sameStep = (state.stepKey ?? "") === (next.stepKey ?? "");
	const sameProgress =
		(state.progressSignature ?? "") === (next.progressSignature ?? "");
	const advanced = !sameStep || !sameProgress;
	const stagnantAttemptCount = advanced ? 1 : state.stagnantAttemptCount + 1;
	const attemptCount = state.attemptCount + 1;
	const shouldBlock = stagnantAttemptCount >= state.maxStagnantAttempts;

	return {
		attemptCount,
		stagnantAttemptCount,
		shouldRetry: !shouldBlock,
		shouldBlock,
		reason: shouldBlock
			? `The task failed ${stagnantAttemptCount} times at the same step without measurable progress.`
			: advanced
				? "The retry made measurable progress, so the stagnant retry counter was reset."
				: "The retry failed at the same step without measurable progress.",
	};
}

export function createProgressSignature(input: {
	status?: string;
	stepKey?: string | null;
	artifacts?: string[];
	completedSubtasks?: string[];
	verifiedOutputs?: string[];
}): string {
	return JSON.stringify({
		status: input.status ?? "unknown",
		stepKey: input.stepKey ?? null,
		artifacts: [...(input.artifacts ?? [])].sort(),
		completedSubtasks: [...(input.completedSubtasks ?? [])].sort(),
		verifiedOutputs: [...(input.verifiedOutputs ?? [])].sort(),
	});
}
