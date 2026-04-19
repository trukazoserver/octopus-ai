import type { LLMRequest, ProviderConfig } from "../types.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

const REASONING_MODELS = ["o1", "o3", "o3-mini", "o4-mini"];

function isReasoningModel(model: string): boolean {
	const base = model
		.split("-")
		.slice(0, model.startsWith("o3-mini") ? 2 : 1)
		.join("-");
	return (
		REASONING_MODELS.includes(base) ||
		REASONING_MODELS.some((rm) => model === rm)
	);
}

export class OpenAIProvider extends OpenAICompatibleProvider {
	constructor(config: ProviderConfig) {
		super({
			...config,
			baseUrl: "https://api.openai.com/v1",
			prefix: "openai",
		});
	}

	protected override buildReasoningBody(
		request: LLMRequest,
	): Record<string, unknown> {
		const reasoning = request.reasoning;
		if (!reasoning || reasoning.effort === "none") return {};
		const model = this.mapModel(request.model);
		if (!isReasoningModel(model)) return {};
		return {
			reasoning: {
				effort: reasoning.effort,
				...(reasoning.includeThinking ? { summary: "auto" } : {}),
			},
		};
	}
}
