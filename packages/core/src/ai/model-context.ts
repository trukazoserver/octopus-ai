// Verified against official provider docs in June 2026:
//  - OpenAI context/max-output: developers.openai.com/api/docs/models
//  - DeepSeek context 1M / max output 384K: api-docs.deepseek.com
//  - Google Gemini 1M: ai.google.dev   | Anthropic Claude 4.x: 200K-1M
// Values may lag provider changes — treat as upper bounds for context management.

/** Maximum input context (tokens) per model. 1M-capable models use 1_048_576. */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	// OpenAI
	"gpt-5.5": 1_048_576,
	"gpt-5.4": 1_048_576,
	"gpt-5.4-mini": 409_600,
	"gpt-5.4-nano": 409_600,
	"gpt-4.1": 1_048_576,
	"gpt-4o": 128_000,
	"gpt-4o-mini": 128_000,
	o3: 200_000,
	"o4-mini": 200_000,
	// Anthropic (extended context available; 200K is the standard window)
	"claude-opus-4-7": 1_048_576,
	"claude-opus-4-6": 1_048_576,
	"claude-sonnet-4-6": 1_048_576,
	"claude-haiku-4-5": 200_000,
	// Google Gemini
	"gemini-2.5-pro": 1_048_576,
	"gemini-2.5-flash": 1_048_576,
	"gemini-2.0-flash": 1_048_576, // deprecated 2026-06-01
	// Zhipu / GLM (GLM-5.2 ships a true 1M context)
	"glm-5.2": 1_048_576,
	"glm-5.1": 200_000,
	"glm-5": 200_000,
	"glm-5-turbo": 200_000,
	"glm-4.7": 200_000,
	"glm-4.6": 200_000,
	"glm-5v-turbo": 200_000,
	"glm-4.6v": 128_000,
	// DeepSeek (verified: 1M context)
	"deepseek-v4-pro": 1_048_576,
	"deepseek-v4-flash": 1_048_576,
	"deepseek-chat": 1_048_576,
	"deepseek-reasoner": 1_048_576,
	// Mistral
	"mistral-large-3": 128_000,
	"mistral-medium-3-1": 128_000,
	"mistral-medium-3-5": 128_000,
	"mistral-small-4": 128_000,
	"codestral-25-08": 256_000,
	// xAI / Grok (grok-4.3 = 1M)
	"grok-4.20-0309-reasoning": 1_048_576,
	"grok-4.20-0309-non-reasoning": 1_048_576,
	"grok-4-1-fast-reasoning": 1_048_576,
	"grok-4.3": 1_048_576,
	// Cohere
	"command-a-03-2025": 256_000,
	"command-a-vision-07-2025": 128_000,
	"command-a-reasoning-08-2025": 256_000,
	"command-a-plus-05-2026": 128_000,
};

/**
 * Maximum OUTPUT tokens a model can emit in one turn (includes reasoning tokens
 * for reasoning models). Used to size the output budget and to explain
 * "razonamiento agotado" — reasoning counts against this cap.
 */
export const MODEL_MAX_OUTPUT: Record<string, number> = {
	// OpenAI gpt-5.x: 128K max output (verified)
	"gpt-5.5": 131_072,
	"gpt-5.4": 131_072,
	"gpt-5.4-mini": 131_072,
	"gpt-5.4-nano": 131_072,
	"gpt-4.1": 65_536,
	"gpt-4o": 16_384,
	"gpt-4o-mini": 16_384,
	o3: 100_000,
	"o4-mini": 100_000,
	// DeepSeek: 384K max output (verified)
	"deepseek-v4-pro": 393_216,
	"deepseek-v4-flash": 393_216,
	"deepseek-chat": 393_216,
	"deepseek-reasoner": 393_216,
	// Anthropic: 64K
	"claude-opus-4-7": 65_536,
	"claude-opus-4-6": 65_536,
	"claude-sonnet-4-6": 65_536,
	"claude-haiku-4-5": 65_536,
	// Google Gemini: 65K (Pro/Flash)
	"gemini-2.5-pro": 65_536,
	"gemini-2.5-flash": 65_536,
	"gemini-2.0-flash": 8_192,
	// Zhipu / GLM
	"glm-5.2": 16_384,
	"glm-5.1": 16_384,
	"glm-5": 16_384,
	"glm-5-turbo": 16_384,
	"glm-4.7": 16_384,
	// xAI / Grok
	"grok-4.20-0309-reasoning": 65_536,
	"grok-4.3": 65_536,
};

const DEFAULT_CONTEXT = 128_000;
const DEFAULT_MAX_OUTPUT = 32_768;

function stripProviderPrefix(model: string): string {
	const slashIndex = model.lastIndexOf("/");
	return slashIndex === -1 ? model : model.slice(slashIndex + 1);
}

export function getModelContextWindow(model: string): number {
	const normalized = stripProviderPrefix(model);
	if (MODEL_CONTEXT_WINDOWS[normalized]) return MODEL_CONTEXT_WINDOWS[normalized];
	for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
		if (normalized.startsWith(key.split("-").slice(0, 2).join("-"))) {
			return value;
		}
	}
	return DEFAULT_CONTEXT;
}

export function getModelMaxOutput(model: string): number {
	const normalized = stripProviderPrefix(model);
	if (MODEL_MAX_OUTPUT[normalized]) return MODEL_MAX_OUTPUT[normalized];
	for (const [key, value] of Object.entries(MODEL_MAX_OUTPUT)) {
		if (normalized.startsWith(key.split("-").slice(0, 2).join("-"))) {
			return value;
		}
	}
	return DEFAULT_MAX_OUTPUT;
}

export function formatModelContextWindow(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
	return String(tokens);
}
