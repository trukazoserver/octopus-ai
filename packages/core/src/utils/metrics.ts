import type { DatabaseAdapter } from "../storage/database.js";
import { createLogger } from "../utils/logger.js";

/**
 * MetricsCollector — Observability & Performance Tracking
 *
 * Tracks:
 * - Tool execution metrics (count, latency, success rate)
 * - LLM provider metrics (latency, token usage, errors)
 * - Memory system metrics (size, retrieval latency)
 * - Skill usage metrics (which skills get used, their performance)
 * - Agent performance (response time, user satisfaction)
 */

const logger = createLogger("metrics");

export interface MetricEvent {
	name: string;
	category: "tool" | "llm" | "memory" | "skill" | "agent" | "system";
	value: number;
	unit: "ms" | "count" | "bytes" | "tokens" | "ratio";
	tags: Record<string, string>;
	timestamp: Date;
}

export interface MetricSummary {
	name: string;
	count: number;
	total: number;
	average: number;
	min: number;
	max: number;
	p95: number;
}

export interface MetricsDashboard {
	period: string;
	toolMetrics: ToolMetricsSummary[];
	llmMetrics: LLMMetricsSummary[];
	memoryMetrics: MemoryMetricsSummary;
	systemMetrics: SystemMetricsSummary;
}

export interface ToolMetricsSummary {
	toolName: string;
	executions: number;
	successRate: number;
	avgLatencyMs: number;
	totalLatencyMs: number;
}

export interface LLMMetricsSummary {
	provider: string;
	requests: number;
	avgLatencyMs: number;
	totalTokens: number;
	errors: number;
	errorRate: number;
}

export interface MemoryMetricsSummary {
	totalItems: number;
	avgRetrievalMs: number;
	consolidations: number;
	ftsSearches: number;
}

export interface SystemMetricsSummary {
	uptime: number;
	totalRequests: number;
	avgResponseMs: number;
	heartbeats: number;
	reflections: number;
}

export class MetricsCollector {
	private db: DatabaseAdapter;
	private buffer: MetricEvent[] = [];
	private flushTimer: ReturnType<typeof setInterval> | null = null;
	private initialized = false;
	private readonly BUFFER_SIZE = 50;
	private readonly FLUSH_INTERVAL = 10_000; // 10 seconds

	constructor(db: DatabaseAdapter) {
		this.db = db;
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;

		await this.db.run(
			`CREATE TABLE IF NOT EXISTS metrics (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL,
				category TEXT NOT NULL,
				value REAL NOT NULL,
				unit TEXT NOT NULL,
				tags TEXT NOT NULL DEFAULT '{}',
				timestamp TEXT NOT NULL DEFAULT (datetime('now'))
			)`,
		);

		await this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(name)",
		);
		await this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_metrics_category ON metrics(category)",
		);
		await this.db.run(
			"CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp)",
		);

		// Start periodic flush
		this.flushTimer = setInterval(() => {
			this.flush().catch((e) => logger.error("Metrics flush error:", e));
		}, this.FLUSH_INTERVAL);

		this.initialized = true;
	}

	/**
	 * Record a metric event.
	 */
	record(event: Omit<MetricEvent, "timestamp">): void {
		this.buffer.push({ ...event, timestamp: new Date() });
		if (this.buffer.length >= this.BUFFER_SIZE) {
			this.flush().catch(() => {});
		}
	}

	/**
	 * Convenience: time an async operation.
	 */
	async timeAsync<T>(
		name: string,
		category: MetricEvent["category"],
		operation: () => Promise<T>,
		tags: Record<string, string> = {},
	): Promise<T> {
		const start = performance.now();
		let success = true;
		try {
			const result = await operation();
			return result;
		} catch (err) {
			success = false;
			throw err;
		} finally {
			const elapsed = performance.now() - start;
			this.record({
				name: `${name}.latency`,
				category,
				value: elapsed,
				unit: "ms",
				tags: { ...tags, success: String(success) },
			});
			this.record({
				name: `${name}.count`,
				category,
				value: 1,
				unit: "count",
				tags: { ...tags, success: String(success) },
			});
		}
	}

	// --- Convenience methods ---

	recordToolExecution(
		toolName: string,
		latencyMs: number,
		success: boolean,
	): void {
		this.record({
			name: "tool.execution",
			category: "tool",
			value: latencyMs,
			unit: "ms",
			tags: { tool: toolName, success: String(success) },
		});
	}

	recordLLMRequest(
		provider: string,
		model: string,
		latencyMs: number,
		tokens: number,
		success: boolean,
	): void {
		this.record({
			name: "llm.request",
			category: "llm",
			value: latencyMs,
			unit: "ms",
			tags: { provider, model, success: String(success) },
		});
		this.record({
			name: "llm.tokens",
			category: "llm",
			value: tokens,
			unit: "tokens",
			tags: { provider, model },
		});
	}

	recordMemoryRetrieval(latencyMs: number, resultCount: number): void {
		this.record({
			name: "memory.retrieval",
			category: "memory",
			value: latencyMs,
			unit: "ms",
			tags: { results: String(resultCount) },
		});
	}

	recordReflection(durationMs: number, skillCreated: boolean): void {
		this.record({
			name: "agent.reflection",
			category: "agent",
			value: durationMs,
			unit: "ms",
			tags: { skill_created: String(skillCreated) },
		});
	}

	recordHeartbeat(actionsTaken: number): void {
		this.record({
			name: "agent.heartbeat",
			category: "agent",
			value: actionsTaken,
			unit: "count",
			tags: {},
		});
	}

	/**
	 * Get a summary dashboard for a time period.
	 */
	async getDashboard(
		periodHours = 24,
	): Promise<MetricsDashboard> {
		await this.flush(); // Ensure all buffered metrics are written

		const since = new Date(
			Date.now() - periodHours * 60 * 60 * 1000,
		).toISOString();

		// Tool metrics
		const toolRows = await this.db.all<{
			tool: string;
			avg_value: number;
			total_value: number;
			count: number;
			success_count: number;
		}>(
			`SELECT 
				json_extract(tags, '$.tool') as tool,
				AVG(value) as avg_value,
				SUM(value) as total_value,
				COUNT(*) as count,
				SUM(CASE WHEN json_extract(tags, '$.success') = 'true' THEN 1 ELSE 0 END) as success_count
			FROM metrics 
			WHERE name = 'tool.execution' AND timestamp >= ?
			GROUP BY json_extract(tags, '$.tool')
			ORDER BY count DESC`,
			[since],
		);

		const toolMetrics: ToolMetricsSummary[] = toolRows.map((r) => ({
			toolName: r.tool ?? "unknown",
			executions: r.count,
			successRate: r.count > 0 ? r.success_count / r.count : 0,
			avgLatencyMs: r.avg_value,
			totalLatencyMs: r.total_value,
		}));

		// LLM metrics
		const llmRows = await this.db.all<{
			provider: string;
			avg_value: number;
			count: number;
			error_count: number;
		}>(
			`SELECT 
				json_extract(tags, '$.provider') as provider,
				AVG(value) as avg_value,
				COUNT(*) as count,
				SUM(CASE WHEN json_extract(tags, '$.success') = 'false' THEN 1 ELSE 0 END) as error_count
			FROM metrics 
			WHERE name = 'llm.request' AND timestamp >= ?
			GROUP BY json_extract(tags, '$.provider')`,
			[since],
		);

		const tokenRows = await this.db.all<{
			provider: string;
			total_tokens: number;
		}>(
			`SELECT 
				json_extract(tags, '$.provider') as provider,
				SUM(value) as total_tokens
			FROM metrics 
			WHERE name = 'llm.tokens' AND timestamp >= ?
			GROUP BY json_extract(tags, '$.provider')`,
			[since],
		);

		const tokenMap = new Map(
			tokenRows.map((r) => [r.provider, r.total_tokens]),
		);

		const llmMetrics: LLMMetricsSummary[] = llmRows.map((r) => ({
			provider: r.provider ?? "unknown",
			requests: r.count,
			avgLatencyMs: r.avg_value,
			totalTokens: tokenMap.get(r.provider) ?? 0,
			errors: r.error_count,
			errorRate: r.count > 0 ? r.error_count / r.count : 0,
		}));

		// Memory metrics
		const memoryRow = await this.db.get<{
			avg_value: number;
			count: number;
		}>(
			`SELECT AVG(value) as avg_value, COUNT(*) as count
			 FROM metrics 
			 WHERE name = 'memory.retrieval' AND timestamp >= ?`,
			[since],
		);

		// System metrics
		const reflectionCount = await this.db.get<{ count: number }>(
			`SELECT COUNT(*) as count FROM metrics 
			 WHERE name = 'agent.reflection' AND timestamp >= ?`,
			[since],
		);

		const heartbeatCount = await this.db.get<{ count: number }>(
			`SELECT COUNT(*) as count FROM metrics 
			 WHERE name = 'agent.heartbeat' AND timestamp >= ?`,
			[since],
		);

		return {
			period: `Last ${periodHours} hours`,
			toolMetrics,
			llmMetrics,
			memoryMetrics: {
				totalItems: 0, // Would need to query memory_items
				avgRetrievalMs: memoryRow?.avg_value ?? 0,
				consolidations: 0,
				ftsSearches: 0,
			},
			systemMetrics: {
				uptime: 0,
				totalRequests: toolRows.reduce((sum, r) => sum + r.count, 0) +
					llmRows.reduce((sum, r) => sum + r.count, 0),
				avgResponseMs: 0,
				heartbeats: heartbeatCount?.count ?? 0,
				reflections: reflectionCount?.count ?? 0,
			},
		};
	}

	/**
	 * Flush buffered metrics to the database.
	 */
	async flush(): Promise<void> {
		if (this.buffer.length === 0) return;
		if (!this.initialized) return;

		const events = [...this.buffer];
		this.buffer = [];

		try {
			for (const event of events) {
				await this.db.run(
					"INSERT INTO metrics (name, category, value, unit, tags, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
					[
						event.name,
						event.category,
						event.value,
						event.unit,
						JSON.stringify(event.tags),
						event.timestamp.toISOString(),
					],
				);
			}
		} catch (err) {
			logger.error(`Failed to flush metrics: ${String(err)}`);
			// Re-buffer failed events
			this.buffer.push(...events);
		}
	}

	/**
	 * Cleanup old metrics data.
	 */
	async cleanup(retentionDays = 30): Promise<number> {
		const cutoff = new Date(
			Date.now() - retentionDays * 24 * 60 * 60 * 1000,
		).toISOString();

		const result = await this.db.run(
			"DELETE FROM metrics WHERE timestamp < ?",
			[cutoff],
		);
		return 0;
	}

	/**
	 * Stop the metrics collector.
	 */
	async stop(): Promise<void> {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = null;
		}
		await this.flush();
	}
}
