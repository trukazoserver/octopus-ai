/**
 * ToolHealthManager — cached health/quota status for external web tools.
 *
 * Problem it solves: web search and web reader are MCP servers backed by a
 * single API key (Z.ai/Zhipu). When that quota runs out, BOTH fail and the
 * agent only discovers it by calling the tool and watching it error — burning
 * many turns (observed: ~1h loop). This manager probes each tool up front
 * (startup + daily cron), caches the result with a TTL, and exposes it so the
 * executor can short-circuit a call to an out-of-quota tool and the system
 * prompt can steer the model to a fallback (browser_search / pdf_read).
 *
 * Health is keyed by MCP *server* (e.g. "zai-web-search"), and resolved from
 * any published tool name via `findServerForTool`, so it works regardless of
 * how the tool name was namespaced at registration.
 */
import type { DatabaseAdapter } from "../storage/database.js";
import { SecretRedactor } from "../security/secret-redactor.js";

export type ToolHealthStatus = "ok" | "no_quota" | "error" | "unknown";

export interface ToolHealthRecord {
	server: string;
	status: ToolHealthStatus;
	detail?: string;
	checkedAt?: string;
	cacheUntil?: string;
	consecutiveFailures: number;
}

export interface ToolHealthConfig {
	enabled: boolean;
	cacheTtlMinutes: number;
	breaker: { consecutiveFailures: number; windowMinutes: number };
}

export interface ToolCircuitState {
	open: boolean;
	failures: number;
	threshold: number;
	lastError: string;
}

/**
 * Minimal structural interface for the MCP manager. Using this instead of
 * importing MCPManager directly avoids a tools/ -> plugins/ import cycle.
 */
export interface ToolHealthMcpCaller {
	callTool(
		serverName: string,
		toolName: string,
		params: Record<string, unknown>,
	): Promise<unknown>;
	findServerForTool(toolName: string): string | undefined;
	getServer?(name: string): { status?: string } | undefined;
}

interface ProbeSpec {
	/** MCP-side tool name to invoke for the canary call. */
	tool: string;
	/** Best-effort params; the classifier does not depend on these. */
	probe: Record<string, unknown>;
	/** Fallback hint shown to the model when this server is unavailable. */
	alternative: string;
}

/** Server -> how to probe it + which fallback to recommend. */
const PROBE_SPECS: Record<string, ProbeSpec> = {
	"zai-web-search": {
		tool: "webSearchPrime",
		probe: { search_query: "octopus health check", count: 1 },
		alternative: "browser_search (búsqueda por navegador)",
	},
	"zai-web-reader": {
		tool: "webReader",
		probe: { url: "https://example.com" },
		alternative: "pdf_read (para PDFs) o browser_navigate",
	},
};

/**
 * Errors that indicate the API key/quota is the problem. Covers the real Z.ai
 * quota-exhaustion message ("Weekly/Monthly Limit Exhausted", "MCP error -429",
 * code 1310) plus the usual auth/billing patterns.
 */
const QUOTA_ERROR_RE =
	/quota|billing|payment|insufficient|balance|credit|exceed|exhaust|limit.{0,15}(exhaust|reach|exceed|finish)|rate.?limit|\b429\b|401|403|unauthorized|forbidden|invalid.?api.?key|sin.?saldo|no.?enough|limite.{0,15}(agotad|exced)|cuota/i;
/** Errors that look transient (network/timeout) → unknown, not "no quota". */
const TRANSIENT_ERROR_RE =
	/timeout|timed out|econnreset|enotfound|econnrefused|eai_again|socket hang up|network|fetch failed|aborted|503|502|504/i;

interface BreakerState {
	consecutiveFailures: number;
	firstFailureAt: number;
	lastError: string;
}

interface ToolHealthRow {
	server: string;
	status: string;
	detail: string | null;
	checked_at: string | null;
	cache_until: string | null;
	consecutive_failures: number;
}

export class ToolHealthManager {
	private cache = new Map<string, ToolHealthRecord>();
	private breakers = new Map<string, BreakerState>();
	private loaded = false;
	private redactor = new SecretRedactor();

	constructor(
		private db: DatabaseAdapter,
		private mcp: ToolHealthMcpCaller,
		private config: ToolHealthConfig,
	) {}

	/** Probe every managed server and persist the result. */
	async runProbe(): Promise<void> {
		for (const server of Object.keys(PROBE_SPECS)) {
			try {
				await this.probeServer(server);
			} catch (err) {
				// One server's failure must not abort the whole probe run.
				console.error(`[ToolHealth] probe failed for ${server}:`, err);
			}
		}
	}

	private async probeServer(server: string): Promise<void> {
		const spec = PROBE_SPECS[server];
		if (!spec) return;
		// Skip servers that are absent or not connected (e.g. no Z.ai key
		// configured) so we neither burn a failing call nor write spurious rows.
		const managed = this.mcp.getServer?.(server);
		if (!managed || managed.status !== "connected") return;
		let status: ToolHealthStatus = "unknown";
		let detail = "";

		try {
			const result = await this.mcp.callTool(server, spec.tool, spec.probe);
			// A successful return (even empty) means auth + quota are fine.
			status = "ok";
			detail = this.describeResult(result);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (QUOTA_ERROR_RE.test(msg)) {
				status = "no_quota";
			} else if (TRANSIENT_ERROR_RE.test(msg)) {
				status = "unknown";
			} else {
				// Validation / param / other non-auth 4xx: the call reached a
				// working, authenticated endpoint, so quota is effectively fine.
				status = "ok";
			}
			detail = this.redactor.redactText(msg).slice(0, 300);
		}

		await this.persist(server, status, detail);
	}

	private describeResult(result: unknown): string {
		if (result && typeof result === "object" && "content" in result) {
			const content = (result as { content?: Array<{ text?: string }> })
				.content;
			const text = content?.map((c) => c.text || "").join(" ").trim() || "";
			return text ? `ok: ${text.slice(0, 80)}` : "ok";
		}
		return "ok";
	}

	private async persist(
		server: string,
		status: ToolHealthStatus,
		detail: string,
	): Promise<void> {
		const now = Date.now();
		const checkedAt = new Date(now).toISOString();
		const cacheUntil = new Date(
			now + this.config.cacheTtlMinutes * 60_000,
		).toISOString();
		const previous = this.cache.get(server);
		// Failures from a prior probe do not carry over a fresh "ok".
		const consecutiveFailures =
			status === "ok" ? 0 : previous?.consecutiveFailures ?? 0;

		await this.db.run(
			`INSERT INTO tool_health (server, status, detail, checked_at, cache_until, consecutive_failures)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(server) DO UPDATE SET
			   status = excluded.status,
			   detail = excluded.detail,
			   checked_at = excluded.checked_at,
			   cache_until = excluded.cache_until,
			   consecutive_failures = excluded.consecutive_failures`,
			[server, status, detail, checkedAt, cacheUntil, consecutiveFailures],
		);
		this.cache.set(server, {
			server,
			status,
			detail,
			checkedAt,
			cacheUntil,
			consecutiveFailures,
		});
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const rows = await this.db.all<ToolHealthRow>(
				"SELECT * FROM tool_health",
			);
			for (const row of rows) this.cache.set(row.server, rowFromDb(row));
		} catch (err) {
			console.error("[ToolHealth] failed to load cache:", err);
		}
	}

	/**
	 * Cached health for the server backing `toolName`, or null when fresh data
	 * is unavailable / the tool is not a managed web tool / health is disabled.
	 */
	async getStatus(toolName: string): Promise<ToolHealthRecord | null> {
		if (!this.config.enabled) return null;
		await this.ensureLoaded();
		const server = this.mcp.findServerForTool(toolName);
		if (!server) return null;
		const rec = this.cache.get(server);
		if (!rec || isExpired(rec)) return null;
		return rec;
	}

	/** Alternative tool to recommend when this server is unavailable. */
	alternativeFor(toolName: string): string | undefined {
		const server = this.mcp.findServerForTool(toolName);
		return server ? PROBE_SPECS[server]?.alternative : undefined;
	}

	/** Record a tool execution outcome; drives the per-tool circuit breaker. */
	recordOutcome(
		toolName: string,
		success: boolean,
		errorMsg?: string,
	): void {
		if (!this.config.enabled) return;
		const server = this.mcp.findServerForTool(toolName);
		if (!server || !PROBE_SPECS[server]) return; // only track web tools
		if (success) {
			this.breakers.delete(toolName);
			return;
		}
		const now = Date.now();
		const windowMs = this.config.breaker.windowMinutes * 60_000;
		const prev = this.breakers.get(toolName);
		const withinWindow = prev && now - prev.firstFailureAt <= windowMs;
		this.breakers.set(toolName, {
			consecutiveFailures: withinWindow
				? prev.consecutiveFailures + 1
				: 1,
			firstFailureAt: withinWindow ? prev.firstFailureAt : now,
			lastError: (errorMsg || "").slice(0, 200),
		});
	}

	/** Whether the circuit breaker is open for `toolName` (null if untracked). */
	isCircuitOpen(toolName: string): ToolCircuitState | null {
		if (!this.config.enabled) return null;
		const state = this.breakers.get(toolName);
		if (!state) return null;
		const threshold = this.config.breaker.consecutiveFailures;
		const windowMs = this.config.breaker.windowMinutes * 60_000;
		const withinWindow = Date.now() - state.firstFailureAt <= windowMs;
		return {
			open: withinWindow && state.consecutiveFailures >= threshold,
			failures: state.consecutiveFailures,
			threshold,
			lastError: state.lastError,
		};
	}

	/** Short, model-facing summary of any tool that is currently unavailable. */
	async getHealthSummary(): Promise<string> {
		if (!this.config.enabled) return "";
		await this.ensureLoaded();
		const lines: string[] = [];

		for (const [server, spec] of Object.entries(PROBE_SPECS)) {
			const rec = this.cache.get(server);
			if (!rec || rec.status === "ok") continue; // only surface problems
			const time = rec.checkedAt
				? new Date(rec.checkedAt).toLocaleTimeString()
				: "";
			lines.push(
				`- ${server} (${labelFor(rec.status)}${time ? `, verificado ${time}` : ""}): usa ${spec.alternative}.`,
			);
		}

		for (const [toolName, state] of this.breakers) {
			const threshold = this.config.breaker.consecutiveFailures;
			if (state.consecutiveFailures >= threshold) {
				lines.push(
					`- ${toolName}: fallando repetidamente (${state.consecutiveFailures}x consecutivas) → evítala y usa una alternativa.`,
				);
			}
		}

		if (lines.length === 0) return "";
		return [
			"# Estado de herramientas web",
			"Atención: las siguientes herramientas NO están disponibles ahora mismo. No pierdas tiempo intentándolas; ve directo a la alternativa indicada.",
			...lines,
		].join("\n");
	}
}

function isExpired(rec: ToolHealthRecord): boolean {
	if (!rec.cacheUntil) return true;
	return Date.now() >= new Date(rec.cacheUntil).getTime();
}

function rowFromDb(row: ToolHealthRow): ToolHealthRecord {
	return {
		server: row.server,
		status: row.status as ToolHealthStatus,
		detail: row.detail ?? undefined,
		checkedAt: row.checked_at ?? undefined,
		cacheUntil: row.cache_until ?? undefined,
		consecutiveFailures: row.consecutive_failures ?? 0,
	};
}

function labelFor(status: ToolHealthStatus): string {
	switch (status) {
		case "no_quota":
			return "SIN SALDO / sin quota";
		case "error":
			return "con errores";
		case "unknown":
			return "estado desconocido";
		default:
			return "ok";
	}
}
