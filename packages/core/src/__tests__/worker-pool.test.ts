import { describe, expect, it, vi } from "vitest";
import type { LLMRequest } from "../ai/types.js";
import { EventStream } from "../agent/event-stream.js";
import { WorkerPool } from "../agent/worker-pool.js";
import { ToolExecutor } from "../tools/executor.js";
import { ToolRegistry } from "../tools/registry.js";

describe("WorkerPool", () => {
	it("does not expose delegate_task to delegated workers", async () => {
		const chat = vi.fn(async () => ({ content: "Worker finished." }));
		const registry = new ToolRegistry();
		registry.register({
			name: "delegate_task",
			description: "Delegates to another worker",
			parameters: {},
			handler: vi.fn(),
		});
		registry.register({
			name: "read_file",
			description: "Reads a file",
			parameters: {},
			handler: vi.fn(),
		});
		const pool = new WorkerPool(
			{ chat } as never,
			registry,
			new ToolExecutor(registry, { sandboxCommands: false, allowedPaths: [] }),
			new EventStream(),
			{
				id: "agent-1",
				name: "Agent",
				description: "test",
				systemPrompt: "test",
				model: "test-model",
			},
			2,
		);

		await pool.executeWorker(
			{
				id: "task_1",
				description: "Do the assigned work",
				role: "qa",
				toolScope: [],
				priority: 1,
				status: "pending",
			},
			{ maxToolIterations: 1, timeoutMs: 10_000 },
		);

		const request = chat.mock.calls[0]?.[0] as LLMRequest;
		const toolNames = request.tools?.map((tool) => tool.function.name) ?? [];
		expect(toolNames).toContain("read_file");
		expect(toolNames).not.toContain("delegate_task");
		expect(String(request.messages[0]?.content)).not.toContain(
			"Delegates to another worker",
		);
	});

	it("uses a live arm AgentRuntime when a routed task has a registered agent runtime", async () => {
		const chat = vi.fn(async () => {
			throw new Error("direct worker loop should not run");
		});
		const registry = new ToolRegistry();
		const eventStream = new EventStream();
		const armRuntime = {
			processMessageStream: vi.fn(async function* (_message, _channelId, _options) {
				yield "runtime result";
			}),
		};
		const getAgentRuntime = vi.fn((agentId: string) =>
			agentId === "arm-ari" ? armRuntime : undefined,
		);
		const pool = new WorkerPool(
			{ chat } as never,
			registry,
			new ToolExecutor(registry, { sandboxCommands: false, allowedPaths: [] }),
			eventStream,
			{
				id: "default-agent",
				name: "Octavio",
				description: "root",
				systemPrompt: "root",
				model: "test-model",
			},
			2,
			{ getAgentRuntime },
		);

		const result = await pool.executeWorker(
			{
				id: "task_1",
				description: "Fix the routed code task",
				role: "engineer",
				agentId: "arm-ari",
				agentName: "Ari",
				armKey: "ari",
				avatar: "/mascotas/Arana_ari.png",
				color: "#7C5CFF",
				toolScope: [],
				priority: 1,
				status: "pending",
			},
			{ channelId: "conversation-1", maxToolIterations: 1, timeoutMs: 10_000 },
		);

		expect(getAgentRuntime).toHaveBeenCalledWith("arm-ari");
		expect(armRuntime.processMessageStream).toHaveBeenCalledWith(
			expect.stringContaining("Subtarea asignada por Octavio"),
			"conversation-1",
			expect.objectContaining({
				signal: expect.any(AbortSignal),
				disableOrchestrator: true,
				disableDelegation: true,
			}),
		);
		expect(chat).not.toHaveBeenCalled();
		expect(result).toBe("runtime result");
		expect(
			eventStream.query({ taskId: "task_1" }).some((event) =>
				Boolean(event.data.metadata?.liveAgentRuntime),
			),
		).toBe(true);
	});
});
