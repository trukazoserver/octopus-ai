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
	 * Validate that the configured credential actually works against the
	 * provider. Default: presence-only (delegates to isAvailable). Cloud
	 * providers override with a lightweight authenticated GET (list models).
	 * Used by `POST /api/providers/:provider/test` at connect time.
	 */
	async verifyKey(): Promise<{ ok: boolean; error?: string }> {
		const ok = await this.isAvailable();
		return { ok, error: ok ? undefined : "Sin credenciales configuradas" };
	}

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

/**
 * Shared helper for `verifyKey()` overrides: one lightweight authenticated GET
 * (list-models endpoint). Normalizes the outcome into `{ok, error?}`:
 * 200 → ok; 401/403 → "Credenciales inválidas"; other status → `Error N`;
 * network/timeout failure → the error message.
 */
export async function verifyModelsGet(
	url: string,
	headers: Record<string, string>,
	timeoutMs = 8000,
): Promise<{ ok: boolean; error?: string }> {
	try {
		const res = await fetch(url, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (res.ok) return { ok: true };
		if (res.status === 401 || res.status === 403) {
			return { ok: false, error: "Credenciales inválidas" };
		}
		const body = await res.text().catch(() => "");
		// Some providers (e.g. Gemini AI Studio) return 400 — not 401 — for an
		// invalid key, with "API key" / "invalid" in the body. Treat those as
		// credential errors too so the UI message is consistent.
		if (
			res.status >= 400 &&
			res.status < 500 &&
			/api[ _-]?key|invalid|unauthor|forbidden/i.test(body)
		) {
			return { ok: false, error: "Credenciales inválidas" };
		}
		return {
			ok: false,
			error: `Error ${res.status}: ${body.slice(0, 160)}`.trim(),
		};
	} catch (e) {
		return {
			ok: false,
			error: e instanceof Error ? e.message : "Error de red",
		};
	}
}
