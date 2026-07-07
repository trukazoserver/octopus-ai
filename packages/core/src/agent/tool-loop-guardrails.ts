/**
 * Tool-loop guardrails — Octopus's equivalent of HermesAgent's
 * `tool_loop_guardrails`. Detects three unproductive-loop patterns and applies
 * a warn-after-N / hard-stop-after-M policy:
 *
 * - `exact_failure`: the same tool called with the same arguments failing
 *   repeatedly (warn `warnAfter.exactFailure`, block `hardStopAfter.exactFailure`).
 * - `same_tool_failure`: the same tool failing with different arguments
 *   (warn `warnAfter.sameToolFailure`, block `hardStopAfter.sameToolFailure`).
 * - `idempotent_no_progress`: a successful call returning the same result with
 *   no objective progress (warn `warnAfter.idempotentNoProgress`, block
 *   `hardStopAfter.idempotentNoProgress`).
 *
 * Swarm workers run with `workerHardStopEnabled` (circuit-break on hard-stop,
 * unattended); the interactive main loop warns only by default.
 */

export type GuardrailPattern =
	| "exact_failure"
	| "same_tool_failure"
	| "idempotent_no_progress";

export type GuardrailAction = "continue" | "warn" | "block";

export interface GuardrailVerdict {
	action: GuardrailAction;
	pattern: GuardrailPattern | null;
	reason: string;
}

export interface ToolLoopGuardrailsThresholds {
	exactFailure: number;
	sameToolFailure: number;
	idempotentNoProgress: number;
}

export interface ToolLoopGuardrailsConfig {
	warningsEnabled: boolean;
	hardStopEnabled: boolean;
	workerHardStopEnabled: boolean;
	warnAfter: ToolLoopGuardrailsThresholds;
	hardStopAfter: ToolLoopGuardrailsThresholds;
}

export const DEFAULT_TOOL_LOOP_GUARDRAILS_CONFIG: ToolLoopGuardrailsConfig = {
	warningsEnabled: true,
	hardStopEnabled: false,
	workerHardStopEnabled: true,
	warnAfter: { exactFailure: 2, sameToolFailure: 3, idempotentNoProgress: 2 },
	hardStopAfter: {
		exactFailure: 5,
		sameToolFailure: 8,
		idempotentNoProgress: 5,
	},
};

export interface GuardrailOutcome {
	toolName: string;
	paramsSignature: string;
	success: boolean;
	/** Stable signature of the tool result content (for idempotent detection). */
	resultSignature: string;
	/** True when the result advanced the objective (e.g. usefulResults increased). */
	progressed: boolean;
}

const CONTINUE: GuardrailVerdict = {
	action: "continue",
	pattern: null,
	reason: "",
};

export class ToolLoopGuardrails {
	private exactFail = new Map<string, number>();
	private sameToolFail = new Map<string, number>();
	private idempotent = new Map<string, number>();
	private blockedSignatures = new Set<string>();

	constructor(
		private config: ToolLoopGuardrailsConfig = DEFAULT_TOOL_LOOP_GUARDRAILS_CONFIG,
	) {}

	/**
	 * Pre-execution consult. Skips the call only when this exact signature was
	 * already hard-stopped on a prior outcome — avoids re-running a call we
	 * already decided to block.
	 */
	beforeCall(
		toolName: string,
		paramsSignature: string,
	): {
		skip: boolean;
		reason: string;
	} {
		if (this.blockedSignatures.has(`${toolName}|${paramsSignature}`)) {
			return {
				skip: true,
				reason: `Repeated action suppressed for ${toolName}. This exact call was already blocked after repeated unproductive outcomes. Stop retrying it; choose a different approach or deliver a final answer with the current evidence.`,
			};
		}
		return { skip: false, reason: "" };
	}

	/**
	 * Post-execution consult. Updates the counters from this outcome and returns
	 * the verdict for it: `warn` (append to the tool result so the model
	 * self-corrects) or `block` (replace the result and stop the loop).
	 */
	recordOutcome(
		outcome: GuardrailOutcome,
		opts: { worker: boolean },
	): GuardrailVerdict {
		const hardStop = opts.worker
			? this.config.workerHardStopEnabled
			: this.config.hardStopEnabled;
		const exactKey = `${outcome.toolName}|${outcome.paramsSignature}`;
		const resultKey = `${outcome.toolName}|${outcome.resultSignature}`;

		// Progress resets every failure/idempotent counter for this tool.
		if (outcome.success && outcome.progressed) {
			this.exactFail.delete(exactKey);
			this.sameToolFail.delete(outcome.toolName);
			this.idempotent.delete(resultKey);
			return CONTINUE;
		}

		if (!outcome.success) {
			const exact = (this.exactFail.get(exactKey) ?? 0) + 1;
			this.exactFail.set(exactKey, exact);
			const sameTool = (this.sameToolFail.get(outcome.toolName) ?? 0) + 1;
			this.sameToolFail.set(outcome.toolName, sameTool);

			if (exact >= this.config.hardStopAfter.exactFailure && hardStop) {
				this.blockedSignatures.add(exactKey);
				return {
					action: "block",
					pattern: "exact_failure",
					reason: `Circuit breaker: ${outcome.toolName} failed ${exact}× with identical arguments. It will not be retried again. Stop attempting this call, summarize what you have, and deliver a final answer or switch to a fundamentally different approach.`,
				};
			}
			if (exact >= this.config.warnAfter.exactFailure) {
				return {
					action: "warn",
					pattern: "exact_failure",
					reason: `Warning: ${outcome.toolName} has failed ${exact}× with the same arguments. Repeating the identical call is unlikely to succeed — change the arguments, fix the underlying cause, or try a different tool.`,
				};
			}
			if (sameTool >= this.config.hardStopAfter.sameToolFailure && hardStop) {
				return {
					action: "block",
					pattern: "same_tool_failure",
					reason: `Circuit breaker: ${outcome.toolName} failed ${sameTool}× in a row (different arguments). The tool appears unhealthy for this task. Stop retrying it and use an alternative or deliver a final answer.`,
				};
			}
			if (sameTool >= this.config.warnAfter.sameToolFailure) {
				return {
					action: "warn",
					pattern: "same_tool_failure",
					reason: `Warning: ${outcome.toolName} has failed ${sameTool}× in a row. Reconsider whether this tool can solve the task, or switch approach.`,
				};
			}
			return CONTINUE;
		}

		// Success without progress → idempotent no-op.
		const idem = (this.idempotent.get(resultKey) ?? 0) + 1;
		this.idempotent.set(resultKey, idem);
		if (idem >= this.config.hardStopAfter.idempotentNoProgress && hardStop) {
			this.blockedSignatures.add(exactKey);
			return {
				action: "block",
				pattern: "idempotent_no_progress",
				reason: `Circuit breaker: ${outcome.toolName} returned the same result ${idem}× with no progress. Repeating it won't advance the task. Summarize what you have and deliver a final answer.`,
			};
		}
		if (idem >= this.config.warnAfter.idempotentNoProgress) {
			return {
				action: "warn",
				pattern: "idempotent_no_progress",
				reason: `Warning: ${outcome.toolName} returned the same result ${idem}× without making progress. Avoid repeating this identical call — the information it provides is already in context.`,
			};
		}
		return CONTINUE;
	}
}
