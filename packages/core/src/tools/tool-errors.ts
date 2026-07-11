import type { ToolErrorCode } from "./registry.js";

/** Compatibility classifier for tools that have not adopted structured codes yet. */
export function classifyToolError(message: string): ToolErrorCode {
	if (/tool not found|unknown tool|method not found/i.test(message))
		return "TOOL_NOT_FOUND";
	if (
		/missing required|invalid (?:argument|parameter)|validation/i.test(message)
	)
		return "INVALID_ARGUMENTS";
	if (/abort|cancel/i.test(message)) return "ABORTED";
	if (/timeout|timed out/i.test(message)) return "TIMEOUT";
	if (
		/security policy|outside allowed|not allowed|blocked command/i.test(message)
	)
		return "SECURITY_BLOCKED";
	if (/billing|payment required|insufficient (?:credit|balance)/i.test(message))
		return "PROVIDER_BILLING";
	if (/quota|rate.?limit|limit.{0,20}(?:exhaust|exceed)|\b429\b/i.test(message))
		return "PROVIDER_QUOTA";
	if (/unauthorized|invalid.?api.?key|\b401\b/i.test(message))
		return "PROVIDER_AUTH";
	if (/permission.?denied|forbidden|\b403\b/i.test(message))
		return "PROVIDER_PERMISSION";
	if (
		/econn|network|fetch failed|\b50[234]\b|service unavailable/i.test(message)
	)
		return "PROVIDER_UNAVAILABLE";
	return "EXECUTION_FAILED";
}

export function isProviderAccessError(
	code: ToolErrorCode | undefined,
): boolean {
	return (
		code === "PROVIDER_AUTH" ||
		code === "PROVIDER_PERMISSION" ||
		code === "PROVIDER_QUOTA" ||
		code === "PROVIDER_BILLING"
	);
}
