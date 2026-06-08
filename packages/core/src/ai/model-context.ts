export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	"gemini-2.5-pro": 1_048_576,
	"gemini-2.5-flash": 1_048_576,
	"gemini-2.0-flash": 1_048_576,
	"gpt-4.1": 1_048_576,
	"gpt-4o": 128_000,
	"gpt-4o-mini": 128_000,
	o3: 200_000,
	"o4-mini": 200_000,
	"claude-opus-4-7": 1_048_576,
	"claude-opus-4-6": 1_048_576,
	"claude-sonnet-4-6": 1_048_576,
	"claude-haiku-4-5": 200_000,
	"glm-5.1": 200_000,
	"glm-5": 200_000,
	"glm-5-turbo": 200_000,
	"glm-4.7": 200_000,
	"glm-4.6": 200_000,
	"glm-5v-turbo": 200_000,
	"glm-4.6v": 128_000,
	"deepseek-v4-pro": 128_000,
	"deepseek-v4-flash": 128_000,
	"deepseek-chat": 128_000,
	"deepseek-reasoner": 128_000,
	"mistral-large-3": 128_000,
	"mistral-medium-3-1": 128_000,
	"mistral-medium-3-5": 128_000,
	"mistral-small-4": 128_000,
	"codestral-25-08": 256_000,
	"grok-4.20-0309-reasoning": 1_048_576,
	"grok-4.20-0309-non-reasoning": 1_048_576,
	"grok-4-1-fast-reasoning": 1_048_576,
	"grok-4.3": 1_048_576,
	"command-a-03-2025": 256_000,
	"command-a-vision-07-2025": 128_000,
	"command-a-reasoning-08-2025": 256_000,
	"command-a-plus-05-2026": 128_000,
};

export function getModelContextWindow(model: string): number {
	const slashIndex = model.lastIndexOf("/");
	const normalized = slashIndex === -1 ? model : model.slice(slashIndex + 1);
	if (MODEL_CONTEXT_WINDOWS[normalized])
		return MODEL_CONTEXT_WINDOWS[normalized];
	for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
		if (normalized.startsWith(key.split("-").slice(0, 2).join("-"))) {
			return value;
		}
	}
	return 128_000;
}

export function formatModelContextWindow(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
	return String(tokens);
}
