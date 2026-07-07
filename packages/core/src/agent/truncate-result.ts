import type { TokenCounter } from "../ai/tokenizer.js";

export interface ToolResultTruncationLimits {
	/** Max tokens of a single tool result fed back to the model. */
	maxTokens: number;
	/** Hard char backstop applied after the token cap. */
	maxCharsCeiling: number;
}

/**
 * Truncates tool-result text to a token budget (primary) with a hard char
 * ceiling (backstop). Mirrors HermesAgent `tool_output.max_bytes` and Claude
 * Code `MAX_MCP_OUTPUT_TOKENS`. Fits the token budget exactly via a binary
 * search over the substring length (≈log2(len) tiktoken encodes, only when the
 * result actually exceeds the budget — small results are returned untouched).
 */
export function truncateToolResultForContext(
	content: string,
	limits: ToolResultTruncationLimits,
	counter: TokenCounter,
): string {
	const { maxTokens, maxCharsCeiling } = limits;
	if (
		content.length <= maxCharsCeiling &&
		counter.countTokens(content) <= maxTokens
	) {
		return content;
	}
	const charCap = Math.min(content.length, maxCharsCeiling);
	let lo = 0;
	let hi = charCap;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi + 1) / 2);
		if (counter.countTokens(content.slice(0, mid)) <= maxTokens) lo = mid;
		else hi = mid - 1;
	}
	const cut = Math.min(lo, charCap);
	return `${content.slice(0, cut)}\n...[tool result truncated to keep memory bounded]`;
}
