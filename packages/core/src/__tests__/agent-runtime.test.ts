import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	AgentRuntime,
	requiresExternalVisionToolForModel,
	requiresZaiVisionToolForModel,
} from "../agent/runtime.js";
import type {
	AgentConfig,
	ConversationTurn,
	TaskState,
} from "../agent/types.js";
import type { LLMChunk, LLMResponse } from "../ai/types.js";
import type {
	ConsolidationResult,
	ContextAssemblyResult,
	MemoryContext,
} from "../memory/types.js";
import type { LoadedSkill } from "../skills/types.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolRegistry, ToolResult } from "../tools/registry.js";
import type { SkillResearcher } from "../skills/researcher.js";

function createMockLLMRouter(responseOverrides?: Partial<LLMResponse>) {
	const defaultResponse: LLMResponse = {
		content: "Hello from assistant",
		model: "test-model",
		usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
		finishReason: "stop",
		...responseOverrides,
	};
	return {
		chat: vi.fn().mockResolvedValue(defaultResponse),
		chatStream: vi.fn().mockImplementation(async function* () {
			const chunk: LLMChunk = { content: "streamed " };
			yield chunk;
		}),
		getAvailableProviders: vi.fn().mockReturnValue(["test-provider"]),
		supportsVisionForModel: vi.fn().mockReturnValue(true),
	};
}

function createMockSTM() {
	const turns: ConversationTurn[] = [];
	let activeTask: TaskState | null = null;
	return {
		add: vi.fn((turn: ConversationTurn) => turns.push(turn)),
		getContext: vi.fn(() => [...turns]),
		getRelevant: vi.fn(() => [...turns]),
		getLoad: vi.fn(() => 10),
		getActiveTask: vi.fn(() => activeTask),
		setActiveTask: vi.fn((task: TaskState) => {
			activeTask = task;
		}),
		setScratchPad: vi.fn(),
		getScratchPad: vi.fn(),
		clear: vi.fn(() => {
			turns.length = 0;
			activeTask = null;
		}),
		getTokenCount: vi.fn(() => 50),
	};
}

function createMockMemoryRetrieval(contextOverrides?: Partial<MemoryContext>): {
	retrieveForContext: ReturnType<typeof vi.fn>;
} {
	const defaultContext: MemoryContext = {
		memories: [],
		totalTokens: 0,
		fromSTM: [],
		combined: [],
		...contextOverrides,
	};
	return {
		retrieveForContext: vi.fn().mockResolvedValue(defaultContext),
	};
}

function createMockConsolidator(result?: Partial<ConsolidationResult>) {
	const defaultResult: ConsolidationResult = {
		stored: 0,
		updated: 0,
		compressed: 0,
		forgotten: 0,
		associations: 0,
		...result,
	};
	return {
		consolidate: vi.fn().mockResolvedValue(defaultResult),
	};
}

function createMockSkillLoader(skills: LoadedSkill[] = []) {
	return {
		resolveSkillsForTask: vi.fn().mockResolvedValue(skills),
	};
}

function createMockLearningEngine() {
	return {
		retrieveRelevant: vi.fn().mockResolvedValue([
			{
				id: "learn-1",
				experienceId: "exp-1",
				type: "procedure",
				keywords: ["review", "code"],
				content: "Run type checks after code edits.",
				confidence: 0.9,
				importance: 0.8,
				embedding: [],
				useCount: 0,
				createdAt: new Date(),
			},
		]),
		recordExperience: vi.fn().mockResolvedValue({ id: "exp-1" }),
	};
}

function createMockToolRegistry(
	tools: { name: string; description: string }[] = [],
) {
	const toolMap = new Map(tools.map((t) => [t.name, t]));
	return {
		register: vi.fn(),
		unregister: vi.fn(),
		get: vi.fn((name: string) => toolMap.get(name)),
		list: vi.fn(() =>
			tools.map((t) => ({ ...t, parameters: {}, handler: vi.fn() })),
		),
		has: vi.fn((name: string) => toolMap.has(name)),
		toLLMTools: vi.fn(() =>
			tools.map((t) => ({
				type: "function" as const,
				function: {
					name: t.name,
					description: t.description,
					parameters: { type: "object", properties: {}, required: [] },
				},
			})),
		),
	};
}

function createMockToolExecutor() {
	return {
		execute: vi.fn().mockResolvedValue({
			success: true,
			output: "tool result",
		} satisfies ToolResult),
	};
}

const baseConfig: AgentConfig = {
	id: "test-agent",
	name: "Test Agent",
	description: "A test agent",
	systemPrompt: "You are a helpful test assistant.",
};

describe("AgentRuntime", () => {
	let runtime: AgentRuntime;
	let mockLLMRouter: ReturnType<typeof createMockLLMRouter>;
	let mockSTM: ReturnType<typeof createMockSTM>;
	let mockMemoryRetrieval: ReturnType<typeof createMockMemoryRetrieval>;
	let mockConsolidator: ReturnType<typeof createMockConsolidator>;
	let mockSkillLoader: ReturnType<typeof createMockSkillLoader>;

	beforeEach(() => {
		mockLLMRouter = createMockLLMRouter();
		mockSTM = createMockSTM();
		mockMemoryRetrieval = createMockMemoryRetrieval();
		mockConsolidator = createMockConsolidator();
		mockSkillLoader = createMockSkillLoader();

		runtime = new AgentRuntime(
			baseConfig,
			mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
			mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
			mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
			mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
			mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
		);
	});

	describe("constructor", () => {
		it("should instantiate with valid config and dependencies", () => {
			expect(runtime).toBeInstanceOf(AgentRuntime);
		});
	});

	describe("initialize", () => {
		it("should succeed with a valid config", async () => {
			await expect(runtime.initialize()).resolves.toBeUndefined();
		});

		it("should throw if config.id is missing", async () => {
			const badConfig = { ...baseConfig, id: "" };
			const rt = new AgentRuntime(
				badConfig,
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);
			await expect(rt.initialize()).rejects.toThrow(
				"Agent config must have an id",
			);
		});

		it("should throw if config.name is missing", async () => {
			const badConfig = { ...baseConfig, name: "" };
			const rt = new AgentRuntime(
				badConfig,
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);
			await expect(rt.initialize()).rejects.toThrow(
				"Agent config must have a name",
			);
		});

		it("should throw if config.systemPrompt is missing", async () => {
			const badConfig = { ...baseConfig, systemPrompt: "" };
			const rt = new AgentRuntime(
				badConfig,
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);
			await expect(rt.initialize()).rejects.toThrow(
				"Agent config must have a systemPrompt",
			);
		});
	});

	describe("setToolSystem", () => {
		it("should register tool registry and executor", async () => {
			const mockRegistry = createMockToolRegistry([
				{ name: "test-tool", description: "A test tool" },
			]);
			const mockExecutor = createMockToolExecutor();

			runtime.setToolSystem(
				mockRegistry as unknown as ToolRegistry,
				mockExecutor as unknown as ToolExecutor,
			);

			const result = await runtime.processMessage("use the tool");
			expect(result).toBe("Hello from assistant");
			expect(mockRegistry.toLLMTools).toHaveBeenCalled();
		});
	});

	describe("processMessage", () => {
		it("should return a string response", async () => {
			const result = await runtime.processMessage("Hello");
			expect(typeof result).toBe("string");
			expect(result).toBe("Hello from assistant");
		});

		it("should not expose internal Z.AI vision requirements in final text", async () => {
			mockLLMRouter.chat.mockResolvedValueOnce({
				content:
					'Cambios aplicados.\n\n[ZAI VISION REQUIRED] This image must be inspected with an available Z.AI Vision MCP tool because the active model is Z.ai GLM. Use one of these local media paths ("C:\\tmp\\image.png") before answering.',
				model: "test-model",
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
				finishReason: "stop",
			});

			const result = await runtime.processMessage("describe generated image");

			expect(result).toBe("Cambios aplicados.");
			expect(result).not.toContain("ZAI VISION REQUIRED");
			const assistantTurn = mockSTM.add.mock.calls.find(
				([turn]) => turn.role === "assistant",
			)?.[0];
			expect(assistantTurn?.content).toBe("Cambios aplicados.");
		});

		it("does not inline the Z.AI vision directive into context (system-prompt driven)", async () => {
			const glmRuntime = new AgentRuntime(
				{ ...baseConfig, model: "zai/glm-5.2" },
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);
			const mediaMarkdown =
				"Describe this picture: ![Image](/api/media/file/test-image.png)";
			await glmRuntime.processMessage(mediaMarkdown);

			const request = mockLLMRouter.chat.mock.calls.at(-1)?.[0];
			expect(request).toBeTruthy();
			const userMessages = request.messages.filter(
				(m) =>
					m.role === "user" &&
					typeof m.content === "string" &&
					m.content.includes(mediaMarkdown),
			);
			expect(userMessages.length).toBeGreaterThan(0);
			expect(userMessages[0].content).toContain(
				"/api/media/file/test-image.png",
			);
			expect(userMessages[0].content).not.toContain("[ZAI VISION REQUIRED]");
			expect(userMessages[0].content).not.toContain("must be inspected");
		});

		it("should add user and assistant turns to STM", async () => {
			await runtime.processMessage("Hello");
			expect(mockSTM.add).toHaveBeenCalledTimes(2);

			const userCall = mockSTM.add.mock.calls[0]?.[0] as ConversationTurn;
			expect(userCall.role).toBe("user");
			expect(userCall.content).toBe("Hello");

			const assistantCall = mockSTM.add.mock.calls[1]?.[0] as ConversationTurn;
			expect(assistantCall.role).toBe("assistant");
			expect(assistantCall.content).toBe("Hello from assistant");
		});

		it("should pass channelId via metadata when provided", async () => {
			await runtime.processMessage("Hello", "channel-123");
			const userCall = mockSTM.add.mock.calls[0]?.[0] as ConversationTurn;
			expect(userCall.metadata).toEqual({ conversationId: "channel-123" });
		});

		it("should call LLM router chat with context messages", async () => {
			await runtime.processMessage("What is 2+2?");
			expect(mockLLMRouter.chat).toHaveBeenCalledTimes(1);
			const request = mockLLMRouter.chat.mock.calls[0]?.[0];
			expect(request.messages.length).toBeGreaterThan(0);
			expect(request.messages[0]?.role).toBe("system");
			expect(request.messages[0]?.content).toContain(
				"You are a helpful test assistant.",
			);
		});

		it("should include recent raw STM turns even when retrieved STM is sparse", async () => {
			const sparseTurn: ConversationTurn = {
				role: "user",
				content: "sparse retrieved turn",
				timestamp: new Date("2026-01-01T00:00:00.000Z"),
				metadata: { conversationId: "conv-raw" },
			};
			mockMemoryRetrieval = createMockMemoryRetrieval({
				fromSTM: [sparseTurn],
			});
			runtime = new AgentRuntime(
				baseConfig,
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);

			const baseTime = new Date("2026-01-02T00:00:00.000Z");
			for (let i = 0; i < 80; i++) {
				mockSTM.add({
					role: i % 2 === 0 ? "user" : "assistant",
					content: `full-stm-${i}`,
					timestamp: new Date(baseTime.getTime() + i * 1000),
					metadata: { conversationId: "conv-raw" },
				});
			}

			await runtime.processMessage("continue", "conv-raw");
			const request = mockLLMRouter.chat.mock.calls[0]?.[0];
			const contents = request.messages
				.map((message: { content: unknown }) => message.content)
				.filter(
					(content: unknown): content is string => typeof content === "string",
				);

			expect(contents).toContain("full-stm-79");
			expect(contents).toContain("full-stm-40");
			expect(contents).not.toContain("full-stm-0");
			expect(contents).toContain("continue");
		});

		it("should clear stale memory trace when advanced context assembly fails", async () => {
			const assembled: ContextAssemblyResult = {
				memoryPack: {
					taskObjective: "first",
					uncertaintyLevel: "HIGH_CONFIDENCE",
					memories: [
						{
							item: {
								id: "memory-1",
								type: "semantic",
								content: "known fact",
								embedding: [],
								importance: 0.8,
								accessCount: 0,
								lastAccessed: new Date(),
								createdAt: new Date(),
								associations: [],
								source: {},
								metadata: {},
							},
							score: 0.9,
						},
					],
					userMemory: [],
					projectMemory: [],
					similarEpisodes: [],
					agentLessons: [],
					prospectiveReminders: [],
					knownGaps: [],
					toolRecommendations: [],
					knownRisks: [],
					tokenBudgetUsed: 3,
					tokenBudgetRemaining: 100,
				},
				proactiveNotices: [],
				proactiveMemoryIds: ["reminder-1"],
				degradedSections: [],
				mandatorySectionsPreserved: [],
				budgetExceeded: false,
			};
			const assembler = { assemble: vi.fn().mockResolvedValue(assembled) };
			runtime.setContextAssembler(assembler as never);

			await runtime.processMessage("first");
			expect(runtime.getLastMemoryTrace()?.memoryIds).toEqual([
				"memory-1",
				"reminder-1",
			]);

			const failingAssembler = {
				assemble: vi.fn().mockRejectedValue(new Error("boom")),
			};
			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			runtime.setContextAssembler(failingAssembler as never);
			await runtime.processMessage("second");

			expect(runtime.getLastMemoryTrace()).toBeUndefined();
			consoleError.mockRestore();
		});

		it("should execute tool calls when LLM returns them", async () => {
			mockLLMRouter = createMockLLMRouter({
				content: "",
				toolCalls: [
					{
						id: "call-1",
						type: "function" as const,
						function: {
							name: "calculator",
							arguments: '{"expression": "2+2"}',
						},
					},
				],
			});

			const secondResponse: LLMResponse = {
				content: "The answer is 4",
				model: "test-model",
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
				finishReason: "stop",
			};
			mockLLMRouter.chat
				.mockResolvedValueOnce(mockLLMRouter.chat() ?? ({} as LLMResponse))
				.mockResolvedValueOnce(secondResponse);

			const mockRegistry = createMockToolRegistry([
				{ name: "calculator", description: "Performs calculations" },
			]);
			const mockExecutor = createMockToolExecutor();

			runtime = new AgentRuntime(
				baseConfig,
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);
			runtime.setToolSystem(
				mockRegistry as unknown as ToolRegistry,
				mockExecutor as unknown as ToolExecutor,
			);

			mockLLMRouter.chat
				.mockResolvedValueOnce({
					content: "",
					model: "test-model",
					usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
					finishReason: "stop",
					toolCalls: [
						{
							id: "call-1",
							type: "function" as const,
							function: {
								name: "calculator",
								arguments: '{"expression":"2+2"}',
							},
						},
					],
				})
				.mockResolvedValueOnce(secondResponse);

			const result = await runtime.processMessage("calculate 2+2");
			expect(mockExecutor.execute).toHaveBeenCalledWith(
				"calculator",
				{
					expression: "2+2",
				},
				expect.objectContaining({ usesZaiVisionToolForImages: false }),
			);
			expect(result).toBe("The answer is 4");
		});

		it("should stop tool execution at the configured iteration limit", async () => {
			mockLLMRouter.chat.mockResolvedValue({
				content: "",
				model: "test-model",
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
				finishReason: "tool_calls",
				toolCalls: [
					{
						id: "call-1",
						type: "function" as const,
						function: {
							name: "calculator",
							arguments: '{"expression":"2+2"}',
						},
					},
				],
			});

			const mockRegistry = createMockToolRegistry([
				{ name: "calculator", description: "Performs calculations" },
			]);
			const mockExecutor = createMockToolExecutor();

			runtime = new AgentRuntime(
				{
					...baseConfig,
					toolIterationLimit: { enabled: true, maxIterations: 1 },
				},
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);
			runtime.setToolSystem(
				mockRegistry as unknown as ToolRegistry,
				mockExecutor as unknown as ToolExecutor,
			);

			const result = await runtime.processMessage("calculate repeatedly");
			expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
			expect(mockLLMRouter.chat).toHaveBeenCalledTimes(1);
			expect(result).toContain("maximum number of tool iterations");
		});

		it("should ignore maxIterations when the iteration limit is disabled", async () => {
			const toolResponse = {
				content: "",
				model: "test-model",
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
				finishReason: "tool_calls" as const,
				toolCalls: [
					{
						id: "call-1",
						type: "function" as const,
						function: {
							name: "calculator",
							arguments: '{"expression":"2+2"}',
						},
					},
				],
			};
			mockLLMRouter.chat
				.mockResolvedValueOnce(toolResponse)
				.mockResolvedValueOnce(toolResponse)
				.mockResolvedValueOnce({
					content: "Finished after extra tools",
					model: "test-model",
					usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
					finishReason: "stop",
				});

			const mockRegistry = createMockToolRegistry([
				{ name: "calculator", description: "Performs calculations" },
			]);
			const mockExecutor = createMockToolExecutor();

			runtime = new AgentRuntime(
				{
					...baseConfig,
					toolIterationLimit: { enabled: false, maxIterations: 1 },
				},
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);
			runtime.setToolSystem(
				mockRegistry as unknown as ToolRegistry,
				mockExecutor as unknown as ToolExecutor,
			);

			const result = await runtime.processMessage("calculate without limit");
			expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
			expect(mockLLMRouter.chat).toHaveBeenCalledTimes(3);
			expect(result).toBe("Finished after extra tools");
		});

		it("should include skills in system prompt when resolved", async () => {
			const skills: LoadedSkill[] = [
				{
					skill: {
						id: "s1",
						name: "code-review",
						version: "1.0",
						description: "Code review skill",
						tags: [],
						embedding: [],
						instructions: "Review code carefully",
						examples: [],
						templates: [],
						triggerConditions: { keywords: [], taskPatterns: [], domains: [] },
						contextEstimate: {
							instructions: 100,
							perExample: 50,
							templates: 0,
						},
						metrics: {
							timesUsed: 0,
							successRate: 1,
							avgUserRating: 5,
							lastUsed: "",
							improvementsCount: 0,
							createdAt: "",
						},
						quality: { completeness: 1, accuracy: 1, clarity: 1 },
						dependencies: [],
						related: [],
					},
					content: "Always check for type safety.",
					level: 2,
				},
			];
			mockSkillLoader = createMockSkillLoader(skills);
			runtime = new AgentRuntime(
				baseConfig,
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);

			await runtime.processMessage("Review my code");
			const request = mockLLMRouter.chat.mock.calls[0]?.[0];
			const systemMsg = request.messages.find(
				(m: { role: string }) => m.role === "system",
			);
			expect(systemMsg?.content).toContain("Relevant Skills");
			expect(systemMsg?.content).toContain("Always check for type safety.");
		});

		it("should include memory context when memories exist", async () => {
			mockMemoryRetrieval = createMockMemoryRetrieval({
				memories: [
					{
						item: {
							id: "m1",
							type: "semantic" as const,
							content: "User prefers dark mode",
							embedding: [],
							importance: 0.8,
							accessCount: 3,
							lastAccessed: new Date(),
							createdAt: new Date(),
							associations: [],
							source: {},
							metadata: {},
						},
						score: 0.9,
					},
				],
				totalTokens: 50,
				fromSTM: [],
				combined: [],
			});
			runtime = new AgentRuntime(
				baseConfig,
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);

			await runtime.processMessage("Change theme");
			const request = mockLLMRouter.chat.mock.calls[0]?.[0];
			const memoryMsg = request.messages.find(
				(m: { role: string; content: string }) =>
					m.role === "system" &&
					m.content.startsWith("Relevant memories from long-term storage:"),
			);
			expect(memoryMsg).toBeDefined();
			expect(memoryMsg?.content).toContain(
				"answer from these memories instead of saying you do not remember",
			);
			expect(memoryMsg?.content).toContain(
				"A [REDACTED] span only withholds that span",
			);
			expect(memoryMsg?.content).toContain(
				"If the user asks whether you remember a visible code",
			);
			expect(memoryMsg?.content).toContain(
				"If Visible identifiers/codes contains the user-requested code",
			);
			expect(memoryMsg?.content).toContain(
				"answer from Visible content, not from redacted source metadata",
			);
			expect(memoryMsg?.content).toContain(
				"Do not describe visible identifiers as merely labels",
			);
			expect(memoryMsg?.content).toContain(
				"Visible content: User prefers dark mode",
			);
			expect(memoryMsg?.content).toContain("User prefers dark mode");
		});

		it("should omit assistant denial echoes when direct memories exist", async () => {
			mockMemoryRetrieval = createMockMemoryRetrieval({
				memories: [
					{
						item: {
							id: "direct-memory",
							type: "semantic" as const,
							content: "Public focused memory: code FocusCobaltPublic.",
							embedding: [],
							importance: 0.8,
							accessCount: 0,
							lastAccessed: new Date(),
							createdAt: new Date(),
							associations: [],
							source: {},
							metadata: {},
						},
						score: 0.9,
					},
					{
						item: {
							id: "denial-echo",
							type: "episodic" as const,
							content:
								'Interaction summary: User asked: "FocusCobaltPublic" Assistant replied: "No lo recuerdo, no tengo registro."',
							embedding: [],
							importance: 0.5,
							accessCount: 0,
							lastAccessed: new Date(),
							createdAt: new Date(),
							associations: [],
							source: {},
							metadata: {},
						},
						score: 0.7,
					},
				],
			});
			runtime = new AgentRuntime(
				baseConfig,
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);

			await runtime.processMessage("Remember FocusCobaltPublic");
			const request = mockLLMRouter.chat.mock.calls[0]?.[0];
			const memoryMsg = request.messages.find(
				(m: { role: string; content: string }) =>
					m.role === "system" &&
					m.content.startsWith("Relevant memories from long-term storage:"),
			);
			expect(memoryMsg?.content).toContain("FocusCobaltPublic");
			expect(memoryMsg?.content).toContain(
				"Visible identifiers/codes: FocusCobaltPublic",
			);
			expect(memoryMsg?.content).not.toContain("No lo recuerdo");
		});

		it("should include condensed STM context from retrieval in the prompt", async () => {
			mockMemoryRetrieval = createMockMemoryRetrieval({
				fromSTM: [
					{
						role: "system",
						content:
							"## Previous Context (condensed)\nEarlier blocked API decision",
						timestamp: new Date(),
					},
				],
			});
			runtime = new AgentRuntime(
				baseConfig,
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);

			await runtime.processMessage("Continue the task");
			const request = mockLLMRouter.chat.mock.calls[0]?.[0];
			expect(
				request.messages.some(
					(m: { role: string; content: string }) =>
						m.role === "system" &&
						m.content.includes("Earlier blocked API decision"),
				),
			).toBe(true);
		});

		it("should carry tool usage into working memory for subsequent turns", async () => {
			mockLLMRouter.chat
				.mockResolvedValueOnce({
					content: "",
					model: "test-model",
					usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
					finishReason: "tool_calls",
					toolCalls: [
						{
							id: "call-1",
							type: "function" as const,
							function: {
								name: "calculator",
								arguments: '{"expression":"2+2"}',
							},
						},
					],
				})
				.mockResolvedValueOnce({
					content: "The answer is 4",
					model: "test-model",
					usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
					finishReason: "stop",
				})
				.mockResolvedValueOnce({
					content: "Next answer",
					model: "test-model",
					usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
					finishReason: "stop",
				});

			const mockRegistry = createMockToolRegistry([
				{ name: "calculator", description: "Performs calculations" },
			]);
			const mockExecutor = createMockToolExecutor();
			runtime.setToolSystem(
				mockRegistry as unknown as ToolRegistry,
				mockExecutor as unknown as ToolExecutor,
			);

			await runtime.processMessage("calculate 2+2");
			await runtime.processMessage("continue");
			const request = mockLLMRouter.chat.mock.calls[2]?.[0];
			expect(request.messages[0]?.content).toContain(
				"**Tools Used**: calculator",
			);
		});

		it("should update working memory before building streaming context", async () => {
			for await (const _chunk of runtime.processMessageStream(
				"Please inspect https://example.com/docs",
			)) {
				// consume stream
			}
			const request = mockLLMRouter.chatStream.mock.calls[0]?.[0];
			expect(request.messages[0]?.content).toContain("Working Memory");
			expect(request.messages[0]?.content).toContain(
				"https://example.com/docs",
			);
		});

		it("should filter internal Z.AI vision requirements across stream chunks", async () => {
			mockLLMRouter.chatStream = vi.fn().mockImplementation(async function* () {
				yield { content: "Cambios" } satisfies LLMChunk;
				yield { content: " aplicados.\n\n[ZAI" } satisfies LLMChunk;
				yield {
					content:
						' VISION REQUIRED] This image must be inspected with an available Z.AI Vision MCP tool. Use "C:\\tmp\\image.png" before answering.',
				} satisfies LLMChunk;
			});

			const chunks: string[] = [];
			for await (const chunk of runtime.processMessageStream(
				"describe generated image",
			)) {
				chunks.push(chunk);
			}

			const output = chunks.join("");
			expect(output).toContain("Cambios aplicados.");
			expect(output).not.toContain("ZAI VISION REQUIRED");
			expect(output).not.toContain("C:\\tmp\\image.png");
			const assistantTurn = mockSTM.add.mock.calls.find(
				([turn]) => turn.role === "assistant",
			)?.[0];
			expect(assistantTurn?.content).toContain("Cambios aplicados.");
			expect(assistantTurn?.content).not.toContain("ZAI VISION REQUIRED");
		});

		it("should finish streamed delegate_task batches and persist a workflow", async () => {
			mockLLMRouter.chatStream = vi
				.fn()
				.mockImplementationOnce(async function* () {
					yield {
						toolCalls: {
							id: "delegate-1",
							type: "function" as const,
							function: {
								name: "delegate_task",
								arguments: JSON.stringify({
									role: "qa",
									task: "Review risks",
									arm_key: "crabby",
									produces: [{ artifactKey: "risk_review", artifactType: "qa_result" }],
									model: "cheap-model",
								}),
							},
						},
					};
					yield {
						toolCalls: {
							id: "delegate-2",
							type: "function" as const,
							function: {
								name: "delegate_task",
								arguments: JSON.stringify({
									role: "writer",
									task: "Draft plan",
									arm_key: "estelita",
								}),
							},
						},
					};
				});
			mockLLMRouter.chat.mockResolvedValueOnce({
				content: "Final combined answer",
				model: "test-model",
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
				finishReason: "stop",
			});
			const mockRegistry = createMockToolRegistry([
				{ name: "delegate_task", description: "Delegates work" },
			]);
			const mockExecutor = createMockToolExecutor();
			mockExecutor.execute.mockImplementation(async (_name, params) => ({
				success: true,
				output: `Worker result for ${(params as { role?: string }).role}`,
			}));
			const mockWorkflowManager = {
				createRun: vi.fn().mockResolvedValue({ id: "wf-1" }),
				updateRunStatus: vi.fn(),
				createTask: vi
					.fn()
					.mockResolvedValueOnce({ id: "wf-task-1", arm_key: "crabby" })
					.mockResolvedValueOnce({ id: "wf-task-2", arm_key: "estelita" }),
				recordEvent: vi.fn(),
				updateTaskStatus: vi.fn(),
			};

			runtime.setToolSystem(
				mockRegistry as unknown as ToolRegistry,
				mockExecutor as unknown as ToolExecutor,
			);
			runtime.setWorkflowManager(mockWorkflowManager as never);

			const chunks: string[] = [];
			for await (const chunk of runtime.processMessageStream(
				"Use multiple agents",
				"conv-1",
			)) {
				chunks.push(chunk);
			}

			expect(chunks.join("")).toContain("Final combined answer");
			expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
			expect(mockLLMRouter.chat).toHaveBeenCalledTimes(1);
			expect(mockLLMRouter.chatStream).toHaveBeenCalledTimes(1);
			expect(mockWorkflowManager.createRun).toHaveBeenCalledWith(
				expect.objectContaining({
					conversationId: "conv-1",
					rootAgentId: "test-agent",
					metadata: expect.objectContaining({
						source: "kanban_swarm_delegate",
						workflowKind: "kanban_swarm",
					}),
				}),
			);
			expect(mockWorkflowManager.createTask).toHaveBeenCalledWith(
				expect.objectContaining({
					armKey: "crabby",
					model: "cheap-model",
					produces: [{ artifactKey: "risk_review", artifactType: "qa_result" }],
				}),
			);
			expect(mockWorkflowManager.updateRunStatus).toHaveBeenCalledWith(
				"wf-1",
				"done",
				expect.objectContaining({ currentPhase: "synthesis" }),
			);
			const telemetryChunk = chunks.find((chunk) =>
				chunk.includes("orchestrating:telemetry"),
			);
			expect(telemetryChunk).toBeDefined();
			const encodedTelemetry = telemetryChunk
				?.replace(/\x00/g, "")
				.split(":")[4];
			const telemetry = JSON.parse(
				Buffer.from(encodedTelemetry ?? "", "base64").toString("utf8"),
			) as { workflowRunId?: string };
			expect(telemetry.workflowRunId).toBe("wf-1");
			expect(chunks.some((chunk) => chunk.includes("worker_done"))).toBe(true);
		});

		it("should inject relevant learning guidance and record the experience", async () => {
			const learningEngine = createMockLearningEngine();
			runtime.setLearningEngine(learningEngine as never);

			await runtime.processMessage("Review this code", "conv-1");

			expect(learningEngine.retrieveRelevant).toHaveBeenCalledWith(
				"Review this code",
			);
			const request = mockLLMRouter.chat.mock.calls[0]?.[0];
			expect(request.messages[0]?.content).toContain(
				"Learned Operating Guidance",
			);
			expect(request.messages[0]?.content).toContain(
				"Run type checks after code edits.",
			);
			expect(learningEngine.recordExperience).toHaveBeenCalledWith(
				expect.objectContaining({
					conversationId: "conv-1",
					userRequest: "Review this code",
					finalResponse: "Hello from assistant",
				}),
			);
		});

		it("should allow expensive tools even when a matching task is already completed", async () => {
			mockLLMRouter = createMockLLMRouter({
				content: "",
				toolCalls: [
					{
						id: "call-video",
						type: "function" as const,
						function: {
							name: "veo-video-generator",
							arguments: '{"prompt":"extend predator video"}',
						},
					},
				],
			});
			mockLLMRouter.chat
				.mockResolvedValueOnce({
					content: "",
					model: "test-model",
					usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
					finishReason: "tool_calls",
					toolCalls: [
						{
							id: "call-video",
							type: "function" as const,
							function: {
								name: "veo-video-generator",
								arguments: '{"prompt":"extend predator video"}',
							},
						},
					],
				})
				.mockResolvedValueOnce({
					content: "Extendí el video con una nueva versión.",
					model: "test-model",
					usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
					finishReason: "stop",
				});
			runtime = new AgentRuntime(
				baseConfig,
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);
			const mockRegistry = createMockToolRegistry([
				{ name: "veo-video-generator", description: "Generates videos" },
			]);
			const mockExecutor = createMockToolExecutor();
			const mockChatManager = {
				listTaskLedgerEntries: vi.fn().mockResolvedValue([]),
				searchTaskLedgerEntries: vi.fn().mockResolvedValue([
					{
						id: "ledger-1",
						conversation_id: "conv-video",
						objective: "Extender video del Depredador",
						status: "completed",
						summary: "Video final entregado.",
						outputs: JSON.stringify(["/api/media/file/final.mp4"]),
						tool_names: JSON.stringify(["veo-video-generator"]),
						source_message_id: null,
						created_at: "2026-05-22T00:00:00.000Z",
						updated_at: "2026-05-22T00:00:00.000Z",
						completed_at: "2026-05-22T00:00:00.000Z",
					},
				]),
				addTaskLedgerEntry: vi.fn(),
			};

			runtime.setToolSystem(
				mockRegistry as unknown as ToolRegistry,
				mockExecutor as unknown as ToolExecutor,
			);
			runtime.setChatManager(mockChatManager as never);

			const result = await runtime.processMessage(
				"extiende el video del depredador",
				"conv-video",
			);

			expect(result).toBe("Extendí el video con una nueva versión.");
			expect(mockExecutor.execute).toHaveBeenCalledWith(
				"veo-video-generator",
				expect.objectContaining({ prompt: "extend predator video" }),
				expect.any(Object),
			);
			expect(mockLLMRouter.chat).toHaveBeenCalledTimes(2);
		});

		it("should not stop media generation tools after two calls", async () => {
			mockLLMRouter = createMockLLMRouter();
			mockLLMRouter.chat
				.mockResolvedValueOnce({
					content: "",
					model: "test-model",
					usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
					finishReason: "tool_calls",
					toolCalls: [
						{
							id: "call-image-1",
							type: "function" as const,
							function: {
								name: "nano-banana-generate",
								arguments: '{"prompt":"construction image 1"}',
							},
						},
					],
				})
				.mockResolvedValueOnce({
					content: "",
					model: "test-model",
					usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
					finishReason: "tool_calls",
					toolCalls: [
						{
							id: "call-image-2",
							type: "function" as const,
							function: {
								name: "nano-banana-generate",
								arguments: '{"prompt":"construction image 2"}',
							},
						},
					],
				})
				.mockResolvedValueOnce({
					content: "",
					model: "test-model",
					usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
					finishReason: "tool_calls",
					toolCalls: [
						{
							id: "call-image-3",
							type: "function" as const,
							function: {
								name: "nano-banana-generate",
								arguments: '{"prompt":"construction image 3"}',
							},
						},
					],
				})
				.mockResolvedValueOnce({
					content: "Generé las tres imágenes solicitadas.",
					model: "test-model",
					usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
					finishReason: "stop",
				});
			runtime = new AgentRuntime(
				baseConfig,
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);
			const mockRegistry = createMockToolRegistry([
				{ name: "nano-banana-generate", description: "Generates images" },
			]);
			const mockExecutor = createMockToolExecutor();
			runtime.setToolSystem(
				mockRegistry as unknown as ToolRegistry,
				mockExecutor as unknown as ToolExecutor,
			);

			const result = await runtime.processMessage(
				"genera 3 imágenes",
				"conv-img",
			);

			expect(result).toBe("Generé las tres imágenes solicitadas.");
			expect(mockExecutor.execute).toHaveBeenCalledTimes(3);
			expect(mockExecutor.execute).toHaveBeenNthCalledWith(
				3,
				"nano-banana-generate",
				expect.objectContaining({ prompt: "construction image 3" }),
				expect.any(Object),
			);
		});

		it("should auto-continue streamed media workflows after the tool iteration limit", async () => {
			mockLLMRouter = createMockLLMRouter();
			mockLLMRouter.chatStream = vi
				.fn()
				.mockImplementationOnce(async function* () {
					yield {
						toolCalls: {
							id: "call-image-1",
							type: "function" as const,
							function: {
								name: "nano-banana-generate",
								arguments: '{"prompt":"construction image 1"}',
							},
						},
					};
				})
				.mockImplementationOnce(async function* () {
					yield {
						content: "Generé la siguiente imagen sin pedir confirmación.",
					};
				});
			runtime = new AgentRuntime(
				{
					...baseConfig,
					toolIterationLimit: { enabled: true, maxIterations: 1 },
					continuityGuard: { enabled: true, maxAutoContinuations: 1 },
				},
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);
			const mockRegistry = createMockToolRegistry([
				{ name: "nano-banana-generate", description: "Generates images" },
			]);
			const mockExecutor = createMockToolExecutor();
			runtime.setToolSystem(
				mockRegistry as unknown as ToolRegistry,
				mockExecutor as unknown as ToolExecutor,
			);

			const chunks: string[] = [];
			for await (const chunk of runtime.processMessageStream(
				"genera 2 imágenes",
				"conv-images",
			)) {
				chunks.push(chunk);
			}

			const output = chunks.join("");
			expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
			expect(mockLLMRouter.chatStream).toHaveBeenCalledTimes(2);
			expect(output).toContain("Auto-continuing remaining media workflow");
			expect(output).toContain(
				"Generé la siguiente imagen sin pedir confirmación.",
			);
			expect(output).not.toContain("Puedo continuar si me lo pides");
		});

		it("should allow expensive tools when feedback asks for a more creative revision", async () => {
			mockLLMRouter = createMockLLMRouter();
			mockLLMRouter.chat
				.mockResolvedValueOnce({
					content: "",
					model: "test-model",
					usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
					finishReason: "tool_calls",
					toolCalls: [
						{
							id: "call-image",
							type: "function" as const,
							function: {
								name: "nano-banana-generate",
								arguments: '{"prompt":"make it more creative"}',
							},
						},
					],
				})
				.mockResolvedValueOnce({
					content: "Generé una nueva portada más creativa.",
					model: "test-model",
					usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
					finishReason: "stop",
				});
			runtime = new AgentRuntime(
				baseConfig,
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);
			const mockRegistry = createMockToolRegistry([
				{ name: "nano-banana-generate", description: "Generates images" },
			]);
			const mockExecutor = createMockToolExecutor();
			const mockChatManager = {
				listTaskLedgerEntries: vi.fn().mockResolvedValue([]),
				searchTaskLedgerEntries: vi.fn().mockResolvedValue([
					{
						id: "ledger-1",
						conversation_id: "conv-image",
						objective: "Portada anterior completada",
						status: "completed",
						summary: "Portada final entregada.",
						outputs: JSON.stringify(["/api/media/file/final.png"]),
						tool_names: JSON.stringify(["nano-banana-generate"]),
						source_message_id: null,
						created_at: "2026-05-22T00:00:00.000Z",
						updated_at: "2026-05-22T00:00:00.000Z",
						completed_at: "2026-05-22T00:00:00.000Z",
					},
				]),
				addTaskLedgerEntry: vi.fn(),
			};

			runtime.setToolSystem(
				mockRegistry as unknown as ToolRegistry,
				mockExecutor as unknown as ToolExecutor,
			);
			runtime.setChatManager(mockChatManager as never);

			const result = await runtime.processMessage(
				"Tienes que ser más creativo, recuerda que es una portada para un video de redes sociales",
				"conv-image",
			);

			expect(result).toBe("Generé una nueva portada más creativa.");
			expect(mockExecutor.execute).toHaveBeenCalledWith(
				"nano-banana-generate",
				expect.objectContaining({ prompt: "make it more creative" }),
				expect.any(Object),
			);
		});

		it("should record continuation-limited responses as partial tasks", async () => {
			mockLLMRouter = createMockLLMRouter({
				content:
					"He alcanzado el límite máximo de herramientas en una sola respuesta. Puedo continuar si me lo pides.",
			});
			runtime = new AgentRuntime(
				baseConfig,
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);
			const mockChatManager = {
				listTaskLedgerEntries: vi.fn().mockResolvedValue([]),
				searchTaskLedgerEntries: vi.fn().mockResolvedValue([]),
				addTaskLedgerEntry: vi.fn(),
			};
			runtime.setChatManager(mockChatManager as never);

			await runtime.processMessage(
				"genera una colección de imágenes",
				"conv-1",
			);

			expect(mockChatManager.addTaskLedgerEntry).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "partial",
					completedAt: undefined,
				}),
			);
		});

		it("should record responses with generated outputs and missing work as partial", async () => {
			mockLLMRouter = createMockLLMRouter({
				content:
					"Ya tenemos Img 0 e Img 1: /api/media/file/img-1.png. Faltan Img 2 a Img 15.",
			});
			runtime = new AgentRuntime(
				baseConfig,
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);
			const mockChatManager = {
				listTaskLedgerEntries: vi.fn().mockResolvedValue([]),
				searchTaskLedgerEntries: vi.fn().mockResolvedValue([]),
				addTaskLedgerEntry: vi.fn(),
			};
			runtime.setChatManager(mockChatManager as never);

			await runtime.processMessage("genera 16 imágenes", "conv-outputs");

			expect(mockChatManager.addTaskLedgerEntry).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "partial",
					outputs: ["/api/media/file/img-1.png"],
					completedAt: undefined,
				}),
			);
		});

		it("should prioritize incomplete ledger entries for continuation prompts", async () => {
			const incompleteEntry = {
				id: "ledger-partial",
				conversation_id: "conv-resume",
				objective: "Generar varias imágenes de bosque",
				status: "partial",
				summary: "Se generaron dos imágenes; faltan tres.",
				outputs: JSON.stringify(["/api/media/file/forest-1.png"]),
				tool_names: JSON.stringify(["nano-banana-generate"]),
				source_message_id: null,
				created_at: "2026-05-22T00:00:00.000Z",
				updated_at: "2026-05-22T00:00:00.000Z",
				completed_at: null,
			};
			const mockChatManager = {
				listTaskLedgerEntries: vi.fn().mockResolvedValue([incompleteEntry]),
				searchTaskLedgerEntries: vi.fn().mockResolvedValue([]),
				addTaskLedgerEntry: vi.fn(),
			};
			runtime.setChatManager(mockChatManager as never);

			await runtime.processMessage("continua", "conv-resume");
			const request = mockLLMRouter.chat.mock.calls[0]?.[0];

			expect(request.messages[0]?.content).toContain(
				"Active/Pending Tasks To Continue",
			);
			expect(request.messages[0]?.content).toContain(
				"Generar varias imágenes de bosque",
			);
			expect(request.messages[0]?.content).toContain(
				"resume the first active/pending task",
			);
		});

		it("should resume from latest incomplete assistant turn even if execution was completed", async () => {
			mockSTM.add({
				role: "assistant",
				content:
					"Ya tenemos Img 0 a Img 2 generadas. Faltan Img 3 a Img 15. Generando Img 3...",
				timestamp: new Date("2026-05-22T00:00:00.000Z"),
				metadata: { conversationId: "conv-resume-raw" },
			});

			await runtime.processMessage("continua", "conv-resume-raw");
			const request = mockLLMRouter.chat.mock.calls[0]?.[0];
			const contents = request.messages
				.map((message: { content: unknown }) => message.content)
				.filter(
					(content: unknown): content is string => typeof content === "string",
				)
				.join("\n");

			expect(contents).toContain("latest assistant turn says work remains");
			expect(contents).toContain("Faltan Img 3 a Img 15");
		});

		it("should block manual Veo API calls through execute_code", async () => {
			mockLLMRouter = createMockLLMRouter();
			mockLLMRouter.chat
				.mockResolvedValueOnce({
					content: "",
					model: "test-model",
					usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
					finishReason: "tool_calls",
					toolCalls: [
						{
							id: "call-code",
							type: "function" as const,
							function: {
								name: "execute_code",
								arguments: JSON.stringify({
									language: "python",
									code: "requests.post('https://us-central1-aiplatform.googleapis.com/v1/projects/x/locations/us-central1/publishers/google/models/veo-3.0-fast-generate-001:predictLongRunning')",
								}),
							},
						},
					],
				})
				.mockResolvedValueOnce({
					content:
						"Usaré la herramienta veo-video-generator en lugar de execute_code.",
					model: "test-model",
					usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
					finishReason: "stop",
				});
			runtime = new AgentRuntime(
				baseConfig,
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);
			const mockRegistry = createMockToolRegistry([
				{ name: "execute_code", description: "Executes code" },
				{ name: "veo-video-generator", description: "Generates videos" },
			]);
			const mockExecutor = createMockToolExecutor();
			runtime.setToolSystem(
				mockRegistry as unknown as ToolRegistry,
				mockExecutor as unknown as ToolExecutor,
			);

			const result = await runtime.processMessage(
				"intenta hacerlo con el modelo fast de Veo 3.0",
				"conv-video",
			);

			expect(result).toBe(
				"Usaré la herramienta veo-video-generator en lugar de execute_code.",
			);
			expect(mockExecutor.execute).not.toHaveBeenCalled();
			expect(mockLLMRouter.chat).toHaveBeenCalledTimes(2);
		});

		it("allows editing a tool file that merely mentions veo-3.* model names (no API endpoint)", async () => {
			mockLLMRouter = createMockLLMRouter();
			mockLLMRouter.chat
				.mockResolvedValueOnce({
					content: "",
					model: "test-model",
					usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
					finishReason: "tool_calls",
					toolCalls: [
						{
							id: "call-edit",
							type: "function" as const,
							function: {
								name: "execute_code",
								arguments: JSON.stringify({
									language: "javascript",
									code: "fs.writeFileSync('index.mjs', src.replace('veo-3.1-generate-preview', 'veo-3.1-generate-001'));",
								}),
							},
						},
					],
				})
				.mockResolvedValueOnce({
					content: "Listo, agregué veo-3.1-generate-001 a VALID_MODELS.",
					model: "test-model",
					usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
					finishReason: "stop",
				});
			runtime = new AgentRuntime(
				baseConfig,
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);
			const mockRegistry = createMockToolRegistry([
				{ name: "execute_code", description: "Executes code" },
				{ name: "veo-video-generator", description: "Generates videos" },
			]);
			const mockExecutor = createMockToolExecutor();
			runtime.setToolSystem(
				mockRegistry as unknown as ToolRegistry,
				mockExecutor as unknown as ToolExecutor,
			);

			const result = await runtime.processMessage(
				"agrega veo-3.1-generate-001 a la lista de modelos de veo-video-generator",
				"conv-edit-allowed",
			);

			expect(mockExecutor.execute).toHaveBeenCalledWith(
				"execute_code",
				expect.anything(),
				expect.anything(),
			);
			expect(result).toBe(
				"Listo, agregué veo-3.1-generate-001 a VALID_MODELS.",
			);
		});
	});

	describe("stall detection (promised-but-not-acted)", () => {
		it("forces a retry and recovers when the model promises an action without emitting a tool call", async () => {
			mockLLMRouter = createMockLLMRouter();
			mockLLMRouter.chat
				.mockResolvedValueOnce({
					content: "Encontré el problema. Lo agrego ahora:",
					model: "test-model",
					usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
					finishReason: "stop",
				})
				.mockResolvedValueOnce({
					content: "",
					model: "test-model",
					usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
					finishReason: "tool_calls",
					toolCalls: [
						{
							id: "call-edit",
							type: "function" as const,
							function: {
								name: "edit_file",
								arguments: '{"path":"config.ts"}',
							},
						},
					],
				})
				.mockResolvedValueOnce({
					content: "Listo, edité el archivo correctamente.",
					model: "test-model",
					usage: { promptTokens: 14, completionTokens: 6, totalTokens: 20 },
					finishReason: "stop",
				});
			runtime = new AgentRuntime(
				baseConfig,
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);
			const mockRegistry = createMockToolRegistry([
				{ name: "edit_file", description: "Edits a file" },
			]);
			const mockExecutor = createMockToolExecutor();
			runtime.setToolSystem(
				mockRegistry as unknown as ToolRegistry,
				mockExecutor as unknown as ToolExecutor,
			);

			const result = await runtime.processMessage(
				"agrega veo-3.1-generate-001 a la lista de modelos",
				"conv-stall-recover",
			);

			expect(mockExecutor.execute).toHaveBeenCalledWith(
				"edit_file",
				expect.objectContaining({ path: "config.ts" }),
				expect.any(Object),
			);
			expect(result).toBe("Listo, edité el archivo correctamente.");
		});

		it("stops with a clear warning after the stall retry budget is spent", async () => {
			mockLLMRouter = createMockLLMRouter({
				content: "Encontré el problema. Lo agrego ahora:",
				finishReason: "stop",
			});
			runtime = new AgentRuntime(
				{
					...baseConfig,
					continuityGuard: {
						enabled: true,
						maxAutoContinuations: 25,
						truncationDetection: true,
						stallDetection: true,
						maxStallForcings: 2,
						stallSignatureHistory: 4,
					},
				},
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);
			// No tool system configured: every turn ends without tool calls → stall path.

			const result = await runtime.processMessage(
				"agrega el modelo a la lista",
				"conv-stall-exhaust",
			);

			expect(result).toContain("Lo agrego ahora:");
			expect(result).toContain("⚠️");
			expect(result).toContain("NO se completó");
			// 2 forced retries + 1 exhausted = 3 LLM calls.
			expect(mockLLMRouter.chat).toHaveBeenCalledTimes(3);
		});

		it("does not force or warn on a neutral final response without an action promise", async () => {
			mockLLMRouter = createMockLLMRouter({
				content:
					"Listo, ya terminé el análisis del problema sin necesidad de editar nada.",
				finishReason: "stop",
			});
			runtime = new AgentRuntime(
				baseConfig,
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);

			const result = await runtime.processMessage(
				"analiza el problema",
				"conv-stall-neutral",
			);

			expect(result).toBe(
				"Listo, ya terminé el análisis del problema sin necesidad de editar nada.",
			);
			expect(result).not.toContain("⚠️");
			expect(mockLLMRouter.chat).toHaveBeenCalledTimes(1);
		});
	});

	describe("fresh research before codegen", () => {
		it("researches and injects Fresh Research for technical codegen requests", async () => {
			mockLLMRouter = createMockLLMRouter({
				content: "Aquí está la herramienta con el endpoint correcto.",
				finishReason: "stop",
			});
			runtime = new AgentRuntime(
				baseConfig,
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);
			const researcher = {
				research: vi.fn().mockResolvedValue({
					isTechnical: true,
					context: "OPENAI-IMAGE-2-DOCS-MARKER",
					sources: ["context7:/openai/image"],
					fetchedAt: "2026-06-13T00:00:00.000Z",
					summary: "researched",
				}),
			};
			runtime.setResearcher(researcher as unknown as SkillResearcher);
			const mockChatManager = {
				listTaskLedgerEntries: vi.fn().mockResolvedValue([]),
				searchTaskLedgerEntries: vi.fn().mockResolvedValue([]),
				addTaskLedgerEntry: vi.fn(),
			};
			runtime.setChatManager(mockChatManager as never);

			await runtime.processMessage(
				"crea una herramienta de generación de imagen con la API de OpenAI Image 2",
				"conv-codegen",
			);

			expect(researcher.research).toHaveBeenCalledWith(
				expect.objectContaining({
					description: expect.stringContaining("OpenAI"),
				}),
			);
			const req = mockLLMRouter.chat.mock.calls[0]?.[0] as
				| { messages?: Array<{ role: string; content: string }> }
				| undefined;
			const system = req?.messages?.find((m) => m.role === "system");
			expect(system?.content).toContain("Fresh Research");
			expect(system?.content).toContain("OPENAI-IMAGE-2-DOCS-MARKER");
		});

		it("does NOT research for non-technical requests", async () => {
			mockLLMRouter = createMockLLMRouter({
				content: "Son las 3 de la tarde.",
				finishReason: "stop",
			});
			runtime = new AgentRuntime(
				baseConfig,
				mockLLMRouter as unknown as Parameters<typeof AgentRuntime>[1],
				mockSTM as unknown as Parameters<typeof AgentRuntime>[2],
				mockMemoryRetrieval as unknown as Parameters<typeof AgentRuntime>[3],
				mockConsolidator as unknown as Parameters<typeof AgentRuntime>[4],
				mockSkillLoader as unknown as Parameters<typeof AgentRuntime>[5],
			);
			const researcher = { research: vi.fn() };
			runtime.setResearcher(researcher as unknown as SkillResearcher);
			const mockChatManager = {
				listTaskLedgerEntries: vi.fn().mockResolvedValue([]),
				searchTaskLedgerEntries: vi.fn().mockResolvedValue([]),
				addTaskLedgerEntry: vi.fn(),
			};
			runtime.setChatManager(mockChatManager as never);

			await runtime.processMessage("¿qué hora es?", "conv-noop");

			expect(researcher.research).not.toHaveBeenCalled();
		});
	});

	describe("getState", () => {
		it("should return stm load, conversation length, and active task", () => {
			const state = runtime.getState();
			expect(state).toHaveProperty("stmLoad");
			expect(state).toHaveProperty("conversationLength");
			expect(state).toHaveProperty("activeTask");
			expect(typeof state.stmLoad).toBe("number");
			expect(typeof state.conversationLength).toBe("number");
		});
	});

	describe("runConsolidation", () => {
		it("should delegate to memory consolidator", async () => {
			const result = await runtime.runConsolidation();
			expect(mockConsolidator.consolidate).toHaveBeenCalledWith(mockSTM);
			expect(result).toHaveProperty("stored");
			expect(result).toHaveProperty("updated");
			expect(result).toHaveProperty("compressed");
			expect(result).toHaveProperty("forgotten");
			expect(result).toHaveProperty("associations");
		});
	});
});

describe("image routing classification", () => {
	it("flags Z.ai GLM models as needing the external vision tool", () => {
		expect(requiresZaiVisionToolForModel("zhipu/glm-4.6")).toBe(true);
		expect(requiresZaiVisionToolForModel("zai/glm-4.5-air")).toBe(true);
		expect(requiresZaiVisionToolForModel("glm-4.6")).toBe(true);
		expect(requiresZaiVisionToolForModel("openai/gpt-5.5")).toBe(false);
	});

	it("routes GLM and text-only providers to the vision tool", () => {
		const visionCapable = (_model: string) => true;
		const textOnly = (_model: string) => false;
		// GLM always needs the tool regardless of provider capability flag.
		expect(
			requiresExternalVisionToolForModel("zhipu/glm-4.6", visionCapable),
		).toBe(true);
		// Native multimodal provider: no tool needed.
		expect(
			requiresExternalVisionToolForModel("openai/gpt-5.5", visionCapable),
		).toBe(false);
		// Text-only provider (e.g. DeepSeek): needs the tool.
		expect(
			requiresExternalVisionToolForModel("deepseek/deepseek-chat", textOnly),
		).toBe(true);
		// Native multimodal must not be flagged even if the function is misused.
		expect(
			requiresExternalVisionToolForModel("deepseek/deepseek-chat", visionCapable),
		).toBe(false);
	});
});
