import type { LLMRouter } from "../ai/router.js";
import type {
	LLMMessage,
	LLMRequest,
	LLMResponse,
	LLMTool,
	LLMToolCall,
} from "../ai/types.js";
import type { MemoryConsolidator } from "../memory/consolidator.js";
import type { GlobalDailyMemory } from "../memory/daily.js";
import type { MemoryRetrieval } from "../memory/retrieval.js";
import type { ShortTermMemory } from "../memory/stm.js";
import type { ConsolidationResult, MemoryContext } from "../memory/types.js";
import type { UserProfileManager } from "../memory/user-profile.js";
import type { SkillLoader } from "../skills/loader.js";
import type { LoadedSkill } from "../skills/types.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolResult } from "../tools/registry.js";
import type { AgentConfig, ConversationTurn, TaskState } from "./types.js";

const MAX_TOOL_ITERATIONS = 30;

export class AgentRuntime {
	private config: AgentConfig;
	private llmRouter: LLMRouter;
	public stm: ShortTermMemory;
	private memoryRetrieval: MemoryRetrieval;
	private memoryConsolidator: MemoryConsolidator;
	private skillLoader: SkillLoader;
	private toolRegistry?: ToolRegistry;
	private toolExecutor?: ToolExecutor;
	private dailyMemory?: GlobalDailyMemory;
	private userProfileManager?: UserProfileManager;

	constructor(
		config: AgentConfig,
		llmRouter: LLMRouter,
		stm: ShortTermMemory,
		memoryRetrieval: MemoryRetrieval,
		memoryConsolidator: MemoryConsolidator,
		skillLoader: SkillLoader,
	) {
		this.config = config;
		this.llmRouter = llmRouter;
		this.stm = stm;
		this.memoryRetrieval = memoryRetrieval;
		this.memoryConsolidator = memoryConsolidator;
		this.skillLoader = skillLoader;
	}

	setToolSystem(registry: ToolRegistry, executor: ToolExecutor): void {
		this.toolRegistry = registry;
		this.toolExecutor = executor;
	}

	setDailyMemory(dailyMemory: GlobalDailyMemory): void {
		this.dailyMemory = dailyMemory;
	}

	setUserProfileManager(manager: UserProfileManager): void {
		this.userProfileManager = manager;
	}

	async initialize(): Promise<void> {
		if (!this.config.id) {
			throw new Error("Agent config must have an id");
		}
		if (!this.config.name) {
			throw new Error("Agent config must have a name");
		}
		if (!this.config.systemPrompt) {
			throw new Error("Agent config must have a systemPrompt");
		}
	}

	async processMessage(message: string, channelId?: string): Promise<string> {
		const userTurn: ConversationTurn = {
			role: "user",
			content: message,
			timestamp: new Date(),
			metadata: channelId ? { conversationId: channelId } : undefined,
		};
		this.stm.add(userTurn);

		const memories = await this.memoryRetrieval.retrieveForContext(message);

		const skills = await this.skillLoader.resolveSkillsForTask({
			description: message,
			complexity: 0.5,
			domains: [],
			keywords: message.split(/\s+/).filter((w) => w.length > 3),
		});

		const context = await this.buildContext(memories, skills, message, channelId);
		const tools = this.getAvailableTools();

		const response = await this.executeWithTools(context, tools);

		const assistantTurn: ConversationTurn = {
			role: "assistant",
			content: response.content,
			timestamp: new Date(),
			metadata: channelId ? { conversationId: channelId } : undefined,
		};
		this.stm.add(assistantTurn);

		if (this.userProfileManager) {
			this.userProfileManager.updateFromConversation("owner", [userTurn, assistantTurn])
				.catch(err => console.error("Failed to update user profile:", err));
		}

		this.updateActiveTask(response.content);

		this.dailyMemory?.addMessage(message, "user", channelId || "system").catch(() => {});
		this.dailyMemory?.addMessage(response.content, "assistant", channelId || "system").catch(() => {});

		return response.content;
	}

	static readonly STATUS_RE = /^\\x00STATUS:(\w+)(?::(\w+))?\\x00$/;

	async *processMessageStream(
		message: string,
		channelId?: string,
	): AsyncIterable<string> {
		const userTurn: ConversationTurn = {
			role: "user",
			content: message,
			timestamp: new Date(),
			metadata: channelId ? { conversationId: channelId } : undefined,
		};
		this.stm.add(userTurn);

		const memories = await this.memoryRetrieval.retrieveForContext(message);

		const skills = await this.skillLoader.resolveSkillsForTask({
			description: message,
			complexity: 0.5,
			domains: [],
			keywords: message.split(/\s+/).filter((w) => w.length > 3),
		});

		const context = await this.buildContext(memories, skills, message, channelId);
		const tools = this.getAvailableTools();

		const messages = [...context];
		let iterations = 0;
		let fullResponse = "";

		while (iterations < MAX_TOOL_ITERATIONS) {
			iterations++;

			const request: LLMRequest = {
				model: this.config.model ?? "default",
				messages,
				maxTokens: this.config.maxTokens,
				temperature: this.config.temperature,
				stream: true,
				tools: tools.length > 0 ? tools : undefined,
			};

			let chunkContent = "";
			const toolCalls: Array<{
				id: string;
				type: "function";
				function: { name: string; arguments: string };
			}> = [];
			let hasContent = false;
			let isThinking = false;

			try {
				yield "\x00STATUS:thinking\x00";
				for await (const chunk of this.llmRouter.chatStream(request)) {
					if (chunk.thinking) {
						if (!isThinking) {
							isThinking = true;
						}
						// Do not yield thinking text to stream
					}
					
					if (chunk.content) {
						if (isThinking) {
							isThinking = false;
						}
						chunkContent += chunk.content;
						fullResponse += chunk.content;
						hasContent = true;
						yield chunk.content;
					}
					if (chunk.toolCalls) {
						const tc = chunk.toolCalls;
						const tcFn = tc.function ?? { name: "", arguments: "" };
						const existing = toolCalls.find(
							(t) => t.id === tc.id && tc.id !== "",
						);
						if (existing) {
							existing.function.arguments += tcFn.arguments ?? "";
							if (tcFn.name) existing.function.name = tcFn.name;
						} else {
							toolCalls.push({
								id: tc.id || `tc_${iterations}_${toolCalls.length}`,
								type: "function",
								function: {
									name: tcFn.name ?? "",
									arguments: tcFn.arguments ?? "",
								},
							});
						}
					}
				}
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				fullResponse += `\n\n⚠️ Error: ${errMsg}`;
				yield errMsg;
				break;
			}

			const validToolCalls = toolCalls.filter(
				(tc) => tc.function.name.length > 0,
			);

			if (!hasContent && validToolCalls.length === 0) {
				const warnMsg = "\n\n⚠️ The AI model returned an empty response. This may be due to a content filter, context length limit, or an API error.";
				fullResponse += warnMsg;
				yield warnMsg;
				break;
			}

			if (
				validToolCalls.length === 0 ||
				!this.toolExecutor ||
				!this.toolRegistry
			) {
				break;
			}

			messages.push({
				role: "assistant",
				content: chunkContent || "",
				toolCalls: validToolCalls,
			});

			for (const toolCall of validToolCalls) {
				const isCodeTool =
					toolCall.function.name === "execute_code" ||
					toolCall.function.name === "run_shell";
				const toolDef = this.toolRegistry?.get(toolCall.function.name);
				const uiIconB64 = toolDef?.uiIcon
					? Buffer.from(toolDef.uiIcon).toString("base64")
					: "";
				const statusType = isCodeTool ? "code" : "tool";
				yield `\x00STATUS:${statusType}:${toolCall.function.name}:${uiIconB64}\x00`;

				let params: Record<string, unknown>;
				try {
					params = JSON.parse(toolCall.function.arguments);
				} catch {
					params = {};
				}

				const toolResult: ToolResult = await this.toolExecutor.execute(
					toolCall.function.name,
					params,
				);

				const resultContentStr = toolResult.success
					? (typeof toolResult.output === "string" ? toolResult.output : JSON.stringify(toolResult.output, null, 2))
					: `Error: ${toolResult.error ?? "Unknown error"}`;

				// Emit tool-done status (intercepted by frontend, not shown as text)
				if (toolResult.success) {
					yield `\x00STATUS:tool_done:${toolCall.function.name}:\x00`;
				} else {
					yield `\x00STATUS:tool_error:${toolCall.function.name}:\x00`;
				}

				fullResponse += `
<!-- tool:${toolCall.function.name}:${toolResult.success ? "ok" : "error"} -->
`;

				messages.push({
					role: "tool",
					content: resultContentStr.slice(0, 8000),
					toolCallId: toolCall.id,
				});
			}

			fullResponse += "\n\n";
		}

		// If we exhausted all iterations, warn the user
		if (iterations >= MAX_TOOL_ITERATIONS) {
			const limitMsg = "\n\n⚠️ He alcanzado el límite máximo de herramientas en una sola respuesta (30 iteraciones). Puedo continuar si me lo pides.";
			fullResponse += limitMsg;
			yield limitMsg;
		}

		const assistantTurn: ConversationTurn = {
			role: "assistant",
			content: fullResponse,
			timestamp: new Date(),
			metadata: channelId ? { conversationId: channelId } : undefined,
		};
		this.stm.add(assistantTurn);
		
		if (this.userProfileManager) {
			this.userProfileManager.updateFromConversation("owner", [userTurn, assistantTurn])
				.catch(err => console.error("Failed to update user profile:", err));
		}

		this.dailyMemory?.addMessage(message, "user", channelId || "system").catch(() => {});
		this.dailyMemory?.addMessage(fullResponse, "assistant", channelId || "system").catch(() => {});
		
		this.updateActiveTask(fullResponse);
	}

	private async executeWithTools(
		context: LLMMessage[],
		tools: LLMTool[],
	): Promise<{
		content: string;
		toolCallsExecuted: { name: string; result: string }[];
	}> {
		const toolCallsExecuted: { name: string; result: string }[] = [];
		const messages = [...context];
		let iterations = 0;

		while (iterations < MAX_TOOL_ITERATIONS) {
			iterations++;

			const request: LLMRequest = {
				model: this.config.model ?? "default",
				messages,
				maxTokens: this.config.maxTokens,
				temperature: this.config.temperature,
				tools: tools.length > 0 ? tools : undefined,
			};

			const response = await this.llmRouter.chat(request);

			if (
				response.toolCalls &&
				response.toolCalls.length > 0 &&
				this.toolExecutor &&
				this.toolRegistry
			) {
				const assistantMessage: LLMMessage = {
					role: "assistant",
					content: response.content || "",
					toolCalls: response.toolCalls,
				};
				messages.push(assistantMessage);

				const toolPromises = response.toolCalls.map(async (toolCall) => {
					let params: Record<string, unknown>;
					try {
						params = JSON.parse(toolCall.function.arguments);
					} catch {
						params = {};
					}

					const toolResult: ToolResult = await this.toolExecutor!.execute(
						toolCall.function.name,
						params,
					);

					const resultContent = toolResult.success
						? toolResult.output
						: `Error: ${toolResult.error ?? "Unknown error"}`;

					return {
						toolCallId: toolCall.id,
						name: toolCall.function.name,
						resultContent: resultContent.slice(0, 8000),
						executedName: toolCall.function.name,
						executedResult: resultContent.slice(0, 2000),
					};
				});

				const toolResults = await Promise.all(toolPromises);

				for (const res of toolResults) {
					toolCallsExecuted.push({
						name: res.executedName,
						result: res.executedResult,
					});

					messages.push({
						role: "tool",
						content: res.resultContent,
						toolCallId: res.toolCallId,
					});
				}
			} else {
				return { content: response.content, toolCallsExecuted };
			}
		}

		return {
			content: `I reached the maximum number of tool iterations. Here is what I have so far:\n${messages[messages.length - 1]?.content ?? ""}`,
			toolCallsExecuted,
		};
	}

	private getAvailableTools(): LLMTool[] {
		if (!this.toolRegistry) return [];
		return this.toolRegistry.toLLMTools();
	}

	private async buildContext(
		memories: MemoryContext,
		skills: LoadedSkill[],
		userMessage: string,
		channelId?: string,
	): Promise<LLMMessage[]> {
		const messages: LLMMessage[] = [];
		const contextParts: string[] = [];

		let systemContent = this.config.systemPrompt;
		
		if (this.userProfileManager) {
			try {
				const profile = await this.userProfileManager.getProfile("owner");
				let profileStr = `### User Profile (Preferences & Context)\n`;
				profileStr += `- Communication Style: ${profile.communicationStyle}\n`;
				if (Object.keys(profile.preferences).length > 0) {
					profileStr += `- Preferences: ${Object.entries(profile.preferences).map(([k, v]) => `${k}=${v}`).join(", ")}\n`;
				}
				if (profile.traits.length > 0) {
					profileStr += `- Traits: ${profile.traits.join(", ")}\n`;
				}
				const topExpertise = Object.entries(profile.expertiseAreas)
					.filter(([, v]) => v > 0.5)
					.map(([k]) => k);
				if (topExpertise.length > 0) {
					profileStr += `- Known User Expertise: ${topExpertise.join(", ")}\n`;
				}
				contextParts.push(profileStr);
			} catch (e) {
				console.error("Failed to load user profile for context:", e);
			}
		}

		if (this.dailyMemory) {
			const dailyContext = await this.dailyMemory.getCurrentContext();
			systemContent += `\n\n${dailyContext}`;
		}

		if (skills.length > 0) {
			const skillInstructions = skills.map((s) => s.content).join("\n\n");
			systemContent += `\n\n# Relevant Skills\n${skillInstructions}`;
		}

		if (this.toolRegistry && this.toolRegistry.list().length > 0) {
			const toolNames = this.toolRegistry
				.list()
				.map((t) => `- ${t.name}: ${t.description}`)
				.join("\n");
			systemContent += `\n\n# Available Tools\nYou have access to the following tools. Use them when needed to help the user:\n${toolNames}`;
			systemContent += "\n\nCRITICAL RULE: Do NOT use tools or hallucinate past tasks for simple greetings (e.g. 'hola') or casual conversation. Only use tools if the *latest* user request explicitly requires it.";
			systemContent += "\n\nIMPORTANT: When using the `create_tool` tool to create new tools, ALWAYS provide an animated SVG icon in the `uiIcon` parameter. The icon should be relevant to the tool's purpose and contain CSS animations like 'animation: pulse 2s infinite ease-in-out' on relevant elements.";
		}
		
		systemContent += `\n\nCRITICAL SYSTEM INSTRUCTION:
- You have access to a persistent Long-Term Memory (LTM) system.
- NEVER claim that you do not have memory or that "each conversation starts fresh".
- If no memories are provided in the context below, simply state that you don't have relevant information.`;

		if (contextParts.length > 0) {
			systemContent += `\n\n${contextParts.join("\n\n")}`;
		}

		messages.push({ role: "system", content: systemContent });

		if (memories.memories.length > 0) {
			const memoryFacts = memories.memories
				.map((m) => {
					let sourceStr = "";
					const sourceChannel = m.item.source?.channelId;
					if (sourceChannel) {
						sourceStr = `[Channel: ${sourceChannel}] `;
					} else if (m.item.source?.conversationId) {
						sourceStr = `[Conversation: ${m.item.source.conversationId}] `;
					}
					
					const timeMs = Date.now() - m.item.createdAt.getTime();
					const hours = Math.round(timeMs / (1000 * 60 * 60));
					const timeStr = hours > 24 
						? `[${Math.round(hours/24)} days ago] ` 
						: hours > 0 ? `[${hours} hours ago] ` : "[Recently] ";

					return `- ${sourceStr}${timeStr}${m.item.content}`;
				})
				.join("\n");
			messages.push({
				role: "system",
				content: `Relevant memories from long-term storage:\n${memoryFacts}`,
			});
		}

		const stmTurns = this.stm.getContext();
		let conversationTurns = stmTurns;
		if (channelId) {
			conversationTurns = stmTurns.filter(t => !t.metadata?.conversationId || t.metadata.conversationId === channelId);
		}
		const recentTurns = conversationTurns.slice(-20);
		for (const turn of recentTurns) {
			if (turn.role === "user" || turn.role === "assistant") {
				messages.push({ role: turn.role, content: turn.content });
			}
		}

		let hasUserMessage = false;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user" && messages[i].content === userMessage) {
				hasUserMessage = true;
				break;
			}
		}
		if (!hasUserMessage) {
			messages.push({ role: "user", content: userMessage });
		}

		return messages;
	}

	private updateActiveTask(responseText: string): void {
		const activeTask = this.stm.getActiveTask();
		if (
			activeTask &&
			activeTask.status === "running" &&
			this.detectTaskEnd(responseText)
		) {
			activeTask.status = "completed";
			activeTask.result = responseText;
			activeTask.completedAt = new Date();
			this.stm.setActiveTask(activeTask);
		}
	}

	private detectTaskEnd(response: string): boolean {
		const lower = response.toLowerCase();
		const markers = [
			"task done",
			"task completed",
			"task finished",
			"i'm done",
			"i am done",
			"completed successfully",
			"finished successfully",
			"all done",
			"task is complete",
			"task is done",
			"task is finished",
			"i have completed",
			"i have finished",
			"nothing more to do",
			"that concludes",
			"in summary",
			"final answer",
		];
		return markers.some((marker) => lower.includes(marker));
	}

	async runConsolidation(): Promise<ConsolidationResult> {
		return this.memoryConsolidator.consolidate(this.stm);
	}

	getState(): {
		stmLoad: number;
		conversationLength: number;
		activeTask: TaskState | null;
	} {
		return {
			stmLoad: this.stm.getLoad(),
			conversationLength: this.stm.getContext().length,
			activeTask: this.stm.getActiveTask(),
		};
	}
}
