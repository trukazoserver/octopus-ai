import type {
	LLMChunk,
	LLMRequest,
	LLMResponse,
	ProviderConfig,
} from "../types.js";

export abstract class BaseLLMProvider {
	protected config: ProviderConfig;
	/**
	 * Optional hook invoked with the raw response headers after a successful
	 * provider call. Used to capture rate-limit / quota headers (e.g. Codex
	 * `x-codex-*`) for the quota dashboard without making extra API calls.
	 */
	onResponseHeaders?: (headers: Headers) => void;

	constructor(config: ProviderConfig) {
		this.config = config;
	}

	abstract chat(request: LLMRequest): Promise<LLMResponse>;
	abstract chatStream(request: LLMRequest): AsyncIterable<LLMChunk>;
	abstract isAvailable(): Promise<boolean>;
}
