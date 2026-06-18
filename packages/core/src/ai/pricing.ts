/**
 * Approximate per-model pricing (USD per 1,000,000 tokens) used to estimate
 * running cost in the control center. Rates are best-effort and may lag behind
 * providers' current pricing — refine MODEL_RATES as needed. Local/self-hosted
 * providers (ollama) are free.
 *
 * Rates: { input, output } in USD / 1M tokens.
 */

type Rate = { input: number; output: number };

const FREE: Rate = { input: 0, output: 0 };

// Specific model overrides, matched by substring against the model id
// (case-insensitive). First match wins, so put more specific keys first.
const MODEL_RATES: Array<{ match: string; rate: Rate }> = [
	// Anthropic
	{ match: "claude-opus", rate: { input: 15, output: 75 } },
	{ match: "claude-sonnet", rate: { input: 3, output: 15 } },
	{ match: "claude-haiku", rate: { input: 0.25, output: 1.25 } },
	// OpenAI
	{ match: "o1-mini", rate: { input: 3, output: 12 } },
	{ match: "o1-preview", rate: { input: 6, output: 60 } },
	{ match: "o3", rate: { input: 2, output: 8 } },
	{ match: "gpt-4o-mini", rate: { input: 0.15, output: 0.6 } },
	{ match: "gpt-4o", rate: { input: 2.5, output: 10 } },
	{ match: "gpt-4-turbo", rate: { input: 10, output: 30 } },
	{ match: "gpt-3.5", rate: { input: 0.5, output: 1.5 } },
	// Google
	{ match: "gemini-1.5-pro", rate: { input: 1.25, output: 5 } },
	{ match: "gemini-1.5-flash", rate: { input: 0.075, output: 0.3 } },
	{ match: "gemini-2", rate: { input: 1.25, output: 5 } },
	// Zhipu / GLM
	{ match: "glm-4", rate: { input: 0.5, output: 0.5 } },
	{ match: "glm-", rate: { input: 0.5, output: 0.5 } },
	// DeepSeek
	{ match: "deepseek", rate: { input: 0.14, output: 0.28 } },
	// Mistral
	{ match: "mistral-large", rate: { input: 2, output: 6 } },
	{ match: "mistral", rate: { input: 0.3, output: 0.9 } },
	// xAI
	{ match: "grok", rate: { input: 5, output: 15 } },
	// Cohere
	{ match: "command-r-plus", rate: { input: 2.5, output: 10 } },
	{ match: "command-r", rate: { input: 0.5, output: 1.5 } },
];

// Per-provider fallback rate when no model override matches.
const PROVIDER_DEFAULT: Record<string, Rate> = {
	anthropic: { input: 3, output: 15 },
	openai: { input: 2.5, output: 10 },
	google: { input: 1.25, output: 5 },
	zhipu: { input: 0.5, output: 0.5 },
	deepseek: { input: 0.14, output: 0.28 },
	mistral: { input: 0.3, output: 0.9 },
	xai: { input: 5, output: 15 },
	cohere: { input: 0.5, output: 1.5 },
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
