import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type BrowserConfig, BrowserTool } from "./browser.js";
import type { ToolContext, ToolDefinition } from "./registry.js";

interface BrowserSessionRecord {
	browser: BrowserTool;
	tools: Map<string, ToolDefinition>;
}

/** Routes native browser tools to an isolated BrowserTool for each parallel worker. */
export class BrowserSessionPool {
	private defaultSession: BrowserSessionRecord;
	private workerSessions = new Map<string, BrowserSessionRecord>();

	constructor(
		private config: BrowserConfig,
		private readonly browserFactory: (config: BrowserConfig) => BrowserTool = (
			config,
		) => new BrowserTool(config),
	) {
		this.defaultSession = this.createRecord(config);
	}

	createTools(): ToolDefinition[] {
		return Array.from(this.defaultSession.tools.values()).map((template) => ({
			...template,
			metadata: {
				...(template.metadata ?? {}),
				statefulBrowser: true,
				workerIsolated: true,
			},
			handler: async (params, context) => {
				const record = this.getSession(context);
				const tool = record.tools.get(template.name);
				if (!tool) {
					return {
						success: false,
						output: "",
						error: `Browser tool not found in isolated session: ${template.name}`,
						errorCode: "TOOL_NOT_FOUND",
					};
				}
				return tool.handler(params, context);
			},
		}));
	}

	async updateConfig(config: BrowserConfig): Promise<void> {
		await this.closeAll();
		this.config = config;
		this.defaultSession = this.createRecord(config);
	}

	async releaseWorker(workerId: string): Promise<void> {
		const matching = Array.from(this.workerSessions.entries()).filter(([key]) =>
			key.endsWith(`:${workerId}`),
		);
		await Promise.all(
			matching.map(async ([key, record]) => {
				this.workerSessions.delete(key);
				await record.browser.close();
			}),
		);
	}

	async closeAll(): Promise<void> {
		const sessions = [
			this.defaultSession,
			...Array.from(this.workerSessions.values()),
		];
		this.workerSessions.clear();
		await Promise.all(sessions.map((session) => session.browser.close()));
	}

	private getSession(context: ToolContext): BrowserSessionRecord {
		const workerId = context.agent?.workerId;
		if (!workerId) return this.defaultSession;
		const key = `${context.agent?.runId ?? "run"}:${workerId}`;
		const existing = this.workerSessions.get(key);
		if (existing) return existing;

		const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
		const profileRoot = resolve(
			this.config.userDataDir ?? join(homedir(), ".octopus", "browser-profile"),
		);
		const sessionRoot = resolve(
			this.config.sessionStorageDir ??
				join(homedir(), ".octopus", "browser-sessions"),
		);
		const record = this.createRecord({
			...this.config,
			isolatedSession: true,
			persistCookies: false,
			userDataDir: join(profileRoot, "workers", hash),
			sessionStorageDir: join(sessionRoot, "workers", hash),
		});
		this.workerSessions.set(key, record);
		return record;
	}

	private createRecord(config: BrowserConfig): BrowserSessionRecord {
		const browser = this.browserFactory(config);
		return {
			browser,
			tools: new Map(browser.createTools().map((tool) => [tool.name, tool])),
		};
	}
}
