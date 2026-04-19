import type {
	LLMChunk,
	LLMRequest,
	LLMResponse,
	ProviderConfig,
} from "../types.js";

export abstract class BaseLLMProvider {
	protected config: ProviderConfig;

	constructor(config: ProviderConfig) {
		this.config = config;
	}

	abstract chat(request: LLMRequest): Promise<LLMResponse>;
	abstract chatStream(request: LLMRequest): AsyncIterable<LLMChunk>;
	abstract isAvailable(): Promise<boolean>;
}
