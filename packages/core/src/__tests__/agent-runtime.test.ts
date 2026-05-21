import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../agent/runtime.js";
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
