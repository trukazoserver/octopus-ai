import type { DatabaseAdapter } from "../storage/database.js";
import type { LLMRouter } from "../ai/router.js";
import type { TokenCounter } from "../ai/index.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("daily-memory");

export interface GlobalDailyMemoryConfig {
	maxTokens: number;
	model?: string;
	triggerMessageCount: number;
}

const DEFAULT_CONFIG: GlobalDailyMemoryConfig = {
	maxTokens: 1500,
	triggerMessageCount: 10,
};

const SUMMARIZE_PROMPT = `You are the episodic daily memory of Octopus AI. Your job is to compress recent messages into a cohesive, concise chronological summary of what has been happening today.
You will be provided with the CURRENT SUMMARY of the day, followed by NEW MESSAGES.
Your goal is to output a single, updated summary that integrates the new messages. 

Rules:
1. Preserve important technical context (e.g., file paths, code concepts, precise requests).
2. Keep it concise. Focus on *what* was asked and *what* was done.
3. Eliminate pleasantries and chatty text.
4. Output ONLY the updated summary text. Do not include introductory or concluding remarks.`;

interface RawMessage {
	id: number;
	role: string;
	content: string;
	source: string;
	created_at: string;
}

export class GlobalDailyMemory {
	private db: DatabaseAdapter;
	private router: LLMRouter;
	private tokenCounter: TokenCounter;
	private config: GlobalDailyMemoryConfig;
	private initialized = false;
	private summarizing = false;
	private activeDate: string;

	constructor(
		db: DatabaseAdapter,
		router: LLMRouter,
		tokenCounter: TokenCounter,
		config?: Partial<GlobalDailyMemoryConfig>,
	) {
		this.db = db;
		this.router = router;
		this.tokenCounter = tokenCounter;
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.activeDate = this.getTodayString();
	}

	private getTodayString(): string {
		return new Date().toISOString().split("T")[0]; // YYYY-MM-DD
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;

		await this.db.run(
			`CREATE TABLE IF NOT EXISTS global_daily_memory (
				date_id TEXT PRIMARY KEY,
				summary TEXT NOT NULL DEFAULT '',
				raw_messages TEXT NOT NULL DEFAULT '[]',
				updated_at TEXT NOT NULL DEFAULT (datetime('now'))
			)`,
		);

		await this.ensureTodayRow();
		this.initialized = true;
	}

	private async ensureTodayRow(): Promise<void> {
		const today = this.getTodayString();
		if (this.activeDate !== today) {
			this.activeDate = today;
		}

		await this.db.run(
			`INSERT OR IGNORE INTO global_daily_memory (date_id, summary, raw_messages, updated_at)
			 VALUES (?, '', '[]', datetime('now'))`,
			[this.activeDate],
		);
	}

	async addMessage(content: string, role: string, source: string = "system"): Promise<void> {
		await this.initialize();
		await this.ensureTodayRow();

		try {
			// Fetch current row
			const rows = await this.db.all<{
				date_id: string;
				summary: string;
				raw_messages: string;
			}>("SELECT * FROM global_daily_memory WHERE date_id = ?", [
				this.activeDate,
			]);

			if (rows.length === 0) return;
			const row = rows[0];

			const rawMessages: RawMessage[] = JSON.parse(row.raw_messages || "[]");
			
			const newMessage: RawMessage = {
				id: Date.now(),
				role,
				content: content.trim().substring(0, 5000), // Prevent massive payloads
				source,
				created_at: new Date().toISOString()
			};
			
			rawMessages.push(newMessage);

			await this.db.run(
				`UPDATE global_daily_memory 
				 SET raw_messages = ?, updated_at = datetime('now') 
				 WHERE date_id = ?`,
				[JSON.stringify(rawMessages), this.activeDate],
			);

			if (rawMessages.length >= this.config.triggerMessageCount && !this.summarizing) {
				// Don't await to avoid blocking chat stream
				this.summarizeInternal(rawMessages, row.summary).catch(e => 
					logger.error(`Error summarizing daily memory: ${e}`)
				);
			}
		} catch (e: unknown) {
			logger.error(`Failed to add message to daily memory: ${e}`);
		}
	}

	private async summarizeInternal(
		messagesToSummarize: RawMessage[],
		currentSummary: string
	): Promise<void> {
		if (this.summarizing || messagesToSummarize.length === 0) return;
		this.summarizing = true;

		try {
			const formattedMessages = messagesToSummarize.map(m => 
				`[${m.source}] ${m.role.toUpperCase()}: ${m.content}`
			).join("\n---\n");

			const messages = [
				{ role: "system" as const, content: SUMMARIZE_PROMPT },
				{ role: "user" as const, content: `CURRENT SUMMARY:\n${currentSummary || "No summary yet."}\n\nNEW MESSAGES:\n${formattedMessages}` }
			];

			const response = await this.router.chat({
				model: this.config.model ?? "default",
				messages,
				maxTokens: this.config.maxTokens,
				temperature: 0.1,
			});

			let newSummary = response.content.trim();

			// Ensure we don't blow up the max tokens budget
			const tokens = this.tokenCounter.countTokens(newSummary);
			if (tokens > this.config.maxTokens) {
				logger.warn(`Daily summary exceeded token budget (${tokens} > ${this.config.maxTokens}). Compressing...`);
				newSummary = newSummary.substring(0, this.config.maxTokens * 3); // Rough fallback truncation
			}

			// Clear the summarized messages, but re-fetch in case new ones arrived during summarization
			const rows = await this.db.all<{ raw_messages: string }>(
				"SELECT raw_messages FROM global_daily_memory WHERE date_id = ?",
				[this.activeDate]
			);
			
			let currentRaw = [];
			if (rows.length > 0) {
				currentRaw = JSON.parse(rows[0].raw_messages || "[]");
			}

			// Filter out the messages we just summarized (by ID)
			const summarizedIds = new Set(messagesToSummarize.map(m => m.id));
			const remainingMessages = currentRaw.filter((m: RawMessage) => !summarizedIds.has(m.id));

			await this.db.run(
				`UPDATE global_daily_memory 
				 SET summary = ?, raw_messages = ?, updated_at = datetime('now') 
				 WHERE date_id = ?`,
				[newSummary, JSON.stringify(remainingMessages), this.activeDate],
			);
			
			logger.debug("Daily episodic scratchpad successfully summarized and appended.");

		} finally {
			this.summarizing = false;
		}
	}

	async getCurrentContext(): Promise<string> {
		await this.initialize();
		await this.ensureTodayRow();
		
		const rows = await this.db.all<{
			summary: string;
			raw_messages: string;
		}>("SELECT * FROM global_daily_memory WHERE date_id = ?", [
			this.activeDate,
		]);
		
		if (rows.length === 0) return "No events today yet.";
		
		const row = rows[0];
		const summary = row.summary.trim() ? row.summary : "No events summarized yet.";
		
		const rawMessages: RawMessage[] = JSON.parse(row.raw_messages || "[]");
		let rawText = "";
		if (rawMessages.length > 0) {
			rawText = "\n\n### Unsummarized Recent Activity\n" + 
				rawMessages.map(m => `- [${m.source}] ${m.role}: ${m.content.substring(0, 100).replace(/\\n/g, " ")}...`).join("\n");
		}
		
		return `### Global Daily Summary (${this.activeDate})\n${summary}${rawText}`;
	}
	
	async dumpAndClear(targetDate: string): Promise<string | null> {
		const rows = await this.db.all<{ summary: string, raw_messages: string }>(
			"SELECT * FROM global_daily_memory WHERE date_id = ?", [targetDate]
		);
		
		if (rows.length === 0) return null;
		
		const summary = rows[0].summary;
		const finalDump = `Daily Episode for ${targetDate}:\n${summary}`;
		
		await this.db.run("DELETE FROM global_daily_memory WHERE date_id = ?", [targetDate]);
		
		logger.info(`Dumped and cleared daily memory for ${targetDate}`);
		return finalDump;
	}
	async getMessageCount(): Promise<number> {
		await this.initialize();
		await this.ensureTodayRow();
		const rows = await this.db.all<{ raw_messages: string }>(
			"SELECT raw_messages FROM global_daily_memory WHERE date_id = ?",
			[this.activeDate],
		);
		if (rows.length === 0) return 0;
		const raw: unknown[] = JSON.parse(rows[0].raw_messages || "[]");
		return raw.length;
	}

	async getStructuredData(): Promise<{ summary: string; rawMessages: RawMessage[] }> {
		await this.initialize();
		await this.ensureTodayRow();
		const rows = await this.db.all<{ summary: string; raw_messages: string }>(
			"SELECT * FROM global_daily_memory WHERE date_id = ?",
			[this.activeDate],
		);
		if (rows.length === 0) return { summary: "", rawMessages: [] };
		return {
			summary: rows[0].summary,
			rawMessages: JSON.parse(rows[0].raw_messages || "[]")
		};
	}
}
