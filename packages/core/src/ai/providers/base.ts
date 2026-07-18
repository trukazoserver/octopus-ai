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
	 * Live model list from the provider's list-models endpoint. Returns
	 * `{ok, models}`: `ok` means the endpoint responded successfully (provider is
	 * available/credentialed), `models` is the parsed id list (may be empty if the
	 * response shape was unparseable). Used by /api/models to show real, current
	 * models for configured providers only; callers fall back to the registry's
	 * static defaultModels when `ok` is true but `models` is empty.
	 */
	async listModels(): Promise<{ ok: boolean; models: string[] }> {
		return { ok: false, models: [] };
	}

	/**
	 * Whether this provider has a credential CONFIGURED (presence only, no
	 * network). Used as a cheap pre-filter so /api/models doesn't fire a doomed
	 * request at every unconfigured provider. The live listModels() GET remains
	 * the real "verified" check; this just skips the obviously-unconfigured ones.
	 */
	hasCredentials(): boolean {
		if (this.config.accessToken) return true;
		if (this.config.authMode === "vertex") {
			return Boolean(
				this.config.credentialsJson ||
					this.config.credentialsFile ||
					process.env.GOOGLE_APPLICATION_CREDENTIALS ||
					process.env.GOOGLE_VERTEX_ACCESS_TOKEN,
			);
		}
		return Boolean(this.config.apiKey);
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

/**
 * TTL for the live model-list cache. Opening the model selector must not hammer
 * every provider on each call; one authenticated GET per provider per window.
 */
const MODELS_LIST_TTL_MS = 10 * 60 * 1000;
const modelsListCache = new Map<
	string,
	{ models: string[]; fetchedAt: number }
>();

/**
 * Extract model ids from a provider's list-models JSON, handling the common
 * response shapes: `{data:[{id}]}` (OpenAI-compat, Anthropic, Zhipu),
 * `{models:[{name|id|slug}]}` (Google, Cohere, Ollama, Codex) and a bare
 * top-level array. Google names like `models/gemini-...` are normalized.
 */
export function parseModelIds(data: unknown): string[] {
	let arr: unknown[] = [];
	if (Array.isArray(data)) arr = data;
	else if (data && typeof data === "object") {
		const obj = data as Record<string, unknown>;
		if (Array.isArray(obj.data)) arr = obj.data;
		else if (Array.isArray(obj.models)) arr = obj.models;
	}
	const ids = arr
		.map((item) => {
			if (typeof item === "string") return item;
			if (item && typeof item === "object") {
				const m = item as Record<string, unknown>;
				return (m.id ?? m.name ?? m.slug) as unknown;
			}
			return undefined;
		})
		.filter((v): v is string => typeof v === "string" && v.length > 0);
	return [...new Set(ids.map((id) => id.replace(/^models\//, "")))];
}

/**
 * Shared helper for `listModels()`: one cached authenticated GET to the
 * provider's list-models endpoint, returning the parsed model ids. Mirrors
 * verifyModelsGet's status handling but keeps the body. `ok` means the endpoint
 * responded successfully (so the provider is available); `models` may still be
 * empty if the response shape was unparseable — callers fall back to static
 * defaults in that case.
 */
export async function fetchModelsList(
	url: string,
	headers: Record<string, string>,
	timeoutMs = 8000,
): Promise<{ ok: boolean; models: string[] }> {
	const cached = modelsListCache.get(url);
	if (cached && Date.now() - cached.fetchedAt < MODELS_LIST_TTL_MS) {
		return { ok: true, models: cached.models };
	}
	try {
		const res = await fetch(url, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return { ok: false, models: [] };
		const data = (await res.json()) as unknown;
		const models = parseModelIds(data);
		modelsListCache.set(url, { models, fetchedAt: Date.now() });
		return { ok: true, models };
	} catch {
		return { ok: false, models: [] };
	}
}

/** Clear the live model-list cache (for tests / forced refresh). */
export function clearModelsListCache(): void {
	modelsListCache.clear();
}
