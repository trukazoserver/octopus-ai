import { describe, expect, it } from "vitest";
import {
	ToolHealthManager,
	type ToolHealthMcpCaller,
} from "../tools/tool-health-manager.js";
import type { DatabaseAdapter } from "../storage/database.js";

/** Minimal in-memory DB that emulates the tool_health upsert + select. */
function createMockDb(): DatabaseAdapter {
	const rows = new Map<
		string,
		{
			server: string;
			status: string;
			detail: string;
			checked_at: string;
			cache_until: string;
			consecutive_failures: number;
		}
	>();
	const db: DatabaseAdapter = {
		initialize: async () => {},
		close: async () => {},
		transaction: async <T>(fn: () => Promise<T>) => fn(),
		run: async (sql: string, params: unknown[] = []) => {
			if (/insert into tool_health/i.test(sql)) {
				const [
					server,
					status,
					detail,
					checked_at,
					cache_until,
					consecutive_failures,
				] = params as [string, string, string, string, string, number];
				rows.set(server, {
					server,
					status,
					detail: detail ?? "",
					checked_at: checked_at ?? null,
					cache_until: cache_until ?? null,
					consecutive_failures: consecutive_failures ?? 0,
				});
			}
		},
		get: async () => undefined,
		all: async () => Array.from(rows.values()),
	};
	return db;
}

function createMcp(overrides: Partial<ToolHealthMcpCaller> = {}): ToolHealthMcpCaller {
	return {
		callTool: async () => ({ content: [{ text: "ok" }] }),
		findServerForTool: (name: string) =>
			name === "web_search"
				? "zai-web-search"
				: name === "webReader"
					? "zai-web-reader"
					: undefined,
		getServer: () => ({ status: "connected" }),
		...overrides,
	};
}

function makeManager(mcp: ToolHealthMcpCaller): ToolHealthManager {
	return new ToolHealthManager(createMockDb(), mcp, {
		enabled: true,
		cacheTtlMinutes: 360,
		breaker: { consecutiveFailures: 3, windowMinutes: 10 },
	});
}

describe("ToolHealthManager", () => {
	it("classifies a successful canary call as ok", async () => {
		const mcp = createMcp();
		const mgr = makeManager(mcp);
		await mgr.runProbe();
		await expect(mgr.getStatus("web_search")).resolves.toMatchObject({
			status: "ok",
		});
	});

	it("classifies a quota/billing error as no_quota", async () => {
		const mcp = createMcp({
			callTool: async () => {
				throw new Error("403 Forbidden: quota exceeded");
			},
		});
		const mgr = makeManager(mcp);
		await mgr.runProbe();
		const status = await mgr.getStatus("web_search");
		expect(status?.status).toBe("no_quota");
	});

	it("classifies the real Z.ai limit-exhaustion error as no_quota", async () => {
		const mcp = createMcp({
			callTool: async () => {
				throw new Error(
					'MCP error -429: {"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-07-06 22:45:39"}}',
				);
			},
		});
		const mgr = makeManager(mcp);
		await mgr.runProbe();
		const search = await mgr.getStatus("web_search");
		const reader = await mgr.getStatus("webReader");
		expect(search?.status).toBe("no_quota");
		expect(reader?.status).toBe("no_quota");
		const summary = await mgr.getHealthSummary();
		expect(summary).toContain("browser_search");
	});

	it("treats a non-auth validation error as ok (auth worked)", async () => {
		const mcp = createMcp({
			callTool: async () => {
				throw new Error("missing required parameter: search_query");
			},
		});
		const mgr = makeManager(mcp);
		await mgr.runProbe();
		const status = await mgr.getStatus("web_search");
		// Authenticated endpoint, just bad params → quota is effectively fine.
		expect(status?.status).toBe("ok");
	});

	it("reports no_quota servers in the health summary", async () => {
		const mcp = createMcp({
			callTool: async () => {
				throw new Error("billing: insufficient credit");
			},
		});
		const mgr = makeManager(mcp);
		await mgr.runProbe();
		const summary = await mgr.getHealthSummary();
		expect(summary).toContain("zai-web-search");
		expect(summary).toContain("browser_search");
		expect(summary).toContain("zai-web-reader");
	});

	it("does not report healthy tools in the summary", async () => {
		const mgr = makeManager(createMcp());
		await mgr.runProbe();
		const summary = await mgr.getHealthSummary();
		expect(summary).toBe("");
	});

	it("opens the circuit breaker after N consecutive failures", async () => {
		const mgr = makeManager(createMcp());
		expect(mgr.isCircuitOpen("web_search")).toBeNull();
		mgr.recordOutcome("web_search", false, "err1");
		mgr.recordOutcome("web_search", false, "err2");
		expect(mgr.isCircuitOpen("web_search")?.open).toBe(false);
		mgr.recordOutcome("web_search", false, "err3");
		expect(mgr.isCircuitOpen("web_search")?.open).toBe(true);
	});

	it("resets the breaker on success and ignores non-web tools", async () => {
		const mgr = makeManager(createMcp());
		mgr.recordOutcome("web_search", false, "err");
		mgr.recordOutcome("web_search", true);
		expect(mgr.isCircuitOpen("web_search")).toBeNull();
		// A failure on an unrelated tool is not tracked.
		mgr.recordOutcome("read_file", false, "err");
		expect(mgr.isCircuitOpen("read_file")).toBeNull();
	});

	it("returns null status for non-web tools", async () => {
		const mgr = makeManager(createMcp());
		await mgr.runProbe();
		await expect(mgr.getStatus("shell")).resolves.toBeNull();
	});
});
