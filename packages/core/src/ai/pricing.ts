/**
 * Approximate per-model pricing (USD per 1,000,000 tokens) used to estimate
 * running cost in the control center. Rates are { input, output } in USD / 1M
 * tokens and are matched by substring against the model id (case-insensitive,
 * first match wins — more specific keys are listed before their prefixes).
 *
 * IMPORTANT — what these numbers mean:
 *  - Sources are the official provider pricing pages, cross-referenced in
 *    June 2026 (see per-provider comments below). They reflect the PAY-AS-YOU-GO
 *    API rate. Real billed cost depends on how the provider is accessed:
 *      * OpenAI Codex (gpt-5.5) and z.ai / Zhipu are used here via SUBSCRIPTION
 *        (ChatGPT account / coding-plan), so the actual per-token bill is ~$0 —
 *        these API rates are shown only to make token usage comparable.
 *      * OpenAI's pages confirm reasoning tokens are billed as OUTPUT tokens.
 *  - GLM rates are converted from CNY (open.bigmodel.cn) at ~7.15 CNY/USD.
 *  - Mistral could not be fetched at research time (network error) — those rows
 *    are best-effort and should be re-checked.
 *  - gemini-2.0-flash was deprecated/shut down on 2026-06-01; keep its entry
 *    for historical estimates but prefer 2.5/3.x.
 *  - Local/self-hosted providers (ollama) are free.
 */

type Rate = { input: number; output: number };

const FREE: Rate = { input: 0, output: 0 };

// Specific model overrides, matched by substring against the model id
// (case-insensitive). First match wins — order matters, so put more specific
// (longer / suffixed) keys BEFORE their prefixes (e.g. "-mini" before "-",
// "-4-1" before bare "-4").
const MODEL_RATES: Array<{ match: string; rate: Rate }> = [
	// ── OpenAI  (developers.openai.com — verified 2026-06) ──────────────────
	{ match: "gpt-5.5-pro", rate: { input: 30, output: 180 } },
	{ match: "gpt-5.5", rate: { input: 5, output: 30 } }, // flagship
	{ match: "gpt-5.4-pro", rate: { input: 30, output: 180 } },
	{ match: "gpt-5.4-mini", rate: { input: 0.75, output: 4.5 } },
	{ match: "gpt-5.4-nano", rate: { input: 0.2, output: 1.25 } },
	{ match: "gpt-5.4", rate: { input: 2.5, output: 15 } },
	{ match: "gpt-5.3-codex", rate: { input: 1.75, output: 14 } }, // Codex model
	{ match: "gpt-5-codex", rate: { input: 1.75, output: 14 } },
	{ match: "gpt-5.2", rate: { input: 1.75, output: 14 } },
	{ match: "gpt-5.1", rate: { input: 1.25, output: 10 } },
	{ match: "gpt-5-mini", rate: { input: 0.25, output: 2 } },
	{ match: "gpt-5-nano", rate: { input: 0.05, output: 0.4 } },
	{ match: "chat-latest", rate: { input: 5, output: 30 } }, // ChatGPT alias
	{ match: "computer-use-preview", rate: { input: 1.5, output: 6 } },
	{ match: "gpt-4.1-mini", rate: { input: 0.4, output: 1.6 } },
	{ match: "gpt-4.1-nano", rate: { input: 0.1, output: 0.4 } },
	{ match: "gpt-4.1", rate: { input: 2, output: 8 } },
	{ match: "gpt-4o-mini", rate: { input: 0.15, output: 0.6 } },
	{ match: "gpt-4o", rate: { input: 2.5, output: 10 } },
	{ match: "o4-mini", rate: { input: 1.1, output: 4.4 } },
	{ match: "o3-mini", rate: { input: 1.1, output: 4.4 } },
	{ match: "o3", rate: { input: 2, output: 8 } },
	{ match: "o1-mini", rate: { input: 1.1, output: 4.4 } },
	{ match: "o1", rate: { input: 15, output: 60 } },

	// ── Anthropic  (anthropic.com/pricing — verified 2026-06) ───────────────
	// Opus dropped to $5/$25 from version 4.5 on (4.0/4.1 were $15/$75).
	{ match: "fable-5", rate: { input: 10, output: 50 } },
	{ match: "claude-opus-4-1", rate: { input: 15, output: 75 } }, // legacy 4.0/4.1
	{ match: "claude-opus", rate: { input: 5, output: 25 } }, // 4.5/4.6/4.7/4.8
	{ match: "claude-sonnet", rate: { input: 3, output: 15 } },
	{ match: "claude-haiku", rate: { input: 1, output: 5 } },

	// ── Google Gemini  (ai.google.dev — verified 2026-06, ≤200K tier) ───────
	{ match: "gemini-3.5-flash", rate: { input: 1.5, output: 9 } },
	{ match: "gemini-3-flash", rate: { input: 0.5, output: 3 } },
	{ match: "gemini-3-pro", rate: { input: 2, output: 12 } },
	{ match: "gemini-2.5-pro", rate: { input: 1.25, output: 10 } },
	{ match: "gemini-2.5-flash-lite", rate: { input: 0.1, output: 0.4 } },
	{ match: "gemini-2.5-flash", rate: { input: 0.3, output: 2.5 } },
	{ match: "gemini-2.0-flash-lite", rate: { input: 0.075, output: 0.3 } },
	{ match: "gemini-2.0-flash", rate: { input: 0.1, output: 0.4 } }, // deprecated 2026-06-01
	{ match: "gemini-1.5-pro", rate: { input: 1.25, output: 5 } },
	{ match: "gemini-1.5-flash", rate: { input: 0.075, output: 0.3 } },

	// ── Zhipu / GLM  (open.bigmodel.cn — CNY converted ~7.15) ───────────────
	// Note: when accessed via z.ai coding-plan this is a SUBSCRIPTION, so the
	// real per-token bill is ~$0; these are API-equivalent rates for estimation.
	{ match: "glm-5v-turbo", rate: { input: 0.7, output: 3.08 } },
	{ match: "glm-5.2", rate: { input: 1.12, output: 3.92 } },
	{ match: "glm-5.1", rate: { input: 0.84, output: 3.36 } },
	{ match: "glm-5-turbo", rate: { input: 0.7, output: 3.08 } },
	{ match: "glm-4.7-flashx", rate: { input: 0.07, output: 0.42 } },
	{ match: "glm-4.7-flash", rate: FREE }, // free tier
	{ match: "glm-4.7", rate: { input: 0.28, output: 1.12 } },
	{ match: "glm-4.6v", rate: { input: 0.14, output: 0.42 } },
	{ match: "glm-4.5-air", rate: { input: 0.11, output: 0.28 } },
	{ match: "glm-4-plus", rate: { input: 0.7, output: 0.7 } },
	{ match: "glm-4-long", rate: { input: 0.14, output: 0.14 } },
	{ match: "glm-4-airx", rate: { input: 1.4, output: 1.4 } },
	{ match: "glm-4-air", rate: { input: 0.07, output: 0.07 } },
	{ match: "glm-", rate: { input: 0.56, output: 2.52 } }, // GLM-5 default tier

	// ── DeepSeek  (api-docs.deepseek.com — verified 2026-06) ────────────────
	// v4-flash = deepseek-chat / deepseek-reasoner (thinking); v4-pro is higher.
	{ match: "deepseek-v4-pro", rate: { input: 0.435, output: 0.87 } },
	{ match: "deepseek-v4-flash", rate: { input: 0.14, output: 0.28 } },
	{ match: "deepseek-reasoner", rate: { input: 0.14, output: 0.28 } },
	{ match: "deepseek-chat", rate: { input: 0.14, output: 0.28 } },
	{ match: "deepseek", rate: { input: 0.14, output: 0.28 } },

	// ── xAI / Grok  (docs.x.ai — verified 2026-06: grok-4.3 $1.25/$2.50) ────
	// Older grok-4.20 uses the current flagship rate as the closest proxy.
	{ match: "grok-build", rate: { input: 1, output: 2 } },
	{ match: "grok-4", rate: { input: 1.25, output: 2.5 } },
	{ match: "grok", rate: { input: 1.25, output: 2.5 } },

	// ── Cohere  (cohere.com/pricing — verified 2026-06 via pricing FAQ) ─────
	{ match: "command-r-plus", rate: { input: 2.5, output: 10 } },
	{ match: "command-a", rate: { input: 2.5, output: 10 } },
	{ match: "command-r7b", rate: { input: 0.15, output: 0.3 } },
	{ match: "command-r", rate: { input: 0.5, output: 1.5 } },
	{ match: "aya-expanse", rate: { input: 0.5, output: 1.5 } },
	{ match: "command-light", rate: { input: 0.3, output: 0.6 } },
	{ match: "command", rate: { input: 1, output: 2 } },

	// ── Mistral  (NOT VERIFIED — pricing page unreachable; best-effort) ─────
	{ match: "mistral-large", rate: { input: 2, output: 8 } },
	{ match: "codestral", rate: { input: 0.3, output: 0.3 } },
	{ match: "mistral-medium", rate: { input: 0.4, output: 2 } },
	{ match: "mistral-small", rate: { input: 0.2, output: 0.6 } },
	{ match: "mistral", rate: { input: 0.3, output: 0.9 } },
];

// Per-provider fallback rate (flagship tier) when no model override matches.
const PROVIDER_DEFAULT: Record<string, Rate> = {
	openai: { input: 5, output: 30 }, // gpt-5.5 flagship
	anthropic: { input: 3, output: 15 }, // claude-sonnet
	google: { input: 1.25, output: 10 }, // gemini-2.5-pro
	zhipu: { input: 1.12, output: 3.92 }, // GLM-5.2
	deepseek: { input: 0.14, output: 0.28 }, // deepseek-v4-flash
	mistral: { input: 2, output: 8 }, // mistral-large (best-effort)
	xai: { input: 1.25, output: 2.5 }, // grok-4.3
	cohere: { input: 2.5, output: 10 }, // command-a
	openrouter: { input: 2, output: 8 },
	ollama: FREE,
	local: FREE,
};

function normalize(value: string): string {
	return value.toLowerCase();
}

/** Look up the rate for a provider + model id. */
export function getRate(provider: string, model?: string): Rate {
	const modelId = normalize(model ?? "");
	for (const entry of MODEL_RATES) {
		if (modelId.includes(entry.match)) return entry.rate;
	}
	return PROVIDER_DEFAULT[normalize(provider)] ?? FREE;
}

/**
 * Estimated USD cost for a request.
 * provider: provider key (e.g. "anthropic").
 * model: full model id (e.g. "claude-sonnet-4-6").
 */
export function estimateCost(
	provider: string,
	model: string | undefined,
	promptTokens: number,
	completionTokens: number,
): number {
	const rate = getRate(provider, model);
	const cost =
		(promptTokens / 1_000_000) * rate.input +
		(completionTokens / 1_000_000) * rate.output;
	return Number.isFinite(cost) && cost > 0 ? cost : 0;
}
