import type {
	LLMChunk,
	LLMRequest,
	LLMResponse,
	ProviderConfig,
} from "../types.js";
import { isLocalBaseUrl } from "./stream-reader.js";

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

	/**
	 * Resolves the effective per-read (chunk-gap) stream timeout for this
	 * provider. Precedence:
	 *   1. explicit per-provider `streamReadTimeoutMs` (set by the router from
	 *      `ai.streamReadTimeoutMs`, or overridden per provider);
	 *   2. `streamReadTimeoutLocalMs` when the base URL is local/self-hosted;
	 *   3. the caller-supplied remote/local defaults (provider-specific history).
	 *
	 * This is Octopus's equivalent of HermesAgent's `HERMES_STREAM_READ_TIMEOUT`
	 * (with the local auto-raise) and opencode's `chunkTimeout`.
	 */
	protected resolveStreamReadTimeoutMs(
		defaultRemoteMs: number,
		defaultLocalMs: number,
	): number {
		const explicit = this.config.streamReadTimeoutMs;
		if (
			typeof explicit === "number" &&
			Number.isFinite(explicit) &&
			explicit > 0
		) {
			return explicit;
		}
		if (isLocalBaseUrl(this.config.baseUrl)) {
			const local = this.config.streamReadTimeoutLocalMs;
			if (typeof local === "number" && Number.isFinite(local) && local > 0) {
				return local;
			}
			return defaultLocalMs;
		}
		return defaultRemoteMs;
	}
}
