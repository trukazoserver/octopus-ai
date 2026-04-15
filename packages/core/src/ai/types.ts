export type LLMProvider =
  | "openai"
  | "anthropic"
  | "google"
  | "zhipu"
  | "openrouter"
  | "deepseek"
  | "mistral"
  | "xai"
  | "cohere"
  | "local";

export interface LLMTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: LLMToolCall[];
}

export type ReasoningEffort = "none" | "low" | "medium" | "high";

export interface ReasoningConfig {
  effort: ReasoningEffort;
  budgetTokens?: number;
  includeThinking?: boolean;
}

export interface ThinkingBlock {
  type: "thinking";
  text: string;
  signature?: string;
}

export interface LLMRequest {
  model: string;
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: LLMTool[];
  reasoning?: ReasoningConfig;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
  };
  toolCalls?: LLMToolCall[];
  thinking?: ThinkingBlock[];
  finishReason: string;
}

export interface LLMChunk {
  content?: string;
  thinking?: string;
  toolCalls?: Partial<LLMToolCall>;
  finishReason?: string;
  usage?: LLMResponse["usage"];
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
}

export interface UsageStats {
  totalTokens: number;
  totalCost: number;
  byProvider: Record<
    string,
    {
      tokens: number;
      cost: number;
      requests: number;
    }
  >;
}

export interface LLMRouterConfig {
  default: string;
  fallback?: string;
  providers: Record<string, ProviderConfig>;
  thinking?: ReasoningEffort;
}

export interface ProviderInfo {
  name: string;
  displayName: string;
  baseUrl: string;
  authMethod: "bearer" | "x-api-key" | "query-param" | "none";
  authHeader?: string;
  extraHeaders?: Record<string, string>;
  openAICompatible: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  supportsReasoning: boolean;
  defaultModels: string[];
  hasOAuth: boolean;
  hasCodingPlan: boolean;
  hasFreeTier: boolean;
}
