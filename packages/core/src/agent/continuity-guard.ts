import type { SubtaskTracker, ReconciliationReport } from "./subtask-tracker.js";

export interface ContinuityGuardConfig {
	enabled: boolean;
	maxAutoContinuations: number;
	truncationDetection: boolean;
	/** Detect "promised-but-not-acted" responses and repeated text without tool calls. */
	stallDetection: boolean;
	/** Max number of forced re-prompts before giving up (warning + stop). */
	maxStallForcings: number;
	/** How many recent response signatures to remember for repetition detection. */
	stallSignatureHistory: number;
}

export const DEFAULT_CONTINUITY_GUARD_CONFIG: ContinuityGuardConfig = {
	enabled: true,
	maxAutoContinuations: 25,
	truncationDetection: true,
	stallDetection: true,
	maxStallForcings: 3,
	stallSignatureHistory: 4,
};

export interface ContinuityState {
	originalGoal: string;
	continuationCount: number;
	lastFinishReason: string | null;
	totalToolIterations: number;
	stallForceCount: number;
	recentStallSignatures: string[];
}

export interface StallDecision {
	force: boolean;
	reason: string;
	repeated: boolean;
	exhausted: boolean;
}

/**
 * Intent phrases that signal the model planned an imminent action in its text
 * but did not emit the corresponding tool call. Bilingual ES/EN.
 */
const ACTION_PROMISE_RE =
	/(lo agrego|lo añado|voy a (editar|agreg|añad|modific|cambi|cre|actualiz)|déjame.*?(editar|agreg|añad|modific|leer y .*?agreg|leer y .*?añad)|ahora:|let me (edit|add|update|modify|write|apply|read.*?(?:and|y).*?(?:edit|add|update|modify|write|apply))|i'?ll (edit|add|update|modify|write|apply)|adding now|applying now|updating now)/i;

/**
 * Signals that the stalled text described an edit/write to a file (so the
 * force-act prompt can inject a concrete tool-call scaffold instead of a
 * generic nudge). Bilingual ES/EN.
 */
const EDIT_INTENT_RE =
	/(write_file|manage_workspace|edit_file|editar|editarlo|modific(?:ar|o)|agreg(?:ar|o|ue).*(?:a la lista|al archivo|al c[oó]digo|al config|a la herramienta|a los modelos)|actualiz(?:ar|o).*archivo|cambiar.*c[oó]digo|al index\.mjs|\.(?:ts|js|mjs|mts|json|tsx|py)\b)/i;

export class ContinuityGuard {
	private config: ContinuityGuardConfig;
	private state: ContinuityState;

	constructor(config?: Partial<ContinuityGuardConfig>) {
		this.config = { ...DEFAULT_CONTINUITY_GUARD_CONFIG, ...config };
		this.state = {
			originalGoal: "",
			continuationCount: 0,
			lastFinishReason: null,
			totalToolIterations: 0,
			stallForceCount: 0,
			recentStallSignatures: [],
		};
	}

	reset(goal: string): void {
		this.state = {
			originalGoal: goal,
			continuationCount: 0,
			lastFinishReason: null,
			totalToolIterations: 0,
			stallForceCount: 0,
			recentStallSignatures: [],
		};
	}

	recordFinishReason(reason: string | undefined): void {
		this.state.lastFinishReason = reason ?? "stop";
	}

	recordToolIteration(): void {
		this.state.totalToolIterations++;
	}

	shouldAutoContinue(options: {
		finishReason: string | undefined;
		hasToolCalls: boolean;
		hasContent: boolean;
		iterationCount: number;
		maxIterations: number;
		inlineRunId?: string;
	}): boolean {
		if (!this.config.enabled) return false;
		if (this.state.continuationCount >= this.config.maxAutoContinuations) return false;

		const reason = options.finishReason ?? "stop";

		// Case 1: Response truncated by maxTokens
		if (this.config.truncationDetection && reason === "length") {
			return true;
		}

		// Case 2: Hit iteration limit but had tool calls (work was in progress)
		if (options.iterationCount >= options.maxIterations && options.hasToolCalls) {
			return true;
		}

		// Case 3: Had content but no tool calls AND finish reason is "length"
		// (LLM was generating a long text response that got cut)
		if (options.hasContent && !options.hasToolCalls && reason === "length") {
			return true;
		}

		return false;
	}

	incrementContinuation(): void {
		this.state.continuationCount++;
	}

	/**
	 * Normalize response text into a signature for repetition comparison:
	 * lowercase, strip code blocks/markdown noise, collapse whitespace.
	 */
	private normalizeForSignature(content: string): string {
		return content
			.toLowerCase()
			.replace(/```[\s\S]*?```/g, " ")
			.replace(/`[^`]*`/g, " ")
			.replace(/[>*#_|]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 500);
	}

	private hasActionPromise(content: string): boolean {
		return ACTION_PROMISE_RE.test(content);
	}

	/**
	 * Decide whether a turn that ended without tool calls should be forced into a
	 * retry because the model promised an action it did not perform, or repeated
	 * earlier text without progressing. Returns `exhausted` separately so the
	 * caller can emit a final warning when the retry budget is spent.
	 */
	shouldForceActOnStall(
		content: string,
		finishReason: string | undefined,
	): StallDecision {
		const reason = finishReason ?? "stop";
		const noSignal: StallDecision = {
			force: false,
			reason: "no-signal",
			repeated: false,
			exhausted: false,
		};

		if (!this.config.stallDetection) {
			return { ...noSignal, reason: "disabled" };
		}
		// Truncation is handled by the length-continuation path.
		if (reason === "length") {
			return { ...noSignal, reason: "length-handled-elsewhere" };
		}
		if (!content || content.trim().length === 0) {
			return { ...noSignal, reason: "empty" };
		}

		const exhausted = this.state.stallForceCount >= this.config.maxStallForcings;
		if (exhausted) {
			return { force: false, reason: "exhausted", repeated: false, exhausted: true };
		}

		const signature = this.normalizeForSignature(content);
		const repeated = this.state.recentStallSignatures.includes(signature);
		const promised = this.hasActionPromise(content);

		if (!promised && !repeated) {
			return noSignal;
		}

		return {
			force: true,
			reason: repeated ? "repeated-text-no-action" : "promised-action-no-toolcall",
			repeated,
			exhausted: false,
		};
	}

	/** Record a stall: store the signature and bump the forced-retry counter. */
	recordStall(content: string): void {
		const signature = this.normalizeForSignature(content);
		this.state.recentStallSignatures.push(signature);
		while (this.state.recentStallSignatures.length > this.config.stallSignatureHistory) {
			this.state.recentStallSignatures.shift();
		}
		this.state.stallForceCount++;
	}

	/** Clear accumulated stall state — call when the model produces real progress. */
	clearStall(): void {
		this.state.stallForceCount = 0;
		this.state.recentStallSignatures = [];
	}

	private hasEditIntent(content: string): boolean {
		return EDIT_INTENT_RE.test(content);
	}

	buildForceActPrompt(
		stallReason: string,
		repeated: boolean,
		opts?: { content?: string; attempt?: number },
	): string {
		const attempt = opts?.attempt ?? 1;
		const editIntent = opts?.content ? this.hasEditIntent(opts.content) : false;
		const lines: string[] = [
			"# PENDING ACTION — EXECUTE NOW",
			"",
			repeated
				? "Your previous turns REPEATED the same intention/analysis without emitting any tool call. Repeating intent without acting is blocked."
				: 'Your previous turn stated an intention to act (e.g. "lo agrego ahora" / "voy a editar" / "let me edit") but emitted NO tool call. Stating intent without acting is blocked.',
			"",
			"IMMEDIATELY emit the exact tool call you described. Do NOT re-explain, re-analyze, restate intent, quote the plan again, or produce another preamble.",
		];

		if (editIntent) {
			lines.push(
				"",
				"You said you would edit/add something to a file. Emit that edit as a tool call NOW:",
				'- Call `write_file` with {"path": "<absolute path>", "content": "<full new file content>"} — pass the new content as the `content` argument, NOT in the message text.',
				'- Or call `manage_workspace` with {"action":"write","path":"<absolute path>","content":"..."} if write_file is unavailable.',
				'Example tool call shape: {"name":"write_file","arguments":{"path":"C:\\\\Users\\\\...\\\\file.mjs","content":"..."}}',
			);
		} else {
			lines.push(
				"- If you said you would edit/add an entry to a list: call the Edit tool now with the exact old_string/new_string (or Write).",
				"- If you said you would modify code: call the Edit tool now with the exact old/new snippets.",
			);
		}

		if (attempt >= 2) {
			lines.push(
				"",
				`This is attempt #${attempt}. Output ONLY the tool call this turn — no prose, no explanation, no preamble. The tool call must be the first and only thing you emit.`,
			);
		} else {
			lines.push(
				"Issue exactly ONE concrete tool call this turn. Any text before it must be a single short line at most.",
			);
		}

		if (repeated) {
			lines.push(
				"",
				"This is your final forced attempt before the run stops to avoid an infinite loop.",
			);
		}
		lines.push("", `(stall reason: ${stallReason})`);
		return lines.join("\n");
	}

	buildContinuePrompt(report?: ReconciliationReport | null): string {
		const parts: string[] = [
			"# AUTO-CONTINUATION",
			`Your previous response was truncated (finish reason: ${this.state.lastFinishReason}). Continuation ${this.state.continuationCount}/${this.config.maxAutoContinuations}.`,
			"",
		];

		if (report) {
			parts.push(report.verifiedContext);
			parts.push("");
		}

		parts.push("Continue from where you left off. Do NOT repeat work that was already completed. Be concise - focus on remaining tasks only.");

		return parts.join("\n");
	}

	get continuationCount(): number {
		return this.state.continuationCount;
	}

	get stallForceCount(): number {
		return this.state.stallForceCount;
	}

	get lastFinishReason(): string | null {
		return this.state.lastFinishReason;
	}

	getConfig(): ContinuityGuardConfig {
		return { ...this.config };
	}
}
