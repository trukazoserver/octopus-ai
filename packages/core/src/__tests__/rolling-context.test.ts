import { describe, expect, it, vi } from "vitest";
import { RollingContextManager } from "../agent/rolling-context.js";

describe("RollingContextManager", () => {
	it("injects a hydrated persisted summary before recent messages", async () => {
		const manager = new RollingContextManager({ chat: vi.fn() } as never);
		manager.setSummary("[Results] 14 clips generated; clip 15 pending.");

		const messages = await manager.maybeSummarize(
			[
				{ role: "system", content: "System prompt" },
				{ role: "user", content: "continua" },
			],
			"default",
		);

		expect(messages.map((message) => message.role)).toEqual([
			"system",
			"system",
			"user",
		]);
		expect(messages[1]?.content).toContain("14 clips generated");
	});
});
