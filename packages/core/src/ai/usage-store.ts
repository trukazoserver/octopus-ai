import type { DatabaseAdapter } from "../storage/database.js";
import type { CachedQuota } from "./quota-service.js";

/**
 * Durable LLM usage ledger. The router writes one event per finalized token/cost
 * accounting; everything here survives restarts and feeds the Settings "Uso y
 * Consumo" section and the dashboard totals.
 */

export interface UsageEvent {
	provider: string;
	model?: string;
	agentId?: string;
	conversationId?: string;
	requestId?: string;
	promptTokens: number;
	completionTokens: number;
	reasoningTokens?: number;
	totalTokens: number;
	estimatedCost: number;
}
export interface UsageSink {
	record(event: UsageEvent): void;
}

export interface ProviderUsageSlice {
	tokens: number;
	promptTokens: number;
	completionTokens: number;
	reasoningTokens: number;
	cost: number;
	requests: number;
}

export interface UsageAggregate {
	totalTokens: number;
	promptTokens: number;
	completionTokens: number;
	reasoningTokens: number;
	totalCost: number;
	requests: number;
	byProvider: Record<string, ProviderUsageSlice>;
}

export interface UsageQueryFilters {
	from?: string;
	to?: string;
	agentId?: string;
	provider?: string;
}

const EMPTY_AGGREGATE: UsageAggregate = {
	totalTokens: 0,
	promptTokens: 0,
	completionTokens: 0,
	reasoningTokens: 0,
	totalCost: 0,
	requests: 0,
	byProvider: {},
};

export class UsageStore implements UsageSink {
	private seenRequestIds = new Set<string>();
	private seenOrder: string[] = [];
	private readonly seenCap = 2000;

	constructor(private db: DatabaseAdapter) {}

	/**
	 * Record a usage event. Fire-and-forget (never blocks the LLM hot path).
	 * Dedupes by requestId when present so multi-chunk streaming usage is counted
	 * at most once per originating execution.
	 */
	record(event: UsageEvent): void {
		if (event.requestId) {
			if (this.seenRequestIds.has(event.requestId)) return;
			this.seenRequestIds.add(event.requestId);
			this.seenOrder.push(event.requestId);
			if (this.seenOrder.length > this.seenCap) {
				const evicted = this.seenOrder.shift();
				if (evicted) this.seenRequestIds.delete(evicted);
			}
		}
		void this.db
			.run(
				`INSERT INTO ai_usage_events
					(provider, model, agent_id, conversation_id, request_id,
					 prompt_tokens, completion_tokens, reasoning_tokens, total_tokens, estimated_cost)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					event.provider,
					event.model ?? null,
					event.agentId ?? null,
					event.conversationId ?? null,
					event.requestId ?? null,
					event.promptTokens ?? 0,
					event.completionTokens ?? 0,
					event.reasoningTokens ?? 0,
					event.totalTokens ?? 0,
					event.estimatedCost ?? 0,
				],
			)
			.catch((err) => {
				// Persistence must never break an active generation.
				console.error("[usage-store] failed to persist event:", err);
			});
	}

	async aggregate(filters: UsageQueryFilters = {}): Promise<UsageAggregate> {
		const providers = await this.byProvider(filters);
		const aggregate: UsageAggregate = { ...EMPTY_AGGREGATE, byProvider: {} };
		for (const row of providers) {
			aggregate.totalTokens += Number(row.tokens) || 0;
			aggregate.promptTokens += Number(row.promptTokens) || 0;
			aggregate.completionTokens += Number(row.completionTokens) || 0;
			aggregate.reasoningTokens += Number(row.reasoningTokens) || 0;
			aggregate.totalCost += Number(row.cost) || 0;
			aggregate.requests += Number(row.requests) || 0;
			aggregate.byProvider[row.provider] = {
				tokens: Number(row.tokens) || 0,
				promptTokens: Number(row.promptTokens) || 0,
				completionTokens: Number(row.completionTokens) || 0,
				reasoningTokens: Number(row.reasoningTokens) || 0,
				cost: Number(row.cost) || 0,
				requests: Number(row.requests) || 0,
			};
		}
		return aggregate;
	}

	async byProvider(filters: UsageQueryFilters = {}): Promise<
		Array<{
			provider: string;
			tokens: number;
			promptTokens: number;
			completionTokens: number;
			reasoningTokens: number;
			cost: number;
			requests: number;
		}>
	> {
		const { where, params } = buildWhere(filters);
		const rows = await this.db.all<{
			provider: string;
			tokens: number;
			promptTokens: number;
			completionTokens: number;
			reasoningTokens: number;
			cost: number;
			requests: number;
		}>(
			`SELECT provider,
			        SUM(total_tokens) AS tokens,
			        SUM(prompt_tokens) AS promptTokens,
			        SUM(completion_tokens) AS completionTokens,
			        SUM(reasoning_tokens) AS reasoningTokens,
			        SUM(estimated_cost) AS cost,
			        COUNT(*) AS requests
			 FROM ai_usage_events ${where}
			 GROUP BY provider
			 ORDER BY cost DESC`,
			params,
		);
		return rows ?? [];
	}

	async byAgent(filters: UsageQueryFilters = {}): Promise<
		Array<{
			agentId: string;
			tokens: number;
			cost: number;
			requests: number;
		}>
	> {
		const { where, params } = buildWhere(filters);
		const rows = await this.db.all<{
			agent_id: string;
			tokens: number;
			cost: number;
			requests: number;
		}>(
			`SELECT agent_id, SUM(total_tokens) AS tokens, SUM(estimated_cost) AS cost, COUNT(*) AS requests
			 FROM ai_usage_events ${where}
			 GROUP BY agent_id
			 ORDER BY cost DESC`,
			params,
		);
		return (rows ?? [])
			.filter((r): r is typeof r & { agent_id: string } => Boolean(r.agent_id))
			.map((r) => ({
				agentId: r.agent_id,
				tokens: r.tokens ?? 0,
				cost: r.cost ?? 0,
				requests: r.requests ?? 0,
			}));
	}

	// --- Provider quota snapshot persistence (survives restarts) ---

	async saveQuotaSnapshot(snapshot: CachedQuota): Promise<void> {
		void this.db
			.run(
				`INSERT INTO provider_quota_cache (provider, payload, captured_at)
				 VALUES (?, ?, ?)
				 ON CONFLICT(provider) DO UPDATE SET payload = excluded.payload, captured_at = excluded.captured_at`,
				[snapshot.provider, JSON.stringify(snapshot), snapshot.capturedAt],
			)
			.catch((err) => {
				console.error("[usage-store] failed to persist quota snapshot:", err);
			});
	}

	async loadQuotaSnapshot(provider: string): Promise<CachedQuota | null> {
		const row = await this.db
			.get<{ payload: string }>(
				"SELECT payload FROM provider_quota_cache WHERE provider = ?",
				[provider],
			)
			.catch(() => undefined);
		if (!row?.payload) return null;
		try {
			return JSON.parse(row.payload) as CachedQuota;
		} catch {
			return null;
		}
	}
}

function buildWhere(filters: UsageQueryFilters): {
	where: string;
	params: unknown[];
} {
	const clauses: string[] = [];
	const params: unknown[] = [];
	if (filters.from) {
		clauses.push("created_at >= ?");
		params.push(filters.from);
	}
	if (filters.to) {
		clauses.push("created_at <= ?");
		params.push(filters.to);
	}
	if (filters.provider) {
		clauses.push("provider = ?");
		params.push(filters.provider);
	}
	if (filters.agentId) {
		clauses.push("agent_id = ?");
		params.push(filters.agentId);
	}
	return {
		where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
		params,
	};
}
