import type { LLMRouter } from "../ai/router.js";
import type { LLMMessage } from "../ai/types.js";
import type { DatabaseAdapter } from "../storage/database.js";
import { createLogger } from "../utils/logger.js";

/**
 * HeartbeatDaemon — Proactive Autonomous Agent
 *
 * Inspired by OpenClaw's heartbeat mechanism. Runs on a configurable
 * interval and proactively checks a "checklist" of tasks, deciding
 * autonomously if any action is needed.
 *
 * Key difference from cron: heartbeat tasks are evaluated by the LLM,
 * not executed blindly. The agent DECIDES if action is needed.
 */

const logger = createLogger("heartbeat");

export interface HeartbeatConfig {
	/** Interval between heartbeats in milliseconds (default: 30 min) */
	intervalMs: number;
	/** Whether the heartbeat is enabled */
	enabled: boolean;
	/** Model to use for heartbeat evaluation */
	model?: string;
	/** Maximum tokens for heartbeat response */
	maxTokens: number;
	/** Suppress silent heartbeats from notifications */
	suppressSilent: boolean;
}

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
	intervalMs: 30 * 60 * 1000, // 30 minutes
	enabled: false,
	maxTokens: 1500,
	suppressSilent: true,
};

export interface HeartbeatItem {
	id: string;
	description: string;
	priority: "high" | "medium" | "low";
	lastChecked: string | null;
	lastActionTaken: string | null;
	enabled: boolean;
	createdAt: string;
}

export interface HeartbeatResult {
	timestamp: Date;
	status: "ok" | "action_taken" | "error";
	itemsChecked: number;
	actionsTriggered: HeartbeatAction[];
	silent: boolean;
}

export interface HeartbeatAction {
	itemId: string;
	description: string;
	action: string;
	result: string;
}

type ActionCallback = (
	action: string,
	context: { itemId: string; description: string },
) => Promise<string>;

const HEARTBEAT_SYSTEM_PROMPT = `You are the heartbeat engine of an AI assistant called Octopus AI. You are reviewing a checklist of proactive tasks.

For each item, evaluate whether action is needed RIGHT NOW. Respond in valid JSON:
{
  "items": [
    {
      "id": "<item_id>",
      "needsAction": true/false,
      "reason": "<why action is or isn't needed>",
      "action": "<specific action to take, or null if no action needed>"
    }
  ]
}

Rules:
- Be conservative — only trigger actions when truly necessary
- Consider the time since last check
- Prefer silence over noise
- If nothing needs attention, all items should have needsAction: false`;

export class HeartbeatDaemon {
	private config: HeartbeatConfig;
	private llmRouter: LLMRouter;
	private db: DatabaseAdapter;
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private actionCallback: ActionCallback | null = null;
	private initialized = false;

	constructor(
		llmRouter: LLMRouter,
		db: DatabaseAdapter,
		config: Partial<HeartbeatConfig> = {},
	) {
		this.config = { ...DEFAULT_HEARTBEAT_CONFIG, ...config };
		this.llmRouter = llmRouter;
		this.db = db;
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;

		await this.db.run(
			`CREATE TABLE IF NOT EXISTS heartbeat_items (
				id TEXT PRIMARY KEY,
				description TEXT NOT NULL,
				priority TEXT NOT NULL DEFAULT 'medium',
				last_checked TEXT,
				last_action_taken TEXT,
				enabled INTEGER NOT NULL DEFAULT 1,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			)`,
		);

		await this.db.run(
			`CREATE TABLE IF NOT EXISTS heartbeat_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				timestamp TEXT NOT NULL DEFAULT (datetime('now')),
				status TEXT NOT NULL,
				items_checked INTEGER NOT NULL DEFAULT 0,
				actions_json TEXT,
				silent INTEGER NOT NULL DEFAULT 1
			)`,
		);

		this.initialized = true;
	}

	/**
	 * Register a callback that executes actions determined by the heartbeat.
	 */
	onAction(callback: ActionCallback): void {
		this.actionCallback = callback;
	}

	/**
	 * Start the heartbeat daemon loop.
	 */
	async start(): Promise<void> {
		if (this.running) return;
		await this.initialize();

		this.running = true;
		logger.info(
			`Heartbeat daemon started (interval: ${this.config.intervalMs / 1000}s)`,
		);

		// Run immediately on start
		this.pulse().catch((e) =>
			logger.error("Initial heartbeat pulse failed:", e),
		);

		// Then on interval
		this.timer = setInterval(() => {
			this.pulse().catch((e) =>
				logger.error("Heartbeat pulse failed:", e),
			);
		}, this.config.intervalMs);
	}

	/**
	 * Stop the heartbeat daemon.
	 */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.running = false;
		logger.info("Heartbeat daemon stopped");
	}

	/**
	 * Execute a single heartbeat pulse.
	 */
	async pulse(): Promise<HeartbeatResult> {
		await this.initialize();
		const items = await this.getEnabledItems();

		if (items.length === 0) {
			return {
				timestamp: new Date(),
				status: "ok",
				itemsChecked: 0,
				actionsTriggered: [],
				silent: true,
			};
		}

		try {
			// Ask the LLM to evaluate the checklist
			const messages = this.buildEvaluationPrompt(items);
			const response = await this.llmRouter.chat({
				model: this.config.model ?? "default",
				messages,
				maxTokens: this.config.maxTokens,
				temperature: 0.2,
			});

			const decisions = this.parseDecisions(response.content);
			const actionsTriggered: HeartbeatAction[] = [];

			for (const decision of decisions) {
				if (!decision.needsAction) continue;

				const item = items.find((i) => i.id === decision.id);
				if (!item) continue;

				let actionResult = "No handler registered";
				if (this.actionCallback && decision.action) {
					try {
						actionResult = await this.actionCallback(decision.action, {
							itemId: item.id,
							description: item.description,
						});
					} catch (err) {
						actionResult = `Error: ${err instanceof Error ? err.message : String(err)}`;
					}
				}

				actionsTriggered.push({
					itemId: item.id,
					description: item.description,
					action: decision.action ?? "unknown",
					result: actionResult,
				});

				// Update last action
				await this.db.run(
					"UPDATE heartbeat_items SET last_action_taken = ?, last_checked = ? WHERE id = ?",
					[new Date().toISOString(), new Date().toISOString(), item.id],
				);
			}

			// Update last checked for all items
			const now = new Date().toISOString();
			for (const item of items) {
				await this.db.run(
					"UPDATE heartbeat_items SET last_checked = ? WHERE id = ?",
					[now, item.id],
				);
			}

			const result: HeartbeatResult = {
				timestamp: new Date(),
				status:
					actionsTriggered.length > 0 ? "action_taken" : "ok",
				itemsChecked: items.length,
				actionsTriggered,
				silent: actionsTriggered.length === 0,
			};

			await this.logResult(result);
			return result;
		} catch (err) {
			logger.error(`Heartbeat evaluation failed: ${String(err)}`);
			const result: HeartbeatResult = {
				timestamp: new Date(),
				status: "error",
				itemsChecked: items.length,
				actionsTriggered: [],
				silent: false,
			};
			await this.logResult(result);
			return result;
		}
	}

	// --- CRUD for heartbeat items ---

	async addItem(
		id: string,
		description: string,
		priority: "high" | "medium" | "low" = "medium",
	): Promise<void> {
		await this.initialize();
		await this.db.run(
			"INSERT OR REPLACE INTO heartbeat_items (id, description, priority, enabled, created_at) VALUES (?, ?, ?, 1, datetime('now'))",
			[id, description, priority],
		);
	}

	async removeItem(id: string): Promise<void> {
		await this.initialize();
		await this.db.run("DELETE FROM heartbeat_items WHERE id = ?", [id]);
	}

	async toggleItem(id: string, enabled: boolean): Promise<void> {
		await this.initialize();
		await this.db.run(
			"UPDATE heartbeat_items SET enabled = ? WHERE id = ?",
			[enabled ? 1 : 0, id],
		);
	}

	async getItems(): Promise<HeartbeatItem[]> {
		await this.initialize();
		const rows = await this.db.all<{
			id: string;
			description: string;
			priority: string;
			last_checked: string | null;
			last_action_taken: string | null;
			enabled: number;
			created_at: string;
		}>("SELECT * FROM heartbeat_items ORDER BY priority ASC, created_at ASC");

		return rows.map((r) => ({
			id: r.id,
			description: r.description,
			priority: r.priority as "high" | "medium" | "low",
			lastChecked: r.last_checked,
			lastActionTaken: r.last_action_taken,
			enabled: r.enabled === 1,
			createdAt: r.created_at,
		}));
	}

	async getEnabledItems(): Promise<HeartbeatItem[]> {
		const all = await this.getItems();
		return all.filter((i) => i.enabled);
	}

	isRunning(): boolean {
		return this.running;
	}

	// --- Private ---

	private buildEvaluationPrompt(items: HeartbeatItem[]): LLMMessage[] {
		const now = new Date();
		const checklist = items
			.map((item) => {
				const lastChecked = item.lastChecked
					? `Last checked: ${item.lastChecked}`
					: "Never checked";
				const lastAction = item.lastActionTaken
					? `Last action: ${item.lastActionTaken}`
					: "No previous action";
				return `- [${item.id}] (${item.priority}) ${item.description}\n  ${lastChecked} | ${lastAction}`;
			})
			.join("\n");

		return [
			{ role: "system", content: HEARTBEAT_SYSTEM_PROMPT },
			{
				role: "user",
				content: `Current time: ${now.toISOString()}\n\nHeartbeat checklist:\n${checklist}\n\nEvaluate each item.`,
			},
		];
	}

	private parseDecisions(
		content: string,
	): Array<{
		id: string;
		needsAction: boolean;
		reason: string;
		action: string | null;
	}> {
		try {
			const jsonMatch = content.match(/\{[\s\S]*\}/);
			if (!jsonMatch) return [];
			const parsed = JSON.parse(jsonMatch[0]);
			if (!Array.isArray(parsed.items)) return [];
			return parsed.items.map(
				(item: Record<string, unknown>) => ({
					id: String(item.id ?? ""),
					needsAction: Boolean(item.needsAction),
					reason: String(item.reason ?? ""),
					action: item.action ? String(item.action) : null,
				}),
			);
		} catch {
			return [];
		}
	}

	private async logResult(result: HeartbeatResult): Promise<void> {
		try {
			await this.db.run(
				"INSERT INTO heartbeat_log (timestamp, status, items_checked, actions_json, silent) VALUES (?, ?, ?, ?, ?)",
				[
					result.timestamp.toISOString(),
					result.status,
					result.itemsChecked,
					JSON.stringify(result.actionsTriggered),
					result.silent ? 1 : 0,
				],
			);
		} catch {
			// Logging failure shouldn't break heartbeat
		}
	}
}
