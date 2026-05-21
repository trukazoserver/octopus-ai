import type { LLMRouter } from "../ai/router.js";
import { getModelContextWindow } from "../ai/router.js";
import { TokenCounter } from "../ai/tokenizer.js";
import type { LLMMessage } from "../ai/types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("rolling-context");

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
10. Output ONLY the summary text. No meta-commentary.`;

const RAW_TURNS_TO_KEEP = 20;
const CONTEXT_THRESHOLD = 0.8;

export class RollingContextManager {
	private tokenCounter = new TokenCounter();
	private currentSummary = "";
	private summarizing = false;

	constructor(private llmRouter: LLMRouter) {}

	reset(): void {
		this.currentSummary = "";
	}

	getSummary(): string {
		return this.currentSummary;
	}

	async maybeSummarize(
		messages: LLMMessage[],
		model: string,
	): Promise<LLMMessage[]> {
		const contextWindow = getModelContextWindow(model);
		const threshold = Math.floor(contextWindow * CONTEXT_THRESHOLD);
		const outputReserve = 16384;
		const inputBudget = contextWindow - outputReserve;
		const currentTokens = this.tokenCounter.countMessagesTokens(messages);

		if (currentTokens < threshold) {
			logger.debug(
				`Context at ${currentTokens}/${inputBudget} tokens (${((currentTokens / inputBudget) * 100).toFixed(1)}%) — below 80% threshold, no summarization needed.`,
			);
			return messages;
		}

		logger.info(
			`Context reached ${currentTokens}/${inputBudget} tokens (${((currentTokens / inputBudget) * 100).toFixed(1)}%) — triggering rolling summarization.`,
		);

		return this.summarizeAndCompress(messages, model, inputBudget);
	}

	private async summarizeAndCompress(
		messages: LLMMessage[],
		model: string,
		inputBudget: number,
	): Promise<LLMMessage[]> {
		const { systemMessages, conversationMessages } =
			this.splitSystemAndConversation(messages);

		if (conversationMessages.length <= RAW_TURNS_TO_KEEP) {
			logger.debug("Conversation too short to summarize, returning as-is.");
			return messages;
		}

		const rawRecent = conversationMessages.slice(-RAW_TURNS_TO_KEEP);
		const toSummarize = conversationMessages.slice(0, -RAW_TURNS_TO_KEEP);

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
		if (totalSummaryTokens > inputBudget * 0.3) {
			this.currentSummary = await this.condenseExistingSummary(
				this.currentSummary,
				model,
			);
		}

		const summaryMessage: LLMMessage = {
			role: "system",
			content: `## Conversation Summary (rolling context)\nThis is a summary of the earlier part of the conversation. Use it as context for understanding what happened before the recent messages shown below.\n\nIf you need an exact detail that is not present in the summary, do not guess. Use the [Retrieval Hints] section as a search map: call the raw conversation search tool (recall_conversation, if available) with exact filenames, paths, URLs, media IDs, command fragments, error text, or user phrases listed there. Prefer the current conversation first, then broaden only if needed.\n\n${this.currentSummary}`,
		};

		const compressed: LLMMessage[] = [
			...systemMessages,
			summaryMessage,
			...rawRecent,
		];

		const previousTokens = this.tokenCounter.countMessagesTokens(messages);
		const newTokens = this.tokenCounter.countMessagesTokens(compressed);
		logger.info(
			`Rolling context compressed: ${previousTokens} → ${newTokens} tokens (kept ${RAW_TURNS_TO_KEEP} raw turns + summary)`,
		);

		const contextWindow = getModelContextWindow(model);
		const threshold = Math.floor(contextWindow * CONTEXT_THRESHOLD);
		if (newTokens >= threshold && rawRecent.length > RAW_TURNS_TO_KEEP) {
			return this.summarizeAndCompress(compressed, model, inputBudget);
		}

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
				maxTokens: 4096,
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
				maxTokens: 2048,
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
