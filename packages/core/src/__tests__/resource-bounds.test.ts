import { describe, expect, it } from "vitest";
import { EventStream } from "../agent/event-stream.js";
import { ShortTermMemory } from "../memory/stm.js";

describe("resource bounds", () => {
	it("caps retained agent events", () => {
		const stream = new EventStream(3);
		for (let index = 0; index < 10; index++) {
			stream.append({ type: "progress", runId: "run", data: { index } });
		}
		const retained = stream.query({ runId: "run" });
		expect(retained).toHaveLength(3);
		expect(retained.map((event) => event.data.index)).toEqual([7, 8, 9]);
	});

	it("discards stale async STM condensation after clear", async () => {
		let resolveSummary!: (summary: string) => void;
		const summary = new Promise<string>((resolve) => {
			resolveSummary = resolve;
		});
		const stm = new ShortTermMemory({
			maxTokens: 2,
			scratchPadSize: 2,
			autoEviction: true,
			tokenCounter: {
				countTokens: (text) => text.length,
				countMessagesTokens: (messages) => messages.reduce((sum, item) => sum + item.content.length, 0),
			},
		});
		stm.setCondensationCallback(() => summary);
		stm.add({ role: "user", content: "long request" });
		stm.add({ role: "assistant", content: "long answer" });
		stm.clear();
		resolveSummary("stale summary");
		await summary;
		await Promise.resolve();
		expect(stm.getContext()).toEqual([]);
	});
});
