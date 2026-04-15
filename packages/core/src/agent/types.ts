export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  tools?: string[];
  channels?: string[];
  maxTokens?: number;
  temperature?: number;
}

export interface TaskState {
  id: string;
  description: string;
  status: "pending" | "running" | "completed" | "failed";
  result?: string;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export interface ConversationTurn {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface TaskDescription {
  description: string;
  complexity: number;
  domains: string[];
  keywords: string[];
}

export interface TaskResult {
  summary: string;
  whatWorked: string;
  whatCouldImprove: string;
  patterns: string[];
}

export interface AgentMessage {
  from: string;
  to: string;
  type: "task" | "result" | "query" | "broadcast";
  content: string;
  timestamp: Date;
}
