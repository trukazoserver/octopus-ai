import { describe, expect, it } from "vitest";
import {
	encodeStatusField,
	orchestratorEventToStatusStrings,
} from "../agent/orchestrator-status.js";
import type { OrchestratorEvent } from "../agent/orchestrator.js";

// Minimal valid events for each variant. The shared helper must produce STATUS
// strings identical to what the runtime's auto-gate path emitted, so the UI
// renders the same regardless of which path (auto-gate vs orchestrate_parallel
// tool) produced the events.
const decompositionEvent: OrchestratorEvent = {
	type: "decomposition",
	data: {
		originalGoal: "g",
		subtasks: [
			{
				id: "s1",
				description: "d",
				role: "researcher",
				toolScope: [],
				priority: 1,
				status: "pending",
			},
		],
		executionPlan: "parallel",
		reasoning: "r",
	},
};

describe("orchestratorEventToStatusStrings", () => {
	it("encodes decomposition as orchestrating:multiagent", () => {
		const out = orchestratorEventToStatusStrings(decompositionEvent);
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("STATUS:orchestrating:multiagent::");
		expect(out[0]?.startsWith("\x00")).toBe(true);
		expect(out[0]?.endsWith("\x00")).toBe(true);
	});

	it("encodes worker_started/progress/done/error with the worker id segment", () => {
		const started: OrchestratorEvent = {
			type: "worker_started",
			workerId: "w1",
			taskId: "t1",
			description: "d",
		};
		const progress: OrchestratorEvent = {
			type: "worker_progress",
			workerId: "w1",
			taskId: "t1",
			message: "m",
			progress: 50,
		};
		const done: OrchestratorEvent = {
			type: "worker_done",
			workerId: "w1",
			taskId: "t1",
			result: "r",
		};
		const error: OrchestratorEvent = {
			type: "worker_error",
			workerId: "w1",
			taskId: "t1",
			error: "e",
		};
		for (const ev of [started, progress, done, error]) {
			const out = orchestratorEventToStatusStrings(ev);
			expect(out).toHaveLength(1);
			expect(out[0]).toContain(
				`STATUS:${ev.type === "worker_started" ? "worker_start" : ev.type === "worker_progress" ? "worker_progress" : ev.type === "worker_done" ? "worker_done" : "worker_error"}:w1::`,
			);
		}
	});

	it("encodes replan as orchestrating:replan", () => {
		const out = orchestratorEventToStatusStrings({
			type: "replan",
			data: {
				pass: 1,
				failedTaskIds: ["t1"],
				replacementTaskIds: ["r1"],
				reason: "failed",
			},
		});
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("STATUS:orchestrating:replan::");
		expect(out[0]?.startsWith("\x00")).toBe(true);
		expect(out[0]?.endsWith("\x00")).toBe(true);
	});

	it("encodes telemetry as orchestrating:telemetry", () => {
		const out = orchestratorEventToStatusStrings({
			type: "telemetry",
			data: {
				runId: "r",
				totalMs: 1,
				executionMs: 1,
				synthesisMs: 1,
				workerCount: 1,
				succeeded: 1,
				failed: 0,
				cancelled: 0,
			},
		});
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("STATUS:orchestrating:telemetry::");
		expect(out[0]?.startsWith("\x00")).toBe(true);
		expect(out[0]?.endsWith("\x00")).toBe(true);
	});

	it("returns [] for synthesis (caller captures it) and review/verification events", () => {
		const synthesis: OrchestratorEvent = {
			type: "synthesis",
			result: "x",
		};
		expect(orchestratorEventToStatusStrings(synthesis)).toEqual([]);
	});

	it("encodeStatusField is standard base64", () => {
		expect(encodeStatusField("hello")).toBe(
			Buffer.from("hello", "utf8").toString("base64"),
		);
	});
});
