import { getModelContextWindow } from "../ai/model-context.js";
import type { LLMRouter } from "../ai/router.js";
import { TokenCounter } from "../ai/tokenizer.js";
import type { LLMMessage } from "../ai/types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("rolling-context");
const UNTRUSTED_CONTEXT_START = "<<<OCTOPUS_UNTRUSTED_CONTEXT_V1>>>";
const UNTRUSTED_CONTEXT_END = "<<<END_OCTOPUS_UNTRUSTED_CONTEXT_V1>>>";
const ROLLING_SUMMARY_SOURCE = '"source":"rolling_context"';

const SUMMARY_PROMPT = `You are a context compression assistant for Octopus AI. Your job is to summarize a conversation segment into a dense, information-rich summary that preserves ALL important context for the AI to continue the conversation seamlessly.

Rules:
1. Preserve ALL factual details: file paths, URLs, image IDs, media references, tool results (success/failure), user requests, decisions made.
2. Preserve the CHRONOLOGICAL ORDER of events.
3. For tool executions: report the FINAL outcome. If a tool initially failed but later succeeded (e.g., via automatic retries), report the SUCCESS, not the intermediate failure.
4. Preserve any media URLs, image references, or file paths that were generated or referenced.
5. Preserve the user's goals and preferences.
6. Be concise but COMPLETE — do not omit any actionable information.
7. Use clear section headers: [User Request], [Actions Taken], [Results], [Key Data], [Retrieval Hints].
8. The [Retrieval Hints] section is mandatory. Include exact search strings the agent can use if a specific detail is missing from the summary: unique filenames, paths, URLs, media IDs, tool names, error fragments, commands, user phrases, and message refs like segment-message #012.
9. Retrieval hints must explain where/how to recover details: use the raw conversation search tool with those exact keywords; start with exact quoted strings, then broaden to related terms.
10. Preserve task state explicitly: label tasks as COMPLETED, PARTIAL, FAILED, or PENDING. If the assistant already generated/imported/delivered an output, mark it COMPLETED and include the final output/media URL/path when visible.
11. Preserve user corrections as procedural rules. If the user explains why a tool call failed or how a workflow should work, record it under [Key Data] or [Procedure Rules] with exact constraints.
12. Never convert completed work into a pending request. If a later agent reads this summary, it must know what was already done so it does not repeat expensive generation/tool calls unless the user explicitly asks.
13. Output ONLY the summary text. No meta-commentary.`;

/**
 * Configurable context-compression knobs. Mirrors HermesAgent's
 * `compression.*` block (threshold / target_ratio / protect_last_n /
 * protect_first_n / hygiene_hard_message_limit) and opencode's
 * `compaction.*`. Defaults preserve Octopus's prior hardcoded behavior.
 */
export interface CompressionConfig {
	/** Compress at this fraction of the model's context window. */
	threshold: number;
	/** Re-condense the cumulative summary when it exceeds this fraction of the input budget. */
	targetRatio: number;
	/** Minimum recent messages kept uncompressed (HermesAgent `protect_last_n`). */
	protectLastN: number;
	/** First N non-system conversation messages pinned raw across compactions (HermesAgent `protect_first_n`). 0 = pin nothing. */
	protectFirstN: number;
	/** Tokens reserved for model output (subtracted from context window for the input budget). */
	outputReserve: number;
	/** Max tokens for a single summary LLM call. */
	summaryMaxTokens: number;
	/** Max tokens for a summary-condensation LLM call. */
	condenseMaxTokens: number;
	/**
	 * Hard message-count safety valve: force compression when the non-system
	 * message count reaches this, even if the token threshold can't fire
	 * (e.g. API disconnects on oversized sessions). 0 = disabled.
	 * HermesAgent `hygiene_hard_message_limit`.
	 */
	hygieneHardMessageLimit: number;
}

export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
	threshold: 0.8,
	targetRatio: 0.3,
	protectLastN: 20,
	protectFirstN: 0,
	outputReserve: 16384,
	summaryMaxTokens: 4096,
	condenseMaxTokens: 2048,
	hygieneHardMessageLimit: 5000,
};

export class RollingContextManager {
	private tokenCounter = new TokenCounter();
	private currentSummary = "";
	private summarizing = false;
	private readonly compression: CompressionConfig;

	constructor(
		private llmRouter: LLMRouter,
		private onSummaryUpdated?: (summary: string) => Promise<void> | void,
		compressionConfig?: Partial<CompressionConfig>,
	) {
		this.compression = { ...DEFAULT_COMPRESSION_CONFIG, ...compressionConfig };
	}

	reset(): void {
		this.currentSummary = "";
	}

	getSummary(): string {
		return this.currentSummary;
	}

	setSummary(summary: string): void {
		this.currentSummary = summary.trim();
	}

	async maybeSummarize(
		messages: LLMMessage[],
		model: string,
	): Promise<LLMMessage[]> {
		let workingMessages = messages;
		if (this.currentSummary && !this.hasRollingSummary(messages)) {
			workingMessages = this.injectSummaryMessage(messages);
		}

		const contextWindow = getModelContextWindow(model);
		const threshold = Math.floor(contextWindow * this.compression.threshold);
		const inputBudget = contextWindow - this.compression.outputReserve;
		const currentTokens =
			this.tokenCounter.countMessagesTokens(workingMessages);

		// Hygiene safety valve: force compression on message count alone, even
		// when token accounting can't fire (e.g. API disconnects on oversized
		// sessions). Mirrors HermesAgent `hygiene_hard_message_limit`.
		const nonSystemCount = workingMessages.filter(
			(m) => m.role !== "system",
		).length;
		const hygieneForce =
			this.compression.hygieneHardMessageLimit > 0 &&
			nonSystemCount >= this.compression.hygieneHardMessageLimit;

		if (currentTokens < threshold && !hygieneForce) {
			logger.debug(
				`Context at ${currentTokens}/${inputBudget} tokens (${((currentTokens / inputBudget) * 100).toFixed(1)}%) — below ${this.compression.threshold * 100}% threshold, no summarization needed.`,
			);
			return workingMessages;
		}

		logger.info(
			`Context reached ${currentTokens}/${inputBudget} tokens (${((currentTokens / inputBudget) * 100).toFixed(1)}%)${hygieneForce ? ` [hygiene valve: ${nonSystemCount} messages]` : ""} — triggering rolling summarization.`,
		);

		return this.summarizeAndCompress(workingMessages, model, inputBudget);
	}

	private hasRollingSummary(messages: LLMMessage[]): boolean {
		return messages.some((message) => this.isRollingSummaryMessage(message));
	}

	private buildSummaryMessage(): LLMMessage {
		const record = JSON.stringify({
			provenance: {
				kind: "recovered_context",
				source: "rolling_context",
				sourceTrust: "mixed:user,agent,tool",
				retrievedAt: new Date().toISOString(),
			},
			data: { summary: this.currentSummary },
		})
			.replace(/</g, "\\u003c")
			.replace(/>/g, "\\u003e");
		return {
			role: "user",
			content: [UNTRUSTED_CONTEXT_START, record, UNTRUSTED_CONTEXT_END].join(
				"\n",
			),
		};
	}

	private isRollingSummaryMessage(message: LLMMessage): boolean {
		return (
			typeof message.content === "string" &&
			message.content.includes(UNTRUSTED_CONTEXT_START) &&
			message.content.includes(ROLLING_SUMMARY_SOURCE)
		);
	}

	private injectSummaryMessage(messages: LLMMessage[]): LLMMessage[] {
		let insertAt = 0;
		for (let i = 0; i < messages.length; i++) {
			if (messages[i].role === "system") insertAt = i + 1;
		}
		return [
			...messages.slice(0, insertAt),
			this.buildSummaryMessage(),
			...messages.slice(insertAt),
		];
	}

	private async notifySummaryUpdated(): Promise<void> {
		if (!this.onSummaryUpdated || !this.currentSummary.trim()) return;
		await this.onSummaryUpdated(this.currentSummary);
	}

	private async summarizeAndCompress(
		messages: LLMMessage[],
		model: string,
		inputBudget: number,
	): Promise<LLMMessage[]> {
		const { systemMessages, conversationMessages: rawConversationMessages } =
			this.splitSystemAndConversation(messages);
		const conversationMessages = rawConversationMessages.filter(
			(message) => !this.isRollingSummaryMessage(message),
		);

		const protectFirstN = Math.max(0, this.compression.protectFirstN);
		const protectLastN = Math.max(1, this.compression.protectLastN);

		// Pin the first N non-system conversation messages raw so the original
		// goal survives every compaction (HermesAgent `protect_first_n`).
		const protectedHead =
			protectFirstN > 0 ? conversationMessages.slice(0, protectFirstN) : [];
		const remaining = conversationMessages.slice(protectedHead.length);

		if (remaining.length <= protectLastN) {
			logger.debug("Conversation too short to summarize, returning as-is.");
			return messages;
		}

		const rawRecent = remaining.slice(-protectLastN);
		const toSummarize = remaining.slice(0, -protectLastN);

		if (toSummarize.length === 0) {
			return messages;
		}

		const summaryText = await this.generateSummary(toSummarize, model);

		this.currentSummary = this.currentSummary
			? `${this.currentSummary}\n\n### Additional Summary\n${summaryText}`
			: summaryText;

		const totalSummaryTokens = this.tokenCounter.countTokens(
			this.currentSummary,
		);
		if (totalSummaryTokens > inputBudget * this.compression.targetRatio) {
			this.currentSummary = await this.condenseExistingSummary(
				this.currentSummary,
				model,
			);
		}
		await this.notifySummaryUpdated();

		const summaryMessage = this.buildSummaryMessage();

		const compressed: LLMMessage[] = [
			...systemMessages,
			summaryMessage,
			...protectedHead,
			...rawRecent,
		];

		const previousTokens = this.tokenCounter.countMessagesTokens(messages);
		const newTokens = this.tokenCounter.countMessagesTokens(compressed);
		logger.info(
			`Rolling context compressed: ${previousTokens} → ${newTokens} tokens (kept ${protectLastN} raw + ${protectedHead.length} pinned + summary)`,
		);

		// Single pass per call. Progressive compaction across calls handles
		// further growth (each call compresses the front-`protectLastN`). The
		// previous in-method recursion here was dead code (its guard could never
		// fire) and is intentionally removed.
		return compressed;
	}

	private async generateSummary(
		messages: LLMMessage[],
		model: string,
	): Promise<string> {
		if (this.summarizing) {
			return this.heuristicSummary(messages);
		}
		this.summarizing = true;

		try {
			const formatted = messages
				.map((m, index) => {
					const content =
						typeof m.content === "string"
							? m.content
							: m.content
									.filter((p) => p.type === "text")
									.map((p) => (p as { text: string }).text)
									.join("\n");
					const truncated =
						content.length > 3000
							? `${content.slice(0, 1500)}\n...[truncated]...\n${content.slice(-1500)}`
							: content;
					return `[segment-message #${String(index + 1).padStart(3, "0")} role=${m.role}] ${truncated}`;
				})
				.join("\n---\n");
			const retrievalMap = this.buildRetrievalMap(messages);

			const response = await this.llmRouter.chat({
				model: this.getSummaryModel(model),
				messages: [
					{ role: "system", content: SUMMARY_PROMPT },
					{
						role: "user",
						content: `Summarize this conversation segment. Preserve ALL important details, tool outcomes, media references, and user goals. Include a mandatory [Retrieval Hints] section based on the retrieval map so a future agent can find exact missing details in the raw conversation.\n\nRetrieval map:\n${retrievalMap}\n\nConversation segment:\n${formatted}`,
					},
				],
				maxTokens: this.compression.summaryMaxTokens,
				temperature: 0.1,
			});

			return response.content?.trim() || this.heuristicSummary(messages);
		} catch (err) {
			logger.warn(
				`LLM summarization failed, using heuristic: ${err instanceof Error ? err.message : String(err)}`,
			);
			return this.heuristicSummary(messages);
		} finally {
			this.summarizing = false;
		}
	}

	private async condenseExistingSummary(
		existingSummary: string,
		model: string,
	): Promise<string> {
		try {
			const response = await this.llmRouter.chat({
				model: this.getSummaryModel(model),
				messages: [
					{
						role: "system",
						content:
							"Compress the following conversation summary into a more compact form while preserving ALL key facts, tool outcomes, media references, URLs, file paths, user goals, and the [Retrieval Hints] search map. Keep enough exact search strings for a future agent to recover missing details from raw conversation search. Output ONLY the compressed summary.",
					},
					{ role: "user", content: existingSummary },
				],
				maxTokens: this.compression.condenseMaxTokens,
				temperature: 0.1,
			});
			return response.content?.trim() || existingSummary;
		} catch {
			const half = Math.floor(existingSummary.length / 2);
			return `${existingSummary.slice(0, half)}\n...[summary condensed]...\n${existingSummary.slice(-half)}`;
		}
	}

	private buildRetrievalMap(messages: LLMMessage[]): string {
		const hints: string[] = [];
		const seen = new Set<string>();
		const addHint = (label: string, value: string, messageIndex: number) => {
			const normalized = value.trim().replace(/\s+/g, " ");
			if (!normalized || seen.has(`${label}:${normalized}`)) return;
			seen.add(`${label}:${normalized}`);
			hints.push(
				`- ${label}: "${normalized}" near segment-message #${String(messageIndex + 1).padStart(3, "0")}`,
			);
		};

		messages.forEach((message, index) => {
			const content = this.getTextContent(message);
			if (!content) return;

			for (const url of content.match(/https?:\/\/[^\s)|\]]+/g) ?? []) {
				addHint("url", url, index);
			}
			for (const media of content.match(/\/api\/media\/file\/[^\s)|\]]+/g) ??
				[]) {
				addHint("media", media, index);
			}
			for (const filePath of content.match(
				/[A-Za-z]:\\(?:[^\s<>:"|?*\n]+\\)*[^\s<>:"|?*\n]+|(?:^|[\s`"'])\.?\/?(?:packages|src|docs|scripts|\.kilo|docker)\/[A-Za-z0-9._\-/]+/g,
			) ?? []) {
				addHint("path", filePath.trim().replace(/^[`"'\s]+/, ""), index);
			}
			for (const command of content.match(
				/(?:pnpm|npm|git|node|turbo|tsc|vite|docker)\s+[^\n`]{2,160}/g,
			) ?? []) {
				addHint("command", command, index);
			}
			for (const error of content.match(
				/(?:Error|ERROR|Failed|FAILED|Exception|TypeError|ReferenceError|EPERM|ENOENT)[^\n]{0,180}/g,
			) ?? []) {
				addHint("error", error, index);
			}
			if (message.role === "tool") {
				const firstLine = content.split("\n").find((line) => line.trim());
				if (firstLine) addHint("tool-output", firstLine.slice(0, 180), index);
			}
			if (message.role === "user") {
				const firstSentence = content
					.split(/[.!?\n]/)
					.find((part) => part.trim().length >= 12);
				if (firstSentence)
					addHint("user-phrase", firstSentence.slice(0, 180), index);
			}
		});

		if (hints.length === 0) {
			return "- No strong anchors found. Search the raw conversation by the user's exact wording, relevant tool names, or recent file/path terms.";
		}

		return hints.slice(0, 80).join("\n");
	}

	private getTextContent(message: LLMMessage): string {
		if (typeof message.content === "string") return message.content;
		return message.content
			.filter((part) => part.type === "text")
			.map((part) => (part as { text: string }).text)
			.join("\n");
	}

	private heuristicSummary(messages: LLMMessage[]): string {
		const parts: string[] = [];

		const userMsgs = messages
			.filter((m) => m.role === "user")
			.map((m) => this.getTextContent(m).slice(0, 300))
			.filter(Boolean);
		if (userMsgs.length > 0) {
			parts.push(`[User Requests] ${userMsgs.join(" | ")}`);
		}

		const assistantMsgs = messages
			.filter((m) => m.role === "assistant")
			.map((m) => this.getTextContent(m).slice(0, 500))
			.filter(Boolean);
		if (assistantMsgs.length > 0) {
			parts.push(`[Assistant Responses] ${assistantMsgs.join(" | ")}`);
		}

		const toolMsgs = messages
			.filter((m) => m.role === "tool")
			.map((m) => {
				const content = this.getTextContent(m).slice(0, 500);
				const isError = content.startsWith("Error:");
				return `${isError ? "FAILED" : "OK"}: ${content.slice(0, 200)}`;
			});
		if (toolMsgs.length > 0) {
			parts.push(`[Tool Results] ${toolMsgs.join("; ")}`);
		}

		const urls = messages
			.flatMap((m) => {
				const content = this.getTextContent(m);
				return content.match(/https?:\/\/[^\s)|\]]+/g) || [];
			})
			.filter((v, i, a) => a.indexOf(v) === i)
			.slice(0, 10);
		if (urls.length > 0) {
			parts.push(`[Key URLs] ${urls.join(", ")}`);
		}

		const mediaRefs = messages
			.flatMap((m) => {
				const content = this.getTextContent(m);
				return content.match(/\/api\/media\/file\/[^\s)|\]]+/g) || [];
			})
			.filter((v, i, a) => a.indexOf(v) === i)
			.slice(0, 10);
		if (mediaRefs.length > 0) {
			parts.push(`[Media Files] ${mediaRefs.join(", ")}`);
		}

		parts.push(`[Retrieval Hints]\n${this.buildRetrievalMap(messages)}`);

		return parts.join("\n");
	}

	private splitSystemAndConversation(messages: LLMMessage[]): {
		systemMessages: LLMMessage[];
		conversationMessages: LLMMessage[];
	} {
		const systemMessages: LLMMessage[] = [];
		const conversationMessages: LLMMessage[] = [];

		let lastSystemIdx = -1;
		for (let i = 0; i < messages.length; i++) {
			if (messages[i].role === "system") {
				lastSystemIdx = i;
			}
		}

		for (let i = 0; i < messages.length; i++) {
			if (i <= lastSystemIdx && messages[i].role === "system") {
				systemMessages.push(messages[i]);
			} else {
				conversationMessages.push(messages[i]);
			}
		}

		return { systemMessages, conversationMessages };
	}

	private getSummaryModel(model: string): string {
		if (model.includes("/")) return model;
		return model;
	}
}
