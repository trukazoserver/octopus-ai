import { createHash, randomUUID } from "node:crypto";
import {
	type Dirent,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseAdapter } from "../storage/database.js";
import type { CostSource } from "./pricing.js";
import type { CachedQuota } from "./quota-service.js";

/**
 * Durable LLM usage ledger. The router writes one event per finalized token/cost
 * accounting; everything here survives restarts and feeds the Settings "Uso y
 * Consumo" section and the dashboard totals.
 */

export interface UsageEvent {
	eventId?: string;
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
	costSource?: CostSource;
}
export interface UsageSink {
	record(event: UsageEvent): void;
}

export interface UsageStoreOptions {
	/** Directory containing one durable JSON file per pending LLM usage event. */
	spoolPath?: string;
}

type PersistedUsageEvent = UsageEvent & { eventId: string };
type FailedWrite = {
	operation: () => Promise<void>;
	event: PersistedUsageEvent;
	spooled: boolean;
};

type SpooledUsageEvent = {
	event: PersistedUsageEvent;
	filePath: string;
};

export type MediaUsageStatus =
	| "accepted"
	| "unknown"
	| "succeeded"
	| "failed"
	| "cancelled";

export interface MediaUsageEvent {
	id: string;
	mediaType: "image" | "video";
	provider: string;
	model?: string;
	transport?: string;
	status: MediaUsageStatus;
	jobId?: string;
	toolName?: string;
	agentId?: string;
	conversationId?: string;
	requestedOutputs?: number;
	outputCount?: number;
	requestedDurationSeconds?: number;
	generatedDurationSeconds?: number;
	estimatedCost?: number;
	costSource?: string;
}

export interface MediaUsageSink {
	recordMedia(event: MediaUsageEvent): Promise<void>;
	removeMedia?(id: string): Promise<void>;
}

export interface MediaUsageSlice {
	provider: string;
	requests: number;
	outputs: number;
	requestedOutputs: number;
	generatedDurationSeconds: number;
	requestedDurationSeconds: number;
	knownCost: number;
	unknownCostEvents: number;
}

export interface MediaUsageAggregate {
	requests: number;
	outputs: number;
	requestedOutputs: number;
	generatedDurationSeconds: number;
	requestedDurationSeconds: number;
	knownCost: number;
	unknownCostEvents: number;
	byProvider: Record<string, Omit<MediaUsageSlice, "provider">>;
}

export interface UsageSeriesPoint {
	bucket: string;
	llmRequests: number;
	totalTokens: number;
	llmCost: number;
	llmUnknownCostEvents: number;
	llmEstimatedCostEvents: number;
	mediaRequests: number;
	mediaOutputs: number;
	generatedDurationSeconds: number;
	mediaKnownCost: number;
	mediaUnknownCostEvents: number;
}

export interface UsageExportRow {
	createdAt: string;
	category: "llm" | "multimedia";
	eventId?: string;
	mediaType?: string;
	provider: string;
	model?: string;
	status?: string;
	requestId?: string;
	jobId?: string;
	agentId?: string;
	conversationId?: string;
	promptTokens?: number;
	completionTokens?: number;
	reasoningTokens?: number;
	totalTokens?: number;
	requestedOutputs?: number;
	outputCount?: number;
	requestedDurationSeconds?: number;
	generatedDurationSeconds?: number;
	estimatedCost?: number;
	costSource?: string;
	costKnown: boolean;
}

export interface UsageExportResult {
	rows: UsageExportRow[];
	truncated: boolean;
	limit: number;
}

export interface ProviderUsageSlice {
	tokens: number;
	promptTokens: number;
	completionTokens: number;
	reasoningTokens: number;
	cost: number;
	requests: number;
	unknownCostEvents: number;
	estimatedCostEvents: number;
}

export interface UsageAggregate {
	totalTokens: number;
	promptTokens: number;
	completionTokens: number;
	reasoningTokens: number;
	totalCost: number;
	requests: number;
	unknownCostEvents: number;
	estimatedCostEvents: number;
	byProvider: Record<string, ProviderUsageSlice>;
}

export interface UsageQueryFilters {
	from?: string;
	to?: string;
	agentId?: string;
	provider?: string;
	mediaType?: "image" | "video";
}

const EMPTY_AGGREGATE: UsageAggregate = {
	totalTokens: 0,
	promptTokens: 0,
	completionTokens: 0,
	reasoningTokens: 0,
	totalCost: 0,
	requests: 0,
	unknownCostEvents: 0,
	estimatedCostEvents: 0,
	byProvider: {},
};

export class UsageStore implements UsageSink, MediaUsageSink {
	private readonly pendingWrites = new Set<Promise<void>>();
	private readonly failedWrites: FailedWrite[] = [];
	private readonly failedWriteCap = 1000;

	constructor(
		private db: DatabaseAdapter,
		private readonly options: UsageStoreOptions = {},
	) {}

	/**
	 * Journal an event synchronously, then persist it to the database off the LLM
	 * hot path. A per-provider-call event id provides durable deduplication.
	 */
	record(event: UsageEvent): void {
		const persistedEvent: PersistedUsageEvent = {
			...event,
			eventId: event.eventId ?? randomUUID(),
		};
		let spooled = false;
		if (this.options.spoolPath) {
			try {
				this.persistSpoolEvent(persistedEvent);
				spooled = true;
			} catch (error) {
				console.error("[usage-store] failed to spool usage event:", error);
			}
		}
		this.enqueueWrite({
			operation: () => this.persistUsageEvent(persistedEvent),
			event: persistedEvent,
			spooled,
		});
	}

	private async persistUsageEvent(event: PersistedUsageEvent): Promise<void> {
		await this.db.run(
				`INSERT INTO ai_usage_events
					(event_id, provider, model, agent_id, conversation_id, request_id,
					 prompt_tokens, completion_tokens, reasoning_tokens, total_tokens,
					 estimated_cost, cost_source)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT DO NOTHING`,
				[
					event.eventId,
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
					event.costSource ?? "unknown",
				],
			);
		await this.db.flush?.();
	}

	async drain(): Promise<void> {
		await Promise.allSettled([...this.pendingWrites]);
		const retry = this.failedWrites.splice(0);
		const failures: unknown[] = [];
		const deadline = Date.now() + 5000;
		while (retry.length > 0 && Date.now() < deadline) {
			const batch = retry.splice(0, 25);
			const settled = await Promise.allSettled(
				batch.map((write) => this.retryWrite(write.operation)),
			);
			for (const [index, result] of settled.entries()) {
				const write = batch[index];
				if (!write) continue;
				if (result.status === "rejected") {
					this.retainFailedWrite(write);
					failures.push(result.reason);
				} else if (write.spooled) {
					await this.removeSpoolEvent(write.event.eventId).catch((error) => {
						console.error("[usage-store] failed to acknowledge spooled event:", error);
					});
				}
			}
		}
		if (retry.length > 0) {
			for (const write of retry) this.retainFailedWrite(write);
			failures.push(new Error("Usage write drain exceeded its 5-second budget"));
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, "Usage events could not be persisted");
		}
	}

	async replaySpool(): Promise<void> {
		const spooledEvents = await this.readSpool();
		if (spooledEvents.length === 0) return;
		let failedCount = 0;
		for (let offset = 0; offset < spooledEvents.length; offset += 25) {
			const batch = spooledEvents.slice(offset, offset + 25);
			const settled = await Promise.allSettled(
				batch.map(({ event }) =>
					this.retryWrite(() => this.persistUsageEvent(event)),
				),
			);
			for (const [index, result] of settled.entries()) {
				const spooled = batch[index];
				if (!spooled) continue;
				if (result.status === "rejected") {
					failedCount++;
					this.retainFailedWrite({
						operation: () => this.persistUsageEvent(spooled.event),
						event: spooled.event,
						spooled: true,
					});
				} else {
					await rm(spooled.filePath, { force: true }).catch((error) => {
						console.error("[usage-store] failed to acknowledge replayed event:", error);
					});
				}
			}
		}
		if (failedCount > 0) {
			console.error(
				`[usage-store] ${failedCount} spooled usage event(s) remain pending`,
			);
		}
	}

	async reconcileImageToolReceipts(): Promise<void> {
		const rows = await this.db.all<{ result_json: string }>(
			`SELECT result_json FROM chat_tool_actions
			 WHERE status IN ('completed', 'failed', 'uncertain')
			   AND tool_name IN ('generate_image', 'codex_generate_image', 'codex_edit_image', 'nano-banana-generate')
			   AND result_json LIKE '%usageReceipt%'`,
		);
		for (const row of rows) {
			try {
				const parsed = JSON.parse(row.result_json) as {
					metadata?: {
						usageReceipt?: Partial<MediaUsageEvent>;
						usageReceipts?: Array<Partial<MediaUsageEvent>>;
					};
				};
				const receipts = new Map<string, Partial<MediaUsageEvent>>();
				for (const receipt of parsed.metadata?.usageReceipts ?? []) {
					if (typeof receipt.id === "string") receipts.set(receipt.id, receipt);
				}
				const singular = parsed.metadata?.usageReceipt;
				if (typeof singular?.id === "string") receipts.set(singular.id, singular);
				for (const receipt of receipts.values()) {
					if (
						receipt.mediaType !== "image" ||
						typeof receipt.provider !== "string" ||
						!isMediaUsageStatus(receipt.status)
					) {
						continue;
					}
					try {
						await this.recordMedia({
							id: receipt.id as string,
							mediaType: "image",
							provider: receipt.provider,
							model: receipt.model,
							transport: receipt.transport,
							status: receipt.status,
							toolName: receipt.toolName,
							agentId: receipt.agentId,
							conversationId: receipt.conversationId,
							requestedOutputs: receipt.requestedOutputs,
							outputCount: receipt.outputCount,
							estimatedCost: receipt.estimatedCost,
							costSource: receipt.costSource,
						});
					} catch (error) {
						console.error(
							`[usage-store] failed to reconcile image receipt ${receipt.id}:`,
							error,
						);
					}
				}
			} catch (error) {
				console.error("[usage-store] failed to reconcile image receipt:", error);
			}
		}
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
			aggregate.unknownCostEvents += Number(row.unknownCostEvents) || 0;
			aggregate.estimatedCostEvents += Number(row.estimatedCostEvents) || 0;
			aggregate.byProvider[row.provider] = {
				tokens: Number(row.tokens) || 0,
				promptTokens: Number(row.promptTokens) || 0,
				completionTokens: Number(row.completionTokens) || 0,
				reasoningTokens: Number(row.reasoningTokens) || 0,
				cost: Number(row.cost) || 0,
				requests: Number(row.requests) || 0,
				unknownCostEvents: Number(row.unknownCostEvents) || 0,
				estimatedCostEvents: Number(row.estimatedCostEvents) || 0,
			};
		}
		return aggregate;
	}

	async recordMedia(event: MediaUsageEvent): Promise<void> {
		const operation = async () => {
			await this.db.run(
				`INSERT INTO multimedia_usage_events
				(id, media_type, provider, model, transport, status, job_id, tool_name,
				 agent_id, conversation_id, requested_outputs, output_count,
				 requested_duration_seconds, generated_duration_seconds, estimated_cost, cost_source)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
				updated_at = CURRENT_TIMESTAMP,
				media_type = excluded.media_type,
				provider = excluded.provider,
				model = excluded.model,
				transport = excluded.transport,
				status = CASE
					WHEN multimedia_usage_events.status = 'succeeded' THEN multimedia_usage_events.status
					WHEN excluded.status = 'succeeded' THEN excluded.status
					WHEN multimedia_usage_events.status IN ('failed', 'cancelled')
						 AND excluded.status IN ('unknown', 'accepted')
						THEN multimedia_usage_events.status
					ELSE excluded.status
				END,
				job_id = COALESCE(excluded.job_id, multimedia_usage_events.job_id),
				tool_name = COALESCE(excluded.tool_name, multimedia_usage_events.tool_name),
				agent_id = COALESCE(excluded.agent_id, multimedia_usage_events.agent_id),
				conversation_id = COALESCE(excluded.conversation_id, multimedia_usage_events.conversation_id),
				requested_outputs = excluded.requested_outputs,
				output_count = MAX(multimedia_usage_events.output_count, excluded.output_count),
				requested_duration_seconds = excluded.requested_duration_seconds,
				generated_duration_seconds = CASE
					WHEN multimedia_usage_events.generated_duration_seconds IS NULL THEN excluded.generated_duration_seconds
					WHEN excluded.generated_duration_seconds IS NULL THEN multimedia_usage_events.generated_duration_seconds
					ELSE MAX(multimedia_usage_events.generated_duration_seconds, excluded.generated_duration_seconds)
				END,
				estimated_cost = COALESCE(excluded.estimated_cost, multimedia_usage_events.estimated_cost),
				cost_source = COALESCE(excluded.cost_source, multimedia_usage_events.cost_source)`,
				[
					event.id,
					event.mediaType,
					event.provider,
					event.model ?? null,
					event.transport ?? null,
					event.status,
					event.jobId ?? null,
					event.toolName ?? null,
					event.agentId ?? null,
					event.conversationId ?? null,
					Math.max(1, Math.trunc(event.requestedOutputs ?? 1)),
					Math.max(0, Math.trunc(event.outputCount ?? 0)),
					event.requestedDurationSeconds ?? null,
					event.generatedDurationSeconds ?? null,
					event.estimatedCost ?? null,
					event.costSource ?? null,
				],
			);
			await this.db.flush?.();
		};
		await this.retryWrite(operation);
	}

	async removeMedia(id: string): Promise<void> {
		await this.retryWrite(async () => {
			await this.db.run("DELETE FROM multimedia_usage_events WHERE id = ?", [id]);
			await this.db.flush?.();
		});
	}

	private enqueueWrite(failedWrite: FailedWrite): void {
		const write = this.retryWrite(failedWrite.operation)
			.then(async () => {
				if (!failedWrite.spooled) return;
				await this.removeSpoolEvent(failedWrite.event.eventId).catch((error) => {
					console.error("[usage-store] failed to acknowledge spooled event:", error);
				});
			})
			.catch((error) => {
				this.retainFailedWrite(failedWrite);
				console.error("[usage-store] failed to persist event after retries:", error);
			})
			.finally(() => this.pendingWrites.delete(write));
		this.pendingWrites.add(write);
	}

	private retainFailedWrite(write: FailedWrite): void {
		if (!write.spooled && this.options.spoolPath) {
			try {
				this.persistSpoolEvent(write.event);
				write.spooled = true;
			} catch (error) {
				console.error("[usage-store] failed to spool usage event:", error);
			}
		}
		if (this.failedWrites.length >= this.failedWriteCap) {
			const discardIndex = this.options.spoolPath
				? this.failedWrites.findIndex((candidate) => candidate.spooled)
				: 0;
			if (discardIndex >= 0) {
				this.failedWrites.splice(discardIndex, 1);
				console.error(this.options.spoolPath
					? "[usage-store] failed write memory queue reached capacity; the durable spool retains the evicted event"
					: "[usage-store] failed write memory queue reached capacity; configure a spool path to prevent loss");
			}
		}
		this.failedWrites.push(write);
	}

	private persistSpoolEvent(event: PersistedUsageEvent): void {
		const spoolDir = this.options.spoolPath;
		if (!spoolDir) return;
		mkdirSync(spoolDir, { recursive: true });
		const target = this.spoolFilePath(event.eventId);
		if (existsSync(target)) return;
		const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, JSON.stringify(event), {
				encoding: "utf8",
				mode: 0o600,
				flush: true,
			});
			renameSync(temporary, target);
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
	}

	private removeSpoolEvent(eventId: string): Promise<void> {
		if (!this.options.spoolPath) return Promise.resolve();
		return rm(this.spoolFilePath(eventId), { force: true });
	}

	private spoolFilePath(eventId: string): string {
		const spoolDir = this.options.spoolPath;
		if (!spoolDir) throw new Error("Usage spool path is not configured");
		const key = createHash("sha256").update(eventId).digest("hex");
		return join(spoolDir, `${key}.json`);
	}

	private async readSpool(): Promise<SpooledUsageEvent[]> {
		const spoolDir = this.options.spoolPath;
		if (!spoolDir) return [];
		let entries: Dirent[];
		try {
			entries = await readdir(spoolDir, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const events: SpooledUsageEvent[] = [];
		for (const entry of entries) {
			if (
				!entry.isFile() ||
				(!entry.name.endsWith(".json") && !entry.name.endsWith(".tmp"))
			) {
				continue;
			}
			const filePath = join(spoolDir, entry.name);
			try {
				const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
				if (isPersistedUsageEvent(parsed)) {
					events.push({ event: parsed, filePath });
				} else {
					console.error(`[usage-store] ignored invalid spool entry: ${entry.name}`);
				}
			} catch {
				console.error(`[usage-store] ignored malformed spool entry: ${entry.name}`);
			}
		}
		return events;
	}

	private async retryWrite(operation: () => Promise<void>): Promise<void> {
		let lastError: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await operation();
				return;
			} catch (error) {
				lastError = error;
				if (attempt < 2) {
					await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
				}
			}
		}
		throw lastError;
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
			unknownCostEvents: number;
			estimatedCostEvents: number;
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
			unknownCostEvents: number;
			estimatedCostEvents: number;
		}>(
			`SELECT provider,
			        SUM(total_tokens) AS tokens,
			        SUM(prompt_tokens) AS "promptTokens",
			        SUM(completion_tokens) AS "completionTokens",
			        SUM(reasoning_tokens) AS "reasoningTokens",
			        SUM(estimated_cost) AS cost,
			        COUNT(*) AS requests,
			        SUM(CASE WHEN cost_source = 'unknown' THEN 1 ELSE 0 END) AS "unknownCostEvents",
			        SUM(CASE WHEN cost_source = 'catalog-estimate' THEN 1 ELSE 0 END) AS "estimatedCostEvents"
			 FROM ai_usage_events ${where}
			 GROUP BY provider
			 ORDER BY cost DESC`,
			params,
		);
		return (rows ?? []).map((row) => ({
			provider: row.provider,
			tokens: Number(row.tokens) || 0,
			promptTokens: Number(row.promptTokens) || 0,
			completionTokens: Number(row.completionTokens) || 0,
			reasoningTokens: Number(row.reasoningTokens) || 0,
			cost: Number(row.cost) || 0,
			requests: Number(row.requests) || 0,
			unknownCostEvents: Number(row.unknownCostEvents) || 0,
			estimatedCostEvents: Number(row.estimatedCostEvents) || 0,
		}));
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

	async mediaAggregate(
		filters: UsageQueryFilters = {},
	): Promise<MediaUsageAggregate> {
		const providers = await this.mediaByProvider(filters);
		const aggregate: MediaUsageAggregate = {
			requests: 0,
			outputs: 0,
			requestedOutputs: 0,
			generatedDurationSeconds: 0,
			requestedDurationSeconds: 0,
			knownCost: 0,
			unknownCostEvents: 0,
			byProvider: {},
		};
		for (const row of providers) {
			aggregate.requests += Number(row.requests) || 0;
			aggregate.outputs += Number(row.outputs) || 0;
			aggregate.requestedOutputs += Number(row.requestedOutputs) || 0;
			aggregate.generatedDurationSeconds +=
				Number(row.generatedDurationSeconds) || 0;
			aggregate.requestedDurationSeconds +=
				Number(row.requestedDurationSeconds) || 0;
			aggregate.knownCost += Number(row.knownCost) || 0;
			aggregate.unknownCostEvents += Number(row.unknownCostEvents) || 0;
			aggregate.byProvider[row.provider] = {
				requests: Number(row.requests) || 0,
				outputs: Number(row.outputs) || 0,
				requestedOutputs: Number(row.requestedOutputs) || 0,
				generatedDurationSeconds:
					Number(row.generatedDurationSeconds) || 0,
				requestedDurationSeconds:
					Number(row.requestedDurationSeconds) || 0,
				knownCost: Number(row.knownCost) || 0,
				unknownCostEvents: Number(row.unknownCostEvents) || 0,
			};
		}
		return aggregate;
	}

	async mediaByProvider(
		filters: UsageQueryFilters = {},
	): Promise<MediaUsageSlice[]> {
		const { where, params } = buildMediaWhere(filters);
		const rows = await this.db.all<MediaUsageSlice>(
			`SELECT provider,
			        COUNT(*) AS requests,
			        SUM(output_count) AS outputs,
			        SUM(requested_outputs) AS "requestedOutputs",
			        SUM(COALESCE(generated_duration_seconds, 0)) AS "generatedDurationSeconds",
			        SUM(COALESCE(requested_duration_seconds, 0)) AS "requestedDurationSeconds",
			        SUM(COALESCE(estimated_cost, 0)) AS "knownCost",
			        SUM(CASE WHEN estimated_cost IS NULL THEN 1 ELSE 0 END) AS "unknownCostEvents"
			 FROM multimedia_usage_events ${where}
			 GROUP BY provider
			 ORDER BY requests DESC`,
			params,
		);
		return rows.map((row) => ({
			provider: row.provider,
			requests: Number(row.requests) || 0,
			outputs: Number(row.outputs) || 0,
			requestedOutputs: Number(row.requestedOutputs) || 0,
			generatedDurationSeconds: Number(row.generatedDurationSeconds) || 0,
			requestedDurationSeconds: Number(row.requestedDurationSeconds) || 0,
			knownCost: Number(row.knownCost) || 0,
			unknownCostEvents: Number(row.unknownCostEvents) || 0,
		}));
	}

	async timeSeries(
		filters: UsageQueryFilters = {},
		granularity: "hour" | "day" = "day",
	): Promise<UsageSeriesPoint[]> {
		const bucketLength = granularity === "hour" ? 13 : 10;
		const bucket = `substr(replace(created_at, 'T', ' '), 1, ${bucketLength})`;
		const llmWhere = buildWhere(filters);
		const mediaWhere = buildMediaWhere(filters);
		const [llmRows, mediaRows] = await Promise.all([
			this.db.all<{
				bucket: string;
				requests: number;
				tokens: number;
				cost: number;
				unknownCostEvents: number;
				estimatedCostEvents: number;
			}>(
				`SELECT ${bucket} AS bucket, COUNT(*) AS requests,
				        SUM(total_tokens) AS tokens, SUM(estimated_cost) AS cost,
				        SUM(CASE WHEN cost_source = 'unknown' THEN 1 ELSE 0 END) AS "unknownCostEvents",
				        SUM(CASE WHEN cost_source = 'catalog-estimate' THEN 1 ELSE 0 END) AS "estimatedCostEvents"
				 FROM ai_usage_events ${llmWhere.where}
				 GROUP BY ${bucket} ORDER BY bucket ASC`,
				llmWhere.params,
			),
			this.db.all<{
				bucket: string;
				requests: number;
				outputs: number;
				seconds: number;
				cost: number;
				unknownCostEvents: number;
			}>(
				`SELECT ${bucket} AS bucket, COUNT(*) AS requests,
				        SUM(output_count) AS outputs,
				        SUM(COALESCE(generated_duration_seconds, 0)) AS seconds,
				        SUM(COALESCE(estimated_cost, 0)) AS cost,
				        SUM(CASE WHEN estimated_cost IS NULL THEN 1 ELSE 0 END) AS "unknownCostEvents"
				 FROM multimedia_usage_events ${mediaWhere.where}
				 GROUP BY ${bucket} ORDER BY bucket ASC`,
				mediaWhere.params,
			),
		]);
		const points = new Map<string, UsageSeriesPoint>();
		const pointFor = (key: string) => {
			const existing = points.get(key);
			if (existing) return existing;
			const created: UsageSeriesPoint = {
				bucket: key,
				llmRequests: 0,
				totalTokens: 0,
				llmCost: 0,
				llmUnknownCostEvents: 0,
				llmEstimatedCostEvents: 0,
				mediaRequests: 0,
				mediaOutputs: 0,
				generatedDurationSeconds: 0,
				mediaKnownCost: 0,
				mediaUnknownCostEvents: 0,
			};
			points.set(key, created);
			return created;
		};
		for (const row of llmRows) {
			const point = pointFor(row.bucket);
			point.llmRequests = Number(row.requests) || 0;
			point.totalTokens = Number(row.tokens) || 0;
			point.llmCost = Number(row.cost) || 0;
			point.llmUnknownCostEvents = Number(row.unknownCostEvents) || 0;
			point.llmEstimatedCostEvents = Number(row.estimatedCostEvents) || 0;
		}
		for (const row of mediaRows) {
			const point = pointFor(row.bucket);
			point.mediaRequests = Number(row.requests) || 0;
			point.mediaOutputs = Number(row.outputs) || 0;
			point.generatedDurationSeconds = Number(row.seconds) || 0;
			point.mediaKnownCost = Number(row.cost) || 0;
			point.mediaUnknownCostEvents = Number(row.unknownCostEvents) || 0;
		}
		return [...points.values()].sort((left, right) =>
			left.bucket.localeCompare(right.bucket),
		);
	}

	async exportRows(
		filters: UsageQueryFilters = {},
		limit = 10_000,
	): Promise<UsageExportResult> {
		const safeLimit = Math.max(1, Math.min(50_000, Math.trunc(limit)));
		const queryLimit = safeLimit + 1;
		const llmWhere = buildWhere(filters);
		const mediaWhere = buildMediaWhere(filters);
		const [llmRows, mediaRows] = await Promise.all([
			this.db.all<Record<string, unknown>>(
				`SELECT id AS "eventId", created_at AS "createdAt", provider, model, agent_id AS "agentId",
				        conversation_id AS "conversationId", request_id AS "requestId",
				        prompt_tokens AS "promptTokens", completion_tokens AS "completionTokens",
				        reasoning_tokens AS "reasoningTokens", total_tokens AS "totalTokens",
				        estimated_cost AS "estimatedCost", cost_source AS "costSource"
				 FROM ai_usage_events ${llmWhere.where}
				 ORDER BY created_at DESC LIMIT ${queryLimit}`,
				llmWhere.params,
			),
			this.db.all<Record<string, unknown>>(
				`SELECT id AS "eventId", created_at AS "createdAt", media_type AS "mediaType", provider, model,
				        status, job_id AS "jobId", agent_id AS "agentId",
				        conversation_id AS "conversationId",
				        requested_outputs AS "requestedOutputs", output_count AS "outputCount",
				        requested_duration_seconds AS "requestedDurationSeconds",
				        generated_duration_seconds AS "generatedDurationSeconds",
				        estimated_cost AS "estimatedCost", cost_source AS "costSource"
				 FROM multimedia_usage_events ${mediaWhere.where}
				 ORDER BY created_at DESC LIMIT ${queryLimit}`,
				mediaWhere.params,
			),
		]);
		const rows: UsageExportRow[] = [
			...llmRows.map((row) => exportRow(row, "llm")),
			...mediaRows.map((row) => exportRow(row, "multimedia")),
		];
		const sorted = rows
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
			.slice(0, queryLimit);
		return {
			rows: sorted.slice(0, safeLimit),
			truncated: sorted.length > safeLimit,
			limit: safeLimit,
		};
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
		params.push(normalizeDateBoundary(filters.from));
	}
	if (filters.to) {
		clauses.push("created_at <= ?");
		params.push(normalizeDateBoundary(filters.to));
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

function buildMediaWhere(filters: UsageQueryFilters): {
	where: string;
	params: unknown[];
} {
	const clauses: string[] = [];
	const params: unknown[] = [];
	if (filters.from) {
		clauses.push("created_at >= ?");
		params.push(normalizeDateBoundary(filters.from));
	}
	if (filters.to) {
		clauses.push("created_at <= ?");
		params.push(normalizeDateBoundary(filters.to));
	}
	if (filters.provider) {
		clauses.push("provider = ?");
		params.push(filters.provider);
	}
	if (filters.agentId) {
		clauses.push("agent_id = ?");
		params.push(filters.agentId);
	}
	if (filters.mediaType) {
		clauses.push("media_type = ?");
		params.push(filters.mediaType);
	}
	return {
		where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
		params,
	};
}

function exportRow(
	row: Record<string, unknown>,
	category: "llm" | "multimedia",
): UsageExportRow {
	const estimatedCost = nullableNumber(row.estimatedCost);
	return {
		createdAt: String(row.createdAt ?? ""),
		category,
		eventId: optionalString(row.eventId),
		mediaType: optionalString(row.mediaType),
		provider: String(row.provider ?? "unknown"),
		model: optionalString(row.model),
		status: optionalString(row.status),
		requestId: optionalString(row.requestId),
		jobId: optionalString(row.jobId),
		agentId: optionalString(row.agentId),
		conversationId: optionalString(row.conversationId),
		promptTokens: nullableNumber(row.promptTokens),
		completionTokens: nullableNumber(row.completionTokens),
		reasoningTokens: nullableNumber(row.reasoningTokens),
		totalTokens: nullableNumber(row.totalTokens),
		requestedOutputs: nullableNumber(row.requestedOutputs),
		outputCount: nullableNumber(row.outputCount),
		requestedDurationSeconds: nullableNumber(row.requestedDurationSeconds),
		generatedDurationSeconds: nullableNumber(row.generatedDurationSeconds),
		estimatedCost,
		costSource: optionalString(row.costSource),
		costKnown:
			category === "llm"
				? row.costSource !== "unknown"
				: estimatedCost !== undefined,
	};
}

function optionalString(value: unknown): string | undefined {
	return value === null || value === undefined ? undefined : String(value);
}

function nullableNumber(value: unknown): number | undefined {
	if (value === null || value === undefined) return undefined;
	const number = Number(value);
	return Number.isFinite(number) ? number : undefined;
}

function normalizeDateBoundary(value: string): string {
	const timestamp = new Date(value);
	if (Number.isNaN(timestamp.getTime())) {
		throw new Error(`Invalid usage date boundary: ${value}`);
	}
	return timestamp.toISOString().replace("T", " ").replace(/Z$/, "");
}

function isMediaUsageStatus(value: unknown): value is MediaUsageStatus {
	return (
		value === "accepted" ||
		value === "unknown" ||
		value === "succeeded" ||
		value === "failed" ||
		value === "cancelled"
	);
}

function isPersistedUsageEvent(value: unknown): value is PersistedUsageEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Partial<PersistedUsageEvent>;
	return (
		typeof event.eventId === "string" &&
		typeof event.provider === "string" &&
		typeof event.promptTokens === "number" &&
		Number.isFinite(event.promptTokens) &&
		typeof event.completionTokens === "number" &&
		Number.isFinite(event.completionTokens) &&
		typeof event.totalTokens === "number" &&
		Number.isFinite(event.totalTokens) &&
		typeof event.estimatedCost === "number" &&
		Number.isFinite(event.estimatedCost)
	);
}
