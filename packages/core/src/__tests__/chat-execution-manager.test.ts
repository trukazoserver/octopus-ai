import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatExecutionManager } from "../chat/execution-manager.js";
import { ChatManager } from "../chat/manager.js";
import {
	type DatabaseAdapter,
	createDatabaseAdapter,
} from "../storage/database.js";

describe("ChatExecutionManager", () => {
	let db: DatabaseAdapter;
	let chatManager: ChatManager;

	beforeEach(async () => {
		db = createDatabaseAdapter("sqlite", { path: ":memory:" });
		await db.initialize();
		chatManager = new ChatManager(db);
	});

	afterEach(async () => {
		await db.close();
	});

	it("persists assistant checkpoints and emits reconnect-safe stream payloads", async () => {
		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const events: Array<{ type: string; payload: Record<string, unknown> }> =
			[];
		const runtime = {
			stm: { clear: vi.fn(), add: vi.fn() },
			processMessageStream: async function* () {
				yield "Hola";
				yield " mundo";
			},
			runConsolidation: vi.fn(async () => undefined),
		};
		const manager = new ChatExecutionManager({
			chatManager,
			conversationHistoryLimit: 20,
			streamCheckpointIntervalMs: 0,
			getAgentRuntime: () => runtime as never,
			emit: (event) => {
				events.push({ type: event.type, payload: event.payload });
				if (event.type === "stream_end") resolveDone();
			},
		});

		const execution = await manager.start({ message: "saluda", stream: true });
		await done;

		const updatedExecution = await chatManager.getExecution(execution.id);
		expect(updatedExecution?.status).toBe("completed");
		expect(updatedExecution?.assistant_message_id).toBeTruthy();

		const assistant = await chatManager.getMessage(
			updatedExecution?.assistant_message_id ?? "",
		);
		expect(assistant?.content).toBe("Hola mundo");
		expect(JSON.parse(assistant?.metadata ?? "{}")).toMatchObject({
			status: "completed",
			partial: false,
			source: "stream",
			executionId: execution.id,
		});

		const streamEvents = events.filter((event) => event.type === "stream");
		expect(streamEvents).toHaveLength(2);
		expect(streamEvents[0]?.payload).toMatchObject({
			content: "Hola",
			fullContent: "Hola",
			executionId: execution.id,
			assistantMessageId: updatedExecution?.assistant_message_id,
		});
		expect(streamEvents[1]?.payload).toMatchObject({
			content: " mundo",
			fullContent: "Hola mundo",
			executionId: execution.id,
			assistantMessageId: updatedExecution?.assistant_message_id,
		});
		expect(events.at(-1)?.payload).toMatchObject({
			done: true,
			executionId: execution.id,
			assistantMessageId: updatedExecution?.assistant_message_id,
		});
	});

	it("executes the selected agent's runtime and passes its context to processMessageStream", async () => {
		// Per-agent model/reasoning: when an agentId is selected, the execution
		// runs on THAT agent's own runtime (getAgentRuntime(agentId)) so its
		// model/reasoning profile takes effect, while its persona is still
		// injected as selectedAgentContext.
		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const selectedAgentContext = {
			id: "arm-bibi",
			name: "Bibi",
			role: "planner",
			systemPrompt: "Planifica como Bibi.",
		};
		const processMessageStream = vi.fn(async function* (
			_message: string,
			_channelId?: string,
			_options?: unknown,
		) {
			yield "root response";
		});
		const rootRuntime = {
			stm: { clear: vi.fn(), add: vi.fn() },
			processMessageStream,
			runConsolidation: vi.fn(async () => undefined),
		};
		const getAgentRuntime = vi.fn(() => rootRuntime as never);
		const manager = new ChatExecutionManager({
			chatManager,
			conversationHistoryLimit: 20,
			streamCheckpointIntervalMs: 0,
			getAgentRuntime,
			getSelectedAgentContext: vi.fn(async () => selectedAgentContext),
			emit: (event) => {
				if (event.type === "stream_end") resolveDone();
			},
		});

		await manager.start({
			message: "coordina",
			agentId: "arm-bibi",
			stream: true,
		});
		await done;

		expect(getAgentRuntime).toHaveBeenCalledWith(
			"arm-bibi",
			expect.any(String),
		);
		expect(processMessageStream).toHaveBeenCalledWith(
			"coordina",
			expect.any(String),
			expect.objectContaining({ selectedAgentContext }),
		);
		const conversations = await chatManager.listConversations({ limit: 10 });
		expect(conversations[0]?.agent_id).toBe("arm-bibi");
	});

	it("enables completed-action reuse only for an explicit continuation", async () => {
		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const processMessageStream = vi.fn(async function* () {
			yield "continuado";
		});
		const runtime = {
			stm: { clear: vi.fn(), add: vi.fn() },
			processMessageStream,
			runConsolidation: vi.fn(async () => undefined),
		};
		const manager = new ChatExecutionManager({
			chatManager,
			conversationHistoryLimit: 20,
			streamCheckpointIntervalMs: 0,
			getAgentRuntime: () => runtime as never,
			emit: (event) => {
				if (event.type === "stream_end") resolveDone();
			},
		});

		const execution = await manager.start({
			message: "continúa",
			stream: true,
		});
		await done;

		expect(processMessageStream).toHaveBeenCalledWith(
			"continúa",
			expect.any(String),
			expect.objectContaining({
				executionId: execution.id,
				resumeCompletedActions: true,
			}),
		);
	});

	it("persists a pending runtime outcome as interrupted instead of completed", async () => {
		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const events: Array<{ type: string; payload: Record<string, unknown> }> =
			[];
		const runtime = {
			stm: { clear: vi.fn(), add: vi.fn() },
			processMessageStream: async function* (
				_message: string,
				_channelId: string,
				options: {
					onCompletionOutcome?: (outcome: Record<string, unknown>) => void;
				},
			) {
				yield "Queda una acción pendiente.";
				options.onCompletionOutcome?.({
					reason: "pending_action",
					pendingAction: {
						kind: "continue",
						summary: "Descargar la música",
						resumable: true,
					},
				});
			},
			runConsolidation: vi.fn(async () => undefined),
		};
		const manager = new ChatExecutionManager({
			chatManager,
			conversationHistoryLimit: 20,
			streamCheckpointIntervalMs: 0,
			getAgentRuntime: () => runtime as never,
			emit: (event) => {
				events.push({ type: event.type, payload: event.payload });
				if (event.type === "stream_end") resolveDone();
			},
		});

		const execution = await manager.start({
			message: "continúa",
			stream: true,
		});
		await done;

		const saved = await chatManager.getExecution(execution.id);
		expect(saved?.status).toBe("interrupted");
		expect(saved?.completion_reason).toBe("pending_action");
		expect(JSON.parse(saved?.pending_action ?? "{}")).toMatchObject({
			kind: "continue",
			resumable: true,
		});
		expect(events.at(-1)?.payload).toMatchObject({
			status: "interrupted",
			completionReason: "pending_action",
		});
	});
});
