import { createLogger } from "../utils/logger.js";
import type { Context7Config } from "./types.js";

const logger = createLogger("context7-http");

export interface Context7Library {
	/** Context7 library ID, ej. "/vercel/next.js". */
	id: string;
	name?: string;
	description?: string;
}

/**
 * Cliente HTTP ligero a la API pública de Context7.
 *
 * Se usa como **fallback** cuando las tools MCP `context7_*` no están
 * registradas en el runtime. Endpoints (https://context7.com/docs/api-guide):
 *   GET {base}/api/v2/libs/search?query=<q>
 *   GET {base}/api/v2/context?libraryId=<id>&topic=<t>&tokens=<n>
 *
 * La API key (Bearer) es opcional; sin ella aplica el límite de tasa público.
 */
export class Context7HttpClient {
	constructor(private config: Context7Config) {}

	/** Busca la librería más relevante para la query; devuelve su Context7 ID o null. */
	async searchLibrary(query: string): Promise<Context7Library | null> {
		if (!this.config.enabled) return null;
		try {
			const url = `${this.config.httpEndpoint}/api/v2/libs/search?query=${encodeURIComponent(query)}`;
			const res = await this.fetchWithTimeout(url);
			if (!res.ok) {
				logger.warn(`Context7 search HTTP ${res.status}`);
				return null;
			}
			const data = (await res.json()) as { libraries?: Context7Library[] };
			return data.libraries?.[0] ?? null;
		} catch (err) {
			logger.warn(`Context7 search failed: ${String(err)}`);
			return null;
		}
	}

	/** Obtiene el contexto/documentación actualizado para una librería. */
	async fetchContext(
		libraryId: string,
		topic?: string,
		tokens = 4000,
	): Promise<string | null> {
		if (!this.config.enabled) return null;
		try {
			const params = new URLSearchParams({
				libraryId,
				tokens: String(tokens),
			});
			if (topic) params.set("topic", topic);
			const url = `${this.config.httpEndpoint}/api/v2/context?${params.toString()}`;
			const res = await this.fetchWithTimeout(url);
			if (!res.ok) {
				logger.warn(`Context7 fetch HTTP ${res.status}`);
				return null;
			}
			const data = (await res.json()) as {
				context?: string;
				content?: string;
			};
			return data.context ?? data.content ?? null;
		} catch (err) {
			logger.warn(`Context7 fetch failed: ${String(err)}`);
			return null;
		}
	}

	private async fetchWithTimeout(url: string): Promise<Response> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
		try {
			return await fetch(url, {
				signal: controller.signal,
				headers: this.config.apiKey
					? { Authorization: `Bearer ${this.config.apiKey}` }
					: {},
			});
		} finally {
			clearTimeout(timer);
		}
	}
}
