import type { ProviderConfig, LLMRequest, LLMResponse, LLMChunk, LLMToolCall, ThinkingBlock } from "../types.js";
import { BaseLLMProvider } from "./base.js";

export interface OpenAICompatibleConfig extends ProviderConfig {
  baseUrl: string;
  authHeader?: string;
  extraHeaders?: Record<string, string>;
  prefix?: string;
}

export class OpenAICompatibleProvider extends BaseLLMProvider {
  protected baseUrl: string;
  protected authHeader: string;
  protected extraHeaders: Record<string, string>;
  protected prefix: string;

  constructor(config: OpenAICompatibleConfig) {
    super(config);
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.authHeader = config.authHeader ?? "Authorization";
    this.extraHeaders = config.extraHeaders ?? {};
    this.prefix = config.prefix ?? "";
  }

  protected mapModel(model: string): string {
    if (this.prefix && model.startsWith(`${this.prefix}/`)) {
      return model.slice(this.prefix.length + 1);
    }
    return model;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.extraHeaders,
    };
    if (this.config.apiKey) {
      if (this.authHeader === "Authorization") {
        headers["Authorization"] = `Bearer ${this.config.apiKey}`;
      } else {
        headers[this.authHeader] = this.config.apiKey;
      }
    }
    return headers;
  }

  private buildMessages(request: LLMRequest) {
    return request.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.toolCalls ? { tool_calls: m.toolCalls } : {}),
      ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
    }));
  }

  protected buildReasoningBody(request: LLMRequest): Record<string, unknown> {
    const reasoning = request.reasoning;
    if (!reasoning || reasoning.effort === "none") return {};

    if (this.prefix === "xai") {
      return { reasoning_effort: reasoning.effort === "low" ? "low" : "high" };
    }

    if (this.prefix === "mistral") {
      return { prompt_mode: "reasoning" };
    }

    return {};
  }

  protected extractReasoningFromResponse(
    message: { content: string | null; reasoning_content?: string | null; [key: string]: unknown },
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; completion_tokens_details?: { reasoning_tokens?: number } } | undefined,
  ): { thinking?: ThinkingBlock[]; reasoningTokens?: number } {
    const result: { thinking?: ThinkingBlock[]; reasoningTokens?: number } = {};

    const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
    if (reasoningTokens) {
      result.reasoningTokens = reasoningTokens;
    }

    if (message.reasoning_content && message.content) {
      result.thinking = [{ type: "thinking", text: message.reasoning_content }];
    }

    return result;
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const model = this.mapModel(request.model);
    const body: Record<string, unknown> = {
      model,
      messages: this.buildMessages(request),
      ...(request.maxTokens != null ? { max_tokens: request.maxTokens } : {}),
      ...(request.temperature != null ? { temperature: request.temperature } : {}),
      ...(request.tools?.length ? { tools: request.tools } : {}),
      ...this.buildReasoningBody(request),
    };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error (${this.prefix || 'openai-compat'}): ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          reasoning_content?: string | null;
          tool_calls?: Array<{
            id: string;
            type: "function";
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
      model: string;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; completion_tokens_details?: { reasoning_tokens?: number } };
    };

    const choice = data.choices[0];
    const toolCalls: LLMToolCall[] | undefined = choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

    const reasoning = this.extractReasoningFromResponse(choice.message, data.usage);
    const content = choice.message.content || choice.message.reasoning_content || "";

    return {
      content,
      model: data.model,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
        ...(reasoning.reasoningTokens ? { reasoningTokens: reasoning.reasoningTokens } : {}),
      },
      ...(toolCalls?.length ? { toolCalls } : {}),
      ...(reasoning.thinking ? { thinking: reasoning.thinking } : {}),
      finishReason: choice.finish_reason ?? "stop",
    };
  }

  async *chatStream(request: LLMRequest): AsyncIterable<LLMChunk> {
    const model = this.mapModel(request.model);
    const body: Record<string, unknown> = {
      model,
      stream: true,
      messages: this.buildMessages(request),
      ...(request.maxTokens != null ? { max_tokens: request.maxTokens } : {}),
      ...(request.temperature != null ? { temperature: request.temperature } : {}),
      ...(request.tools?.length ? { tools: request.tools } : {}),
      ...this.buildReasoningBody(request),
    };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error (${this.prefix || 'openai-compat'}): ${response.status} ${errorText}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const lines = part.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") return;
          try {
            const parsed = JSON.parse(payload) as {
              choices: Array<{
                delta: {
                  content?: string;
                  reasoning_content?: string;
                  tool_calls?: Array<{
                    index: number;
                    id?: string;
                    type?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
                finish_reason: string | null;
              }>;
            };
            const delta = parsed.choices[0];
            if (!delta) continue;
            const chunk: LLMChunk = {};
            if (delta.delta.content) {
              chunk.content = delta.delta.content;
              if (delta.delta.reasoning_content) {
                chunk.thinking = delta.delta.reasoning_content;
              }
            } else if (delta.delta.reasoning_content) {
              chunk.content = delta.delta.reasoning_content;
            }
            if (delta.delta.tool_calls) {
              const tc = delta.delta.tool_calls[0];
              if (tc) {
                chunk.toolCalls = {
                  id: tc.id ?? "",
                  type: (tc.type as "function") ?? undefined,
                  function: {
                    name: tc.function?.name ?? "",
                    arguments: tc.function?.arguments ?? "",
                  },
                };
              }
            }
            if (delta.finish_reason) {
              chunk.finishReason = delta.finish_reason;
            }
            yield chunk;
          } catch {
            continue;
          }
        }
      }
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.config.apiKey && this.prefix !== "local") return false;
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return this.prefix === "local";
    }
  }
}
