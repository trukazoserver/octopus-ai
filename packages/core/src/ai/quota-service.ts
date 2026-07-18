import { randomUUID } from "node:crypto";
import type { LLMRouter } from "./router.js";
import { getProviderRegistry, resolveProviderConfig } from "./router.js";
import type { OctopusConfig } from "../config/index.js";

/**
 * Provider quota for the plans that expose usage limits:
 *  - OpenAI in Codex (ChatGPT account) mode → 5-hour + weekly windows, read from
 *    `x-codex-*` response headers on every /responses call (captured into the
 *    cache below) and re-probed live from a minimal /responses request on each
 *    dashboard poll, so it refreshes automatically like ZhipuAI. Codex exposes
 *    no dedicated usage endpoint, so the probe spends a few tokens per refresh.
 *  - Zhipu / Z.ai in Coding Plan / Coding Global mode → live quota windows from
 *    the /api/monitor/usage/quota/limit monitor endpoint.
 *
 * Secrets are never returned. Every parse is defensive.
 */

export interface QuotaWindow {
	/** Stable id, e.g. "codex-5h", "zhipu-weekly". */
	id: string;
	label: string;
	/** 0..100 when known. */
	usedPercent?: number;
	/** Remaining units (tokens or requests) when known. */
	remaining?: number;
	limit?: number;
	unit?: string;
	/** ISO timestamp when the window resets, when known. */
	resetsAt?: string;
	/** Human label for the reset time, when known. */
	resetLabel?: string;
}

export interface ProviderQuota {
	provider: string;
	providerDisplayName: string;
	mode?: string;
	planType?: string;
	activeLimit?: string;
	configured: boolean;
	/** True when real quota data is available (from cache or a successful probe). */
	available: boolean;
	status: "ok" | "unavailable" | "not-configured";
	windows: QuotaWindow[];
	/** Sanitized, secret-free note (e.g. why it is unavailable). */
	detail?: string;
	/** When this snapshot was taken (ISO). */
	capturedAt?: string;
	probedAt: string;
}

// ---------------------------------------------------------------------------
// In-memory quota cache — populated from real provider response headers.
// ---------------------------------------------------------------------------

export interface CachedQuota {
	provider: string;
	windows: QuotaWindow[];
	planType?: string;
	activeLimit?: string;
	/** epoch ms when captured */
	capturedAt: number;
}

/** Subset of UsageStore used to read/write durable quota snapshots. */
export interface QuotaStore {
	loadQuotaSnapshot(provider: string): Promise<CachedQuota | null>;
	saveQuotaSnapshot?(snapshot: CachedQuota): Promise<void> | void;
}

const quotaCache = new Map<string, CachedQuota>();
/** Slightly under the 10-min UI refresh so stale entries re-probe/re-wait. */
const CACHE_TTL_MS = 9 * 60 * 1000;

export function updateQuotaCache(entry: CachedQuota): void {
	quotaCache.set(entry.provider, entry);
}

/**
 * Clear the in-memory quota cache. Call on provider reconnect / credential
 * change so the dashboard re-probes with the new token instead of serving the
 * previous account's stale quota until the 9-min TTL expires.
 */
export function clearQuotaCache(): void {
	quotaCache.clear();
}

export function getCachedQuota(provider: string): CachedQuota | undefined {
	const entry = quotaCache.get(provider);
	if (!entry) return undefined;
	if (Date.now() - entry.capturedAt > CACHE_TTL_MS) return undefined;
	return entry;
}

/**
 * Extract Codex rate-limit windows + plan metadata from response headers.
 * Centralized so the header-capture path (parseCodexHeaders) and the proactive
 * probe (probeCodex) never drift apart on header names.
 *
 * Known headers: x-codex-primary-used-percent, x-codex-secondary-used-percent,
 * x-codex-primary-reset-at (epoch seconds), x-codex-secondary-reset-at,
 * x-codex-plan-type, x-codex-active-limit.
 */
function codexWindowsFromHeaders(headers: Headers): {
	windows: QuotaWindow[];
	planType?: string;
	activeLimit?: string;
} {
	const windows: QuotaWindow[] = [];
	const primaryUsed = parsePercent(headers.get("x-codex-primary-used-percent"));
	const primaryResets = headers.get("x-codex-primary-reset-at") ?? undefined;
	if (primaryUsed !== undefined || primaryResets) {
		windows.push({
			id: "codex-5h",
			label: "Ventana de 5 horas",
			usedPercent: primaryUsed,
			resetsAt: primaryResets ? toIso(primaryResets) : undefined,
			resetLabel: primaryResets ? formatReset(primaryResets) : undefined,
		});
	}
	const secondaryUsed = parsePercent(
		headers.get("x-codex-secondary-used-percent"),
	);
	const secondaryResets =
		headers.get("x-codex-secondary-reset-at") ?? undefined;
	if (secondaryUsed !== undefined || secondaryResets) {
		windows.push({
			id: "codex-weekly",
			label: "Límite semanal",
			usedPercent: secondaryUsed,
			resetsAt: secondaryResets ? toIso(secondaryResets) : undefined,
			resetLabel: secondaryResets ? formatReset(secondaryResets) : undefined,
		});
	}
	return {
		windows,
		planType: headers.get("x-codex-plan-type") ?? undefined,
		activeLimit: headers.get("x-codex-active-limit") ?? undefined,
	};
}

/**
 * Parse Codex rate-limit headers (present on every successful /responses call)
 * into a cached quota snapshot. Returns null when no quota headers are present.
 */
export function parseCodexHeaders(headers: Headers): CachedQuota | null {
	const { windows, planType, activeLimit } = codexWindowsFromHeaders(headers);
	if (windows.length === 0) return null;
	return {
		provider: "openai",
		windows,
		planType,
		activeLimit,
		capturedAt: Date.now(),
	};
}

/**
 * Handler wired to the router's `setQuotaHeaderHandler`. Parses known quota
 * headers from each provider's responses and stores them in the cache.
 */
export function handleProviderResponseHeaders(
	provider: string,
	headers: Headers,
): void {
	try {
		if (provider === "openai") {
			const parsed = parseCodexHeaders(headers);
			if (parsed) updateQuotaCache(parsed);
		}
		// Zhipu coding plan exposes no quota headers today; nothing to parse.
	} catch {
		/* quota capture must never throw into a provider call */
	}
}

/** Build a ProviderQuota (available) from a cached snapshot. */
function quotaFromCache(
	cached: CachedQuota,
	displayName: string,
	mode?: string,
): ProviderQuota {
	return {
		provider: cached.provider,
		providerDisplayName: displayName,
		mode,
		planType: cached.planType,
		activeLimit: cached.activeLimit,
		configured: true,
		available: true,
		status: "ok",
		windows: cached.windows,
		capturedAt: new Date(cached.capturedAt).toISOString(),
		probedAt: new Date(cached.capturedAt).toISOString(),
	};
}

const PROBE_TIMEOUT_MS = 8000;

export async function resolveProviderQuotas(
	config: OctopusConfig,
	_router?: LLMRouter,
	store?: QuotaStore,
): Promise<ProviderQuota[]> {
	const registry = getProviderRegistry();
	const results: ProviderQuota[] = [];

	const openai = config.ai.providers?.openai;
	if (openai) {
		const resolved = resolveProviderConfig("openai", openai);
		const isCodex = resolved.authMode === "codex" && Boolean(resolved.accessToken);
		if (isCodex) {
			const displayName = registry.openai?.displayName ?? "OpenAI";
			// Mirror ZhipuAI: serve the warm in-memory snapshot (set from x-codex-*
			// headers on each /responses call), and otherwise re-probe the backend on
			// every poll so the dashboard refreshes live — not only after a message.
			// The persisted snapshot is a graceful fallback used only when a probe
			// fails (e.g. network error or account not yet provisioned).
			const cached = getCachedQuota("openai");
			if (cached) {
				results.push(quotaFromCache(cached, displayName, "codex"));
			} else {
				const probed = await probeCodex(resolved.accessToken ?? "", displayName);
				if (probed.available) {
					// probeCodex refreshed the cache; persist so it survives restarts.
					const fresh = getCachedQuota("openai");
					if (fresh) void store?.saveQuotaSnapshot?.(fresh);
					results.push(probed);
				} else {
					const persisted =
						(await store?.loadQuotaSnapshot("openai").catch(() => null)) ??
						undefined;
					if (persisted) {
						results.push(quotaFromCache(persisted, displayName, "codex"));
					} else {
						probed.detail = `${probed.detail ? `${probed.detail} · ` : ""}La cuota aparece tras el primer mensaje con este modelo (cabeceras x-codex-* en /responses).`;
						results.push(probed);
					}
				}
			}
		}
	}

	const zhipu = config.ai.providers?.zhipu;
	if (zhipu) {
		const resolved = resolveProviderConfig("zhipu", zhipu);
		const mode = (resolved.mode ?? zhipu.mode ?? "") as string;
		const isCoding = mode.startsWith("coding");
		const key = resolved.codingApiKey || resolved.apiKey;
		if (isCoding && key) {
			const displayName = registry.zhipu?.displayName ?? "Z.ai / ZhipuAI";
			// The monitor endpoint returns real quota directly (no chat needed).
			const cached = getCachedQuota("zhipu") ?? (await store?.loadQuotaSnapshot("zhipu").catch(() => null)) ?? undefined;
			results.push(cached ? quotaFromCache(cached, displayName, mode) : await probeZhipu(key, mode, displayName));
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// Codex (ChatGPT account) — 5h primary + weekly secondary windows.
// The Codex backend exposes no usage endpoint: rate-limit data only appears in
// the x-codex-* headers of a real /responses call. To refresh the dashboard
// automatically (like ZhipuAI), probeCodex issues a minimal /responses request
// and reads those headers, cancelling the stream immediately to keep the token
// cost negligible. This spends a few tokens per refresh.
// ---------------------------------------------------------------------------

async function probeCodex(
	accessToken: string,
	displayName: string,
): Promise<ProviderQuota> {
	const token = accessToken.replace(/^Bearer\s+/i, "");
	const base = (
		process.env.CODEX_BASE_URL || "https://chatgpt.com/backend-api/codex"
	).replace(/\/$/, "");
	const model = process.env.CODEX_PROBE_MODEL || "gpt-5.5";
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		"content-type": "application/json",
		accept: "text/event-stream",
		originator: "codex_cli_rs",
		"session-id": randomUUID(),
	};
	const accountId = process.env.CODEX_ACCOUNT_ID;
	if (accountId) headers.chatgpt_account_id = accountId;

	// Minimal Responses API call: a trivial user turn, no tools, store:false,
	// stream:true (the backend rejects stream:false). Body mirrors
	// CodexProvider.buildBody so the request is accepted; we only need the
	// rate-limit headers from the initial HTTP response.
	const body = JSON.stringify({
		model,
		input: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "ok" }],
			},
		],
		tools: [],
		store: false,
		stream: true,
	});

	const probedAt = new Date().toISOString();
	try {
		const resp = await fetchWithTimeout(
			`${base}/responses`,
			{ method: "POST", headers, body },
			PROBE_TIMEOUT_MS,
		);
		const parsed = codexWindowsFromHeaders(resp.headers);
		// Headers received — cancel the stream so the backend stops generating
		// and we don't pay for the (unread) completion tokens.
		try {
			await resp.body?.cancel();
		} catch {
			/* cancellation is best-effort */
		}
		if (parsed.windows.length > 0) {
			const snapshot: CachedQuota = {
				provider: "openai",
				windows: parsed.windows,
				planType: parsed.planType,
				activeLimit: parsed.activeLimit,
				capturedAt: Date.now(),
			};
			updateQuotaCache(snapshot);
			return {
				provider: "openai",
				providerDisplayName: displayName,
				mode: "codex",
				planType: parsed.planType,
				activeLimit: parsed.activeLimit,
				configured: true,
				available: true,
				status: "ok",
				windows: parsed.windows,
				capturedAt: new Date(snapshot.capturedAt).toISOString(),
				probedAt,
			};
		}
		return unavailable(
			"openai",
			displayName,
			"codex",
			probedAt,
			`/responses sin cabeceras de cuota (HTTP ${resp.status})`,
		);
	} catch (err) {
		return unavailable(
			"openai",
			displayName,
			"codex",
			probedAt,
			err instanceof Error ? err.message : String(err),
		);
	}
}

// ---------------------------------------------------------------------------
// Zhipu / Z.ai Coding Plan — token/time limit windows.
// ---------------------------------------------------------------------------

async function probeZhipu(
	apiKey: string,
	mode: string,
	displayName: string,
): Promise<ProviderQuota> {
	// Endpoint depends on platform: api.z.ai for the global coding plan,
	// open.bigmodel.cn for the CN coding plan. (Same shape as OpenCode's
	// opencode-glm-quota / opencode-mystatus plugins.)
	const defaultBase =
		mode === "coding-plan"
			? "https://open.bigmodel.cn"
			: "https://api.z.ai";
	const url =
		process.env.ZHIPU_QUOTA_URL ||
		`${defaultBase}/api/monitor/usage/quota/limit`;
	// Auth is the raw key with NO "Bearer" prefix (matches Z.ai monitor API).
	const headers: Record<string, string> = {
		Authorization: apiKey,
		Accept: "application/json",
		"Accept-Language": "en-US,en",
	};
	const probedAt = new Date().toISOString();
	try {
		const resp = await fetchWithTimeout(url, { method: "GET", headers }, PROBE_TIMEOUT_MS);
		if (!resp.ok) {
			return unavailable("zhipu", displayName, mode, probedAt, `HTTP ${resp.status}`);
		}
		const body = (await resp.json()) as Record<string, unknown>;
		const parsed = mapZhipuLimits(body);
		if (parsed.windows.length === 0) {
			return unavailable("zhipu", displayName, mode, probedAt, "no limit windows parsed");
		}
		return {
			provider: "zhipu",
			providerDisplayName: displayName,
			mode,
			planType: parsed.level,
			configured: true,
			available: true,
			status: "ok",
			windows: parsed.windows,
			probedAt,
		};
	} catch (err) {
		return unavailable(
			"zhipu",
			displayName,
			mode,
			probedAt,
			err instanceof Error ? err.message : String(err),
		);
	}
}

/**
 * Parse the Z.ai / Zhipu monitor response:
 * `{ data: { level, limits: [ {type, unit, percentage, remaining, usage,
 * currentValue, nextResetTime, usageDetails}, ... ] } }`
 *
 * TOKENS_LIMIT unit 3 = 5h token window, unit 6 = weekly;
 * TIME_LIMIT unit 5 = MCP monthly. `percentage` is the used %, `nextResetTime`
 * is epoch milliseconds.
 */
function mapZhipuLimits(body: Record<string, unknown>): {
	windows: QuotaWindow[];
	level?: string;
} {
	const data = (body.data ?? body) as Record<string, unknown> | undefined;
	const level =
		data && typeof data === "object" && typeof data.level === "string"
			? data.level
			: undefined;
	const bodyLimits = (body as Record<string, unknown>).limits;
	const dataLimits =
		data && typeof data === "object"
			? (data as Record<string, unknown>).limits
			: undefined;
	const limitsRaw: unknown[] = Array.isArray(bodyLimits)
		? bodyLimits
		: Array.isArray(dataLimits)
			? dataLimits
			: [];
	const windows: QuotaWindow[] = [];
	for (const entry of limitsRaw) {
		const e = entry as Record<string, unknown>;
		const type = String(e.type ?? "");
		const unit = e.unit === undefined ? undefined : Number(e.unit);
		const label = zhipuWindowLabel(type, unit);
		if (!label) continue;
		const usedPercent = parsePercent(String(e.percentage ?? ""));
		const remaining = toNumber(e.remaining);
		const usedCount = toNumber(e.usage ?? e.currentValue);
		const resetsAt = toIsoFromMsOrIso(e.nextResetTime ?? e.reset_at);
		windows.push({
			id: `zhipu-${label.id}`,
			label: label.label,
			usedPercent: usedPercent,
			remaining,
			limit: usedCount !== undefined && remaining !== undefined
				? usedCount + remaining
				: undefined,
			unit: type === "TOKENS_LIMIT" ? "tokens" : type === "TIME_LIMIT" ? "llamadas" : undefined,
			resetsAt,
			resetLabel: resetsAt ? formatReset(resetsAt) : undefined,
		});
	}
	return { windows, level };
}

function zhipuWindowLabel(
	type: string,
	unit: number | undefined,
): { id: string; label: string } | null {
	if (type === "TOKENS_LIMIT") {
		if (unit === 3) return { id: "5h", label: "Ventana de 5 horas" };
		if (unit === 6) return { id: "weekly", label: "Límite semanal" };
	}
	if (type === "TIME_LIMIT") {
		if (unit === 5) return { id: "monthly", label: "Límite mensual (MCP)" };
	}
	return null;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function unavailable(
	provider: string,
	displayName: string,
	mode: string | undefined,
	probedAt: string,
	reason: string,
): ProviderQuota {
	return {
		provider,
		providerDisplayName: displayName,
		mode,
		configured: true,
		available: false,
		status: "unavailable",
		windows: [],
		detail: sanitize(reason),
		probedAt,
	};
}

function sanitize(s: string): string {
	// Strip anything that looks like a token/key/cookie just in case.
	return s
		.replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1***")
		.replace(/(sk-[A-Za-z0-9-]+)/g, "sk-***")
		.slice(0, 300);
}

function parsePercent(v: string | null): number | undefined {
	if (v == null) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : undefined;
}

function toNumber(v: unknown): number | undefined {
	if (v == null) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

function toIso(v: string): string {
	// Accept epoch seconds, epoch ms, or ISO string.
	const n = Number(v);
	if (Number.isFinite(n) && n > 0) {
		return n > 1e12 ? new Date(n).toISOString() : new Date(n * 1000).toISOString();
	}
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? v : d.toISOString();
}

function toIsoFromMsOrIso(v: unknown): string | undefined {
	if (v == null) return undefined;
	if (typeof v === "number" || /^\d+$/.test(String(v))) {
		return toIso(String(v));
	}
	const d = new Date(String(v));
	return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

function formatReset(isoOrEpoch: string): string {
	const d = new Date(toIso(isoOrEpoch));
	if (Number.isNaN(d.getTime())) return isoOrEpoch;
	return d.toLocaleString("es-ES", {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}
