import { describe, expect, it, vi } from "vitest";
import { BrowserSessionPool } from "../tools/browser-session-pool.js";
import type { BrowserConfig } from "../tools/browser.js";
import type { ToolContext, ToolDefinition } from "../tools/registry.js";

describe("BrowserSessionPool", () => {
	it("routes parallel workers to independent browsers and releases them", async () => {
		const instances: Array<{
			config: BrowserConfig;
			close: ReturnType<typeof vi.fn>;
		}> = [];
		const pool = new BrowserSessionPool(
			{ provider: "embedded", userDataDir: "C:/tmp/octopus-browser-test" },
			(config) => {
				const instance = { config, close: vi.fn(async () => undefined) };
				instances.push(instance);
				return {
					close: instance.close,
					createTools: () => [
						{
							name: "browser_navigate",
							description: "navigate",
							parameters: {},
							handler: async () => ({
								success: true,
								output: config.userDataDir ?? "default",
							}),
						} satisfies ToolDefinition,
					],
				} as never;
			},
		);
		const navigate = pool
			.createTools()
			.find((tool) => tool.name === "browser_navigate");
		expect(navigate).toBeDefined();
		if (!navigate) throw new Error("browser_navigate wrapper missing");
		const context = (workerId: string): ToolContext =>
			({ agent: { workerId, runId: "run-1" } }) as ToolContext;

		const [first, second] = await Promise.all([
			navigate.handler({}, context("worker-a")),
			navigate.handler({}, context("worker-b")),
		]);

		expect(first.output).not.toBe(second.output);
		expect(instances).toHaveLength(3); // default + two isolated workers
		expect(instances[1]?.config.isolatedSession).toBe(true);
		expect(instances[2]?.config.persistCookies).toBe(false);

		await pool.releaseWorker("worker-a");
		expect(instances[1]?.close).toHaveBeenCalledOnce();
		expect(instances[2]?.close).not.toHaveBeenCalled();
		await pool.closeAll();
		expect(instances[0]?.close).toHaveBeenCalledOnce();
		expect(instances[2]?.close).toHaveBeenCalledOnce();
	});
});
