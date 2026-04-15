import type { AgentConfig, ConversationTurn, TaskState } from "./types.js";
import type { LLMMessage, LLMRequest } from "../ai/types.js";
import { LLMRouter } from "../ai/router.js";
import type { ShortTermMemory } from "../memory/stm.js";
import type { MemoryRetrieval } from "../memory/retrieval.js";
import type { MemoryConsolidator } from "../memory/consolidator.js";
import type { MemoryContext, ConsolidationResult } from "../memory/types.js";
import type { LoadedSkill } from "../skills/types.js";
import { SkillLoader } from "../skills/loader.js";

export class AgentRuntime {
  private config: AgentConfig;
  private llmRouter: LLMRouter;
  private stm: ShortTermMemory;
  private memoryRetrieval: MemoryRetrieval;
  private memoryConsolidator: MemoryConsolidator;
  private skillLoader: SkillLoader;

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
    void this;
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

    const context = this.buildContext(memories, skills, message);

    const request: LLMRequest = {
      model: this.config.model ?? "default",
      messages: context,
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
    };

    const response = await this.llmRouter.chat(request);
    const responseText = response.content;

    const assistantTurn: ConversationTurn = {
      role: "assistant",
      content: responseText,
      timestamp: new Date(),
      metadata: channelId ? { conversationId: channelId } : undefined,
    };
    this.stm.add(assistantTurn);

    const activeTask = this.stm.getActiveTask();
    if (activeTask && activeTask.status === "running" && this.detectTaskEnd(responseText)) {
      activeTask.status = "completed";
      activeTask.result = responseText;
      activeTask.completedAt = new Date();
      this.stm.setActiveTask(activeTask);
    }

    return responseText;
  }

  async *processMessageStream(message: string, channelId?: string): AsyncIterable<string> {
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

    const context = this.buildContext(memories, skills, message);

    const request: LLMRequest = {
      model: this.config.model ?? "default",
      messages: context,
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: true,
    };

    let fullResponse = "";
    for await (const chunk of this.llmRouter.chatStream(request)) {
      if (chunk.content) {
        fullResponse += chunk.content;
        yield chunk.content;
      }
    }

    const assistantTurn: ConversationTurn = {
      role: "assistant",
      content: fullResponse,
      timestamp: new Date(),
      metadata: channelId ? { conversationId: channelId } : undefined,
    };
    this.stm.add(assistantTurn);

    const activeTask = this.stm.getActiveTask();
    if (activeTask && activeTask.status === "running" && this.detectTaskEnd(fullResponse)) {
      activeTask.status = "completed";
      activeTask.result = fullResponse;
      activeTask.completedAt = new Date();
      this.stm.setActiveTask(activeTask);
    }
  }

  private buildContext(
    memories: MemoryContext,
    skills: LoadedSkill[],
    userMessage: string,
  ): LLMMessage[] {
    const messages: LLMMessage[] = [];

    let systemContent = this.config.systemPrompt;
    if (skills.length > 0) {
      const skillInstructions = skills
        .map((s) => s.content)
        .join("\n\n");
      systemContent += `\n\n# Relevant Skills\n${skillInstructions}`;
    }
    messages.push({ role: "system", content: systemContent });

    if (memories.memories.length > 0) {
      const memoryFacts = memories.memories
        .map((m) => m.item.content)
        .join("; ");
      messages.push({
        role: "system",
        content: `Relevant context: ${memoryFacts}`,
      });
    }

    const stmTurns = this.stm.getContext();
    const recentTurns = stmTurns.slice(-20);
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
